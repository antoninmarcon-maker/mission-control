#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LeaseStore, resolveExternalStateDirectory } from "./lease-store.mjs";
import {
  MissionControlClient,
  MissionControlRequestError,
} from "./mc-client.mjs";
import { OllamaClient } from "./ollama-client.mjs";
import { evaluateTask, validateLoopbackHttpUrl } from "./policy-core.mjs";
import { ReceiptLedger } from "./receipt-ledger.mjs";

const DEFAULT_AGENT = "antonin-policy-engine";
const DEFAULT_REVIEWER = "poc-aegis-cloud";
const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_MODEL = "qwen2.5-coder:7b";
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_NETWORK_TIMEOUT_MS = 120_000;
const NETWORK_LEASE_MARGIN_MS = 1_000;
const MAX_ERROR_LENGTH = 320;
const COMPLETION_JOURNAL_VERSION = 1;
const COMPLETION_METADATA_FIELDS = [
  "completion_id",
  "input_hash",
  "output_hash",
  "policy_version",
];
const STABLE_RECEIPT_FIELDS = [
  "task_id",
  "policy_version",
  "route",
  "reviewer",
  "input_hash",
  "output_hash",
  "outcome",
];

class CompletionPendingError extends Error {
  constructor(error) {
    super(`completion pending reconciliation: ${error?.message ?? "unknown failure"}`);
    this.name = "CompletionPendingError";
  }
}

class TokenReconciliationRequiredError extends Error {
  constructor(sessionId) {
    super(
      `token accounting requires manual reconciliation for session ${sessionId}`,
    );
    this.name = "TokenReconciliationRequiredError";
  }
}

class CompletionContendedError extends Error {
  constructor(completionId) {
    super(`completion ${completionId} is already claimed by a live invocation`);
    this.name = "CompletionContendedError";
  }
}

class CompletionJournal {
  constructor(stateDirectory, options = {}) {
    this.filePath = path.join(stateDirectory, "completions.json");
    this.lockPath = path.join(stateDirectory, ".completions.lock");
    this.stateDirectory = stateDirectory;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.lockRetryMs = options.lockRetryMs ?? 10;
    this.lockMaxAttempts = options.lockMaxAttempts ?? 50;
  }

  async firstPending(owner) {
    const state = await this.#readState();
    return (
      Object.values(state.entries)
        .filter(
          (entry) =>
            entry.owner === owner && entry.phases?.receipt_confirmed !== true,
        )
        .sort((left, right) => left.created_at - right.created_at)[0] ?? null
    );
  }

  async begin(entry) {
    return this.#withLock(async () => {
      const state = await this.#readState();
      const existing = state.entries[entry.completion_id];
      if (existing) return existing;
      const conflicting = Object.values(state.entries).find(
        (candidate) =>
          candidate.task_id === entry.task_id &&
          candidate.fencing_token === entry.fencing_token &&
          candidate.phases?.receipt_confirmed !== true,
      );
      if (conflicting) {
        throw new Error(
          `completion journal already has a pending entry for task ${entry.task_id}`,
        );
      }
      state.entries[entry.completion_id] = entry;
      await this.#writeState(state);
      return entry;
    });
  }

  async get(completionId) {
    const state = await this.#readState();
    return state.entries[completionId] ?? null;
  }

  async markConfirmed(completionId, phase, details = {}) {
    const phaseField = `${phase}_confirmed`;
    if (!new Set(["token_confirmed", "task_confirmed", "receipt_confirmed"]).has(phaseField)) {
      throw new TypeError(`unsupported completion phase: ${phase}`);
    }
    return this.#withLock(async () => {
      const state = await this.#readState();
      const entry = state.entries[completionId];
      if (!entry) {
        throw new Error(`completion journal entry not found: ${completionId}`);
      }
      entry.phases[phaseField] = true;
      entry.updated_at = this.now();
      if (phase === "task") {
        entry.task_update.resolution = null;
      }
      if (phase === "receipt" && details.recordHash) {
        entry.receipt_hash = details.recordHash;
      }
      await this.#writeState(state);
      return entry;
    });
  }

  async claimTokenAttempt(completionId) {
    return this.#withLock(async () => {
      const state = await this.#readState();
      const entry = state.entries[completionId];
      if (!entry) {
        throw new Error(`completion journal entry not found: ${completionId}`);
      }
      if (entry.token_attempted) {
        return { claimed: false, entry };
      }
      entry.token_attempted = true;
      entry.updated_at = this.now();
      await this.#writeState(state);
      return { claimed: true, entry };
    });
  }

  async markTokenAmbiguous(completionId) {
    return this.#updateEntry(completionId, (entry) => {
      entry.token_attempted = true;
      entry.token_ambiguous = true;
    });
  }

  async adoptLease(completionId, lease, existingReceiptHash = null) {
    return this.#updateEntry(completionId, (entry) => {
      entry.fencing_token = lease.fencing_token;
      if (existingReceiptHash === null) {
        entry.receipt.fencing_token = lease.fencing_token;
        entry.receipt.lease_id = `${entry.task_id}:${lease.fencing_token}`;
      } else {
        entry.phases.receipt_confirmed = true;
        entry.receipt_hash = existingReceiptHash;
      }
    });
  }

  async #updateEntry(completionId, operation) {
    return this.#withLock(async () => {
      const state = await this.#readState();
      const entry = state.entries[completionId];
      if (!entry) {
        throw new Error(`completion journal entry not found: ${completionId}`);
      }
      operation(entry);
      entry.updated_at = this.now();
      await this.#writeState(state);
      return entry;
    });
  }

  async #withLock(operation) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 1; attempt <= this.lockMaxAttempts; attempt += 1) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (attempt === this.lockMaxAttempts) {
          throw new Error("completion journal lock is unavailable");
        }
        await this.sleep(this.lockRetryMs);
      }
    }
    if (!acquired) throw new Error("completion journal lock is unavailable");
    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async #readState() {
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf8"));
      if (
        state?.version !== COMPLETION_JOURNAL_VERSION ||
        state.entries === null ||
        typeof state.entries !== "object" ||
        Array.isArray(state.entries)
      ) {
        throw new Error("invalid completion journal");
      }
      return state;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { version: COMPLETION_JOURNAL_VERSION, entries: {} };
      }
      throw error;
    }
  }

  async #writeState(state) {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, name) {
  const number = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

function safeErrorMessage(error, secret = "") {
  const original =
    typeof error?.message === "string" ? error.message : "unknown failure";
  const redacted =
    secret === "" ? original : original.split(secret).join("[REDACTED]");
  if (redacted.length <= MAX_ERROR_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

function isStaleLeaseError(error) {
  return /lease is not current for task/.test(String(error?.message ?? ""));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function taskVersion(task) {
  return Number.isSafeInteger(task?.version) && task.version >= 0
    ? task.version
    : null;
}

function taskIdentifier(task) {
  const taskId = String(task?.id ?? "").trim();
  if (taskId === "") {
    throw new Error("Mission Control queue task is missing an id");
  }
  return taskId;
}

function localPrompt(task) {
  return [
    "Complete this harmless mechanical task locally.",
    "Return a text-only response.",
    "Use no filesystem, network, Git, deployment, shell, or external side effects.",
    "Do not claim that you performed actions; transform only the supplied text.",
    "",
    `Task title: ${String(task?.title ?? "")}`,
    `Task description: ${String(task?.description ?? "")}`,
  ].join("\n");
}

function receiptInput({
  task,
  decision,
  lease,
  prompt,
  completion,
  outcome,
}) {
  return {
    task_id: String(task.id),
    task_version: taskVersion(task),
    policy_version: decision.policyVersion,
    route: decision.route,
    reviewer: decision.reviewer,
    lease_id: `${String(task.id)}:${lease.fencing_token}`,
    fencing_token: lease.fencing_token,
    input_hash: sha256(prompt),
    output_hash: sha256(completion?.text ?? ""),
    token_usage: {
      input: completion?.inputTokens ?? 0,
      output: completion?.outputTokens ?? 0,
    },
    outcome,
  };
}

function completionEntry({ task, decision, lease, prompt, completion, duration, owner, model, now }) {
  const receipt = receiptInput({
    task,
    decision,
    lease,
    prompt,
    completion,
    outcome: "success",
  });
  const completionId = sha256(
    [
      String(task.id),
      receipt.input_hash,
      receipt.output_hash,
    ].join("\0"),
  );
  const tokenSessionId = `${owner}:policy-mvp:completion-${completionId}`;
  const taskMetadata =
    task.metadata !== null &&
    typeof task.metadata === "object" &&
    !Array.isArray(task.metadata)
      ? task.metadata
      : {};
  const policyMetadata =
    taskMetadata.policy_mvp !== null &&
    typeof taskMetadata.policy_mvp === "object" &&
    !Array.isArray(taskMetadata.policy_mvp)
      ? taskMetadata.policy_mvp
      : {};
  return {
    completion_id: completionId,
    task_id: String(task.id),
    task_api_id: task.id,
    owner,
    fencing_token: lease.fencing_token,
    token_session_id: tokenSessionId,
    token_record: {
      model,
      sessionId: tokenSessionId,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      operation: "policy_mvp",
      duration,
      taskId: task.id,
    },
    task_update: {
      status: "review",
      assigned_to: decision.reviewer,
      resolution: completion.text,
      metadata: {
        ...taskMetadata,
        policy_mvp: {
          ...policyMetadata,
          completion_id: completionId,
          input_hash: receipt.input_hash,
          output_hash: receipt.output_hash,
          policy_version: decision.policyVersion,
        },
      },
      error_message: "",
    },
    receipt,
    phases: {
      token_confirmed: false,
      task_confirmed: false,
      receipt_confirmed: false,
    },
    token_attempted: false,
    token_ambiguous: false,
    receipt_hash: null,
    created_at: now,
    updated_at: now,
  };
}

function taskConfirmsCompletion(task, entry) {
  const expectedPolicyMetadata = entry.task_update.metadata?.policy_mvp;
  const actualPolicyMetadata = task?.metadata?.policy_mvp;
  return (
    task?.status === entry.task_update.status &&
    task?.assigned_to === entry.task_update.assigned_to &&
    task?.resolution === entry.task_update.resolution &&
    expectedPolicyMetadata !== undefined &&
    actualPolicyMetadata !== null &&
    typeof actualPolicyMetadata === "object" &&
    !Array.isArray(actualPolicyMetadata) &&
    COMPLETION_METADATA_FIELDS.every(
      (field) => actualPolicyMetadata[field] === expectedPolicyMetadata[field],
    )
  );
}

function taskUpdateWithFreshMetadata(entry, task) {
  const freshMetadata =
    task?.metadata !== null &&
    typeof task?.metadata === "object" &&
    !Array.isArray(task.metadata)
      ? task.metadata
      : {};
  const freshPolicyMetadata =
    freshMetadata.policy_mvp !== null &&
    typeof freshMetadata.policy_mvp === "object" &&
    !Array.isArray(freshMetadata.policy_mvp)
      ? freshMetadata.policy_mvp
      : {};
  const completionMetadata = entry.task_update.metadata.policy_mvp;
  return {
    ...entry.task_update,
    metadata: {
      ...freshMetadata,
      policy_mvp: {
        ...freshPolicyMetadata,
        ...Object.fromEntries(
          COMPLETION_METADATA_FIELDS.map((field) => [
            field,
            completionMetadata[field],
          ]),
        ),
      },
    },
  };
}

async function receiptAlreadyStored(receiptLedger, expectedReceipt) {
  await receiptLedger.verify();
  let contents;
  try {
    contents = await readFile(receiptLedger.filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  for (const line of contents.split("\n")) {
    if (line === "") continue;
    const record = JSON.parse(line);
    if (STABLE_RECEIPT_FIELDS.every(
      (field) => record[field] === expectedReceipt[field],
    )) {
      return record;
    }
  }
  return null;
}

function contendedResult(completionId, taskApiId) {
  return {
    outcome: "contended",
    processed: 0,
    taskId: taskApiId,
    completionId,
  };
}

// A completion whose receipt phase is confirmed is durably finished. Reaching a
// failure after that point means a concurrent invocation committed the same
// completion first, which is contention rather than an incident.
async function settledByPeer(completionJournal, completionId) {
  try {
    const stored = await completionJournal.get(completionId);
    return stored?.phases?.receipt_confirmed === true;
  } catch {
    return false;
  }
}

function withLocalCompletionGuard(leaseStore, entry, operation) {
  return leaseStore.withCompletionGuard(
    entry.task_id,
    entry.owner,
    entry.fencing_token,
    operation,
  );
}

function renewForNetwork(leaseStore, entry, recoveryLeaseTtlMs) {
  return leaseStore.renew(
    entry.task_id,
    entry.owner,
    entry.fencing_token,
    recoveryLeaseTtlMs,
  );
}

async function markTokenAmbiguous(completionJournal, leaseStore, entry) {
  return withLocalCompletionGuard(leaseStore, entry, () =>
    completionJournal.markTokenAmbiguous(entry.completion_id),
  );
}

async function reconcileCompletion({
  entry,
  completionJournal,
  leaseStore,
  receiptLedger,
  missionControl,
  recoveryLeaseTtlMs,
}) {
  let current = await withLocalCompletionGuard(leaseStore, entry, () =>
    completionJournal.begin(entry),
  );

  if (!current.phases.token_confirmed) {
    await renewForNetwork(leaseStore, current, recoveryLeaseTtlMs);
    let existingToken = await missionControl.findTokenRecord(
      current.token_session_id,
    );

    if (existingToken === null && current.token_attempted) {
      if (!current.token_ambiguous) {
        current = await markTokenAmbiguous(
          completionJournal,
          leaseStore,
          current,
        );
      }
      throw new TokenReconciliationRequiredError(current.token_session_id);
    }

    if (existingToken === null) {
      await renewForNetwork(leaseStore, current, recoveryLeaseTtlMs);
      const tokenAttempt = await withLocalCompletionGuard(
        leaseStore,
        current,
        () => completionJournal.claimTokenAttempt(current.completion_id),
      );
      current = tokenAttempt.entry;
      if (!tokenAttempt.claimed) {
        // Reaching the compare-and-set means this invocation observed neither a
        // token record nor an earlier attempt, so a lost claim can only come
        // from a concurrent live claimant. This invocation never posted, so it
        // must not persist an ambiguity it did not create nor mutate a
        // completion another invocation is committing: it yields. A genuinely
        // unaccounted attempt is still detected by the `token_attempted` check
        // above on the next invocation.
        throw new CompletionContendedError(current.completion_id);
      }
      try {
        await missionControl.recordTokens(current.token_record);
      } catch (error) {
        if (
          error instanceof MissionControlRequestError &&
          error.ambiguous === false
        ) {
          throw error;
        }
        try {
          await renewForNetwork(leaseStore, current, recoveryLeaseTtlMs);
          existingToken = await missionControl.findTokenRecord(
            current.token_session_id,
          );
        } catch (readbackError) {
          if (isStaleLeaseError(readbackError)) throw readbackError;
          await markTokenAmbiguous(completionJournal, leaseStore, current);
          throw new TokenReconciliationRequiredError(current.token_session_id);
        }
        if (existingToken === null) {
          await markTokenAmbiguous(completionJournal, leaseStore, current);
          throw new TokenReconciliationRequiredError(current.token_session_id);
        }
      }
    }

    current = await withLocalCompletionGuard(leaseStore, current, () =>
      completionJournal.markConfirmed(current.completion_id, "token"),
    );
  }

  if (!current.phases.task_confirmed) {
    let task;
    await renewForNetwork(leaseStore, current, recoveryLeaseTtlMs);
    task = await missionControl.getTask(current.task_api_id);
    if (!taskConfirmsCompletion(task, current)) {
      await renewForNetwork(leaseStore, current, recoveryLeaseTtlMs);
      const taskUpdate = taskUpdateWithFreshMetadata(current, task);
      try {
        const response = await missionControl.updateTask(
          current.task_api_id,
          taskUpdate,
        );
        task = response.task;
      } catch (error) {
        await renewForNetwork(leaseStore, current, recoveryLeaseTtlMs);
        try {
          task = await missionControl.getTask(current.task_api_id);
        } catch {
          throw error;
        }
        if (!taskConfirmsCompletion(task, current)) throw error;
      }
    }
    if (!taskConfirmsCompletion(task, current)) {
      throw new Error("Mission Control did not confirm the exact completion");
    }
    current = await withLocalCompletionGuard(leaseStore, current, () =>
      completionJournal.markConfirmed(current.completion_id, "task"),
    );
  }

  if (!current.phases.receipt_confirmed) {
    current = await withLocalCompletionGuard(leaseStore, current, async () => {
      let storedReceipt = await receiptAlreadyStored(
        receiptLedger,
        current.receipt,
      );
      if (storedReceipt === null) {
        try {
          storedReceipt = await receiptLedger.append(current.receipt);
        } catch (error) {
          try {
            storedReceipt = await receiptAlreadyStored(
              receiptLedger,
              current.receipt,
            );
          } catch {
            throw error;
          }
          if (storedReceipt === null) throw error;
        }
      }
      return completionJournal.markConfirmed(current.completion_id, "receipt", {
        recordHash: storedReceipt.record_hash,
      });
    });
  }
  return current;
}

function validateProcessConfig(config = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("config must be an object");
  }
  const stateStoreOptions = config.stateStoreOptions ?? {};
  if (
    stateStoreOptions === null ||
    typeof stateStoreOptions !== "object" ||
    Array.isArray(stateStoreOptions)
  ) {
    throw new TypeError("stateStoreOptions must be an object");
  }
  const stateDirectory = resolveExternalStateDirectory(
    config.stateDirectory,
    stateStoreOptions,
  );
  const pocRuntimeDirectory =
    typeof config.pocRuntimeDirectory === "string" &&
    config.pocRuntimeDirectory.trim() !== ""
      ? config.pocRuntimeDirectory
      : null;
  if (pocRuntimeDirectory !== null) {
    resolveExternalStateDirectory(config.stateDirectory, {
      ...stateStoreOptions,
      runtimeDirectory: pocRuntimeDirectory,
    });
  }
  const mcUrl = validateLoopbackHttpUrl(config.mcUrl, "MC_URL").href.replace(
    /\/$/,
    "",
  );
  const localEndpoint = validateLoopbackHttpUrl(
    config.localEndpoint,
    "LOCAL_LLM_ENDPOINT",
  ).href.replace(/\/$/, "");
  const mcApiKey = requireNonEmptyString(config.mcApiKey, "MC_API_KEY");
  const agent = requireNonEmptyString(config.agent, "ANTONIN_POLICY_AGENT");
  const reviewer = requireNonEmptyString(
    config.reviewer,
    "ANTONIN_CLOUD_REVIEWER",
  );
  const localModel = requireNonEmptyString(
    config.localModel,
    "LOCAL_LLM_MODEL",
  );
  const leaseTtlMs = positiveInteger(
    config.leaseTtlMs,
    "ANTONIN_LEASE_TTL_MS",
  );
  if (reviewer.toLowerCase() === agent.toLowerCase()) {
    throw new TypeError("reviewer must be distinct from the policy agent");
  }
  if (
    reviewer.toLowerCase() === localModel.toLowerCase() ||
    reviewer.toLowerCase() === `ollama/${localModel}`.toLowerCase()
  ) {
    throw new TypeError("reviewer must be distinct from the local model");
  }

  return {
    stateDirectory,
    stateStoreOptions,
    mcUrl,
    mcApiKey,
    agent,
    reviewer,
    localEndpoint,
    localModel,
    leaseTtlMs,
    pocRuntimeDirectory,
  };
}

export function configFromEnvironment(environment = process.env) {
  const missionControlRuntime =
    typeof environment.MISSION_CONTROL_DATA_DIR === "string" &&
    environment.MISSION_CONTROL_DATA_DIR.trim() !== ""
      ? environment.MISSION_CONTROL_DATA_DIR
      : null;
  return validateProcessConfig({
    stateDirectory: environment.ANTONIN_POLICY_STATE_DIR,
    stateStoreOptions:
      missionControlRuntime === null
        ? {}
        : { runtimeDirectory: missionControlRuntime },
    pocRuntimeDirectory: environment.MC_POC_STATE_DIR,
    mcUrl: environment.MC_URL,
    mcApiKey: environment.MC_API_KEY,
    agent: environment.ANTONIN_POLICY_AGENT ?? DEFAULT_AGENT,
    reviewer: environment.ANTONIN_CLOUD_REVIEWER ?? DEFAULT_REVIEWER,
    localEndpoint: environment.LOCAL_LLM_ENDPOINT ?? DEFAULT_LOCAL_ENDPOINT,
    localModel: environment.LOCAL_LLM_MODEL ?? DEFAULT_LOCAL_MODEL,
    leaseTtlMs:
      environment.ANTONIN_LEASE_TTL_MS ?? DEFAULT_LEASE_TTL_MS,
  });
}

async function moveToAwaitingOwner(missionControl, taskId, errorMessage) {
  await missionControl.updateTask(taskId, {
    status: "awaiting_owner",
    error_message: errorMessage,
  });
}

async function releaseLeaseForCleanup(leaseStore, taskId, owner, fencingToken) {
  try {
    const released = await leaseStore.release(taskId, owner, fencingToken);
    return released
      ? null
      : `lease cleanup did not release task ${String(taskId)}`;
  } catch (error) {
    return `lease cleanup warning: ${safeErrorMessage(error)}`;
  }
}

function recoveryLeaseTtl(configuredTtlMs, missionControl, ollama, override) {
  const timeoutMs =
    override ??
    Math.max(
      missionControl.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
      ollama.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
    );
  return Math.max(configuredTtlMs, timeoutMs + NETWORK_LEASE_MARGIN_MS);
}

async function adoptPendingCompletion({
  entry,
  completionJournal,
  leaseStore,
  receiptLedger,
  recoveryLeaseTtlMs,
}) {
  const lease = await leaseStore.acquire(entry.task_id, entry.owner, {
    ttlMs: recoveryLeaseTtlMs,
    taskVersion: entry.receipt.task_version,
  });
  if (lease === null) {
    throw new Error(`lease is unavailable for task ${entry.task_id}`);
  }
  if (lease.fencing_token === entry.fencing_token) {
    return entry;
  }
  const storedReceipt = entry.phases.receipt_confirmed
    ? null
    : await receiptAlreadyStored(receiptLedger, entry.receipt);
  const rebound = { ...entry, fencing_token: lease.fencing_token };
  return withLocalCompletionGuard(leaseStore, rebound, () =>
    completionJournal.adoptLease(
      entry.completion_id,
      lease,
      storedReceipt?.record_hash ?? null,
    ),
  );
}

async function recoverExecutionFailure({
  task,
  taskId,
  decision,
  lease,
  prompt,
  completion,
  leaseStore,
  receiptLedger,
  missionControl,
  owner,
  recoveryLeaseTtlMs,
}) {
  const leaseEntry = {
    task_id: taskId,
    owner,
    fencing_token: lease.fencing_token,
  };
  await renewForNetwork(leaseStore, leaseEntry, recoveryLeaseTtlMs);
  try {
    await withLocalCompletionGuard(leaseStore, leaseEntry, () =>
      receiptLedger.append(
        receiptInput({
          task,
          decision,
          lease,
          prompt,
          completion,
          outcome: "failure",
        }),
      ),
    );
  } catch (error) {
    if (isStaleLeaseError(error)) throw error;
    // Failure receipts remain best-effort when the local ledger itself is broken.
  }

  await renewForNetwork(leaseStore, leaseEntry, recoveryLeaseTtlMs);
  try {
    await moveToAwaitingOwner(
      missionControl,
      task.id,
      "External policy execution failed; owner review required",
    );
  } catch {
    // Preserve the original execution error after the bounded recovery attempt.
  }
  try {
    await leaseStore.release(taskId, owner, lease.fencing_token);
  } catch {
    // Preserve the original execution error after matching-token cleanup.
  }
}

export async function processOne(config, dependencies = {}) {
  const normalized = validateProcessConfig(config);
  const missionControl =
    dependencies.missionControl ??
    new MissionControlClient({
      baseUrl: normalized.mcUrl,
      apiKey: normalized.mcApiKey,
    });
  const ollama =
    dependencies.ollama ??
    new OllamaClient({
      endpoint: normalized.localEndpoint,
      model: normalized.localModel,
    });
  const leaseStore =
    dependencies.leaseStore ??
    new LeaseStore(
      normalized.stateDirectory,
      normalized.stateStoreOptions,
    );
  const receiptLedger =
    dependencies.receiptLedger ??
    new ReceiptLedger(
      normalized.stateDirectory,
      normalized.stateStoreOptions,
    );
  const now = dependencies.now ?? Date.now;
  const completionJournal =
    dependencies.completionJournal ??
    new CompletionJournal(normalized.stateDirectory, { now });
  const recoveryLeaseTtlMs = recoveryLeaseTtl(
    normalized.leaseTtlMs,
    missionControl,
    ollama,
    dependencies.networkTimeoutMs,
  );

  let pendingCompletion = await completionJournal.firstPending(
    normalized.agent,
  );
  if (pendingCompletion) {
    let reconciled;
    try {
      pendingCompletion = await adoptPendingCompletion({
        entry: pendingCompletion,
        completionJournal,
        leaseStore,
        receiptLedger,
        recoveryLeaseTtlMs,
      });
      reconciled = await reconcileCompletion({
        entry: pendingCompletion,
        completionJournal,
        leaseStore,
        receiptLedger,
        missionControl,
        recoveryLeaseTtlMs,
      });
    } catch (error) {
      if (
        error instanceof CompletionContendedError ||
        (await settledByPeer(completionJournal, pendingCompletion.completion_id))
      ) {
        return contendedResult(
          pendingCompletion.completion_id,
          pendingCompletion.task_api_id,
        );
      }
      throw new CompletionPendingError(error);
    }
    const cleanupWarning = await releaseLeaseForCleanup(
      leaseStore,
      reconciled.task_id,
      reconciled.owner,
      reconciled.fencing_token,
    );
    return {
      outcome: "review",
      processed: 1,
      taskId: reconciled.task_api_id,
      reviewer: reconciled.task_update.assigned_to,
      receiptHash: reconciled.receipt_hash,
      reconciled: true,
      ...(cleanupWarning ? { cleanupWarning } : {}),
    };
  }

  const task = await missionControl.claimOne(normalized.agent);
  if (task === null) {
    return { outcome: "no_task", processed: 0 };
  }

  const taskId = taskIdentifier(task);
  const decision = evaluateTask(task, {
    localModel: normalized.localModel,
    reviewer: normalized.reviewer,
  });
  if (decision.status !== "execute_local") {
    await moveToAwaitingOwner(
      missionControl,
      task.id,
      `Policy ${decision.policyVersion} requires owner: ${decision.reasonCode}`,
    );
    return {
      outcome: "awaiting_owner",
      processed: 1,
      taskId: task.id,
      reasonCode: decision.reasonCode,
    };
  }

  const lease = await leaseStore.acquire(taskId, normalized.agent, {
    ttlMs: normalized.leaseTtlMs,
    taskVersion: taskVersion(task),
  });
  if (lease === null) {
    throw new Error(`lease is unavailable for task ${taskId}`);
  }

  const prompt = localPrompt(task);
  let completion = null;
  let duration = 0;
  let completedResult;
  try {
    await leaseStore.renew(
      taskId,
      normalized.agent,
      lease.fencing_token,
      recoveryLeaseTtlMs,
    );
    const startedAt = now();
    completion = await ollama.complete(prompt);
    duration = Math.max(0, now() - startedAt);
    if (completion.text.length > 5_000) {
      throw new Error("Ollama response exceeds the task resolution limit");
    }

    const entry = completionEntry({
      task,
      decision,
      lease,
      prompt,
      completion,
      duration,
      owner: normalized.agent,
      model: normalized.localModel,
      now: now(),
    });
    let reconciled;
    try {
      reconciled = await reconcileCompletion({
        entry,
        completionJournal,
        leaseStore,
        receiptLedger,
        missionControl,
        recoveryLeaseTtlMs,
      });
    } catch (error) {
      if (
        error instanceof CompletionContendedError ||
        (await settledByPeer(completionJournal, entry.completion_id))
      ) {
        return contendedResult(entry.completion_id, task.id);
      }
      if (await completionJournal.get(entry.completion_id)) {
        throw new CompletionPendingError(error);
      }
      throw error;
    }

    completedResult = {
      outcome: "review",
      processed: 1,
      taskId: task.id,
      reviewer: decision.reviewer,
      receiptHash: reconciled.receipt_hash,
    };
  } catch (error) {
    if (error instanceof CompletionPendingError) {
      throw new Error(safeErrorMessage(error, normalized.mcApiKey));
    }
    if (isStaleLeaseError(error)) {
      throw new Error(safeErrorMessage(error, normalized.mcApiKey));
    }
    try {
      await recoverExecutionFailure({
        task,
        taskId,
        decision,
        lease,
        prompt,
        completion,
        leaseStore,
        receiptLedger,
        missionControl,
        owner: normalized.agent,
        recoveryLeaseTtlMs,
      });
    } catch (recoveryError) {
      if (isStaleLeaseError(recoveryError)) {
        throw new Error(
          safeErrorMessage(recoveryError, normalized.mcApiKey),
        );
      }
    }
    throw new Error(safeErrorMessage(error, normalized.mcApiKey));
  }

  const cleanupWarning = await releaseLeaseForCleanup(
    leaseStore,
    taskId,
    normalized.agent,
    lease.fencing_token,
  );
  return {
    ...completedResult,
    ...(cleanupWarning ? { cleanupWarning } : {}),
  };
}

export async function runCommand(command, environment = process.env) {
  const config = configFromEnvironment(environment);
  if (command === "status") {
    return {
      command,
      stateDirectory: config.stateDirectory,
      leaseFile: path.join(config.stateDirectory, "leases.json"),
      receiptLedgerFile: path.join(config.stateDirectory, "receipts.jsonl"),
      mcUrl: config.mcUrl,
      agent: config.agent,
      reviewer: config.reviewer,
      localEndpoint: config.localEndpoint,
      localModel: config.localModel,
      leaseTtlMs: config.leaseTtlMs,
      apiKeyConfigured: true,
    };
  }
  if (command === "verify-ledger") {
    const result = await new ReceiptLedger(
      config.stateDirectory,
      config.stateStoreOptions,
    ).verify();
    return { command, ...result };
  }
  if (command === "process") {
    return { command, ...(await processOne(config)) };
  }
  throw new Error("usage: run-once.mjs process|status|verify-ledger");
}

async function main() {
  try {
    const result = await runCommand(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: safeErrorMessage(error, process.env.MC_API_KEY ?? "") })}\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
