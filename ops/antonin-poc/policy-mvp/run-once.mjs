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
import {
  FAILURE_KINDS,
  buildRouteLadder,
  classifyFailure,
  completionIdentityFields,
  evaluateTask,
  isFallbackEligible,
  percentile90,
  resolveNextAttempt,
  validateLoopbackHttpUrl,
} from "./policy-core.mjs";
import { CloudSubprocessRunner } from "./cloud-runner.mjs";
import {
  CLOUD_PROVIDERS,
  CLOUD_RUNNER_DEFAULTS,
  DEFAULT_LOCAL_LADDER_MODELS,
  OWNER_DECISIONS_TAKEN,
  OWNER_DECISION_PLACEHOLDERS,
  PROVIDER_PLANS,
  parseRoute,
  planKey,
  resolveQuotaPolicy,
} from "./quota-config.mjs";
import { QuotaStore } from "./quota-store.mjs";
import { ReceiptLedger } from "./receipt-ledger.mjs";

const DEFAULT_AGENT = "antonin-policy-engine";
const DEFAULT_REVIEWER = "poc-aegis-cloud";
const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_MODEL = "qwen2.5-coder:7b";
const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_CLOUD_TIMEOUT_MS = 180_000;
const CLOUD_RUNNER_WORKING_DIRECTORY = "runner-cwd";
const ATTEMPT_LOG_LIMIT = 5;
const MAX_RESOLUTION_LENGTH = 5_000;
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

/**
 * Raised when an invocation ends outside the execution path — planning failed,
 * or the deferral/owner hand-off failed — *after* the lease has already been
 * handed back. The message is preserved verbatim so an operator sees the real
 * cause (a corrupt `quotas.json`, a refused PUT) rather than a wrapper; the
 * class only tells the caller that the failure-recovery path must not run
 * again on a lease this invocation no longer holds.
 */
class AttemptHandoffError extends Error {
  constructor(error) {
    super(error?.message ?? "unknown failure");
    this.name = "AttemptHandoffError";
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
  attempt,
}) {
  return {
    task_id: String(task.id),
    task_version: taskVersion(task),
    policy_version: decision.policyVersion,
    route: attempt.route,
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
    // §4.7 the three v1 scalars: which attempt produced this, the ladder rungs
    // it climbed, and the quota snapshot the decision was taken on.
    attempt: attempt.number,
    route_chain: attempt.routeChain,
    quota_snapshot_hash: attempt.quotaSnapshotHash,
  };
}

function completionEntry({
  task,
  decision,
  lease,
  prompt,
  completion,
  duration,
  owner,
  model,
  now,
  attempt,
}) {
  const receipt = receiptInput({
    task,
    decision,
    lease,
    prompt,
    completion,
    outcome: "success",
    attempt,
  });
  const completionId = sha256(
    completionIdentityFields({
      policyVersion: receipt.policy_version,
      taskId: String(task.id),
      route: receipt.route,
      inputHash: receipt.input_hash,
      outputHash: receipt.output_hash,
    }).join("\0"),
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

/**
 * §4.7 `route_chain` is bounded to 512 characters by the receipt validator, so
 * it is built from the most recent rungs that fit. Truncating here rather than
 * failing keeps a long history from breaking a completion that already
 * happened — and the chain is a summary, with the attempt log carrying the
 * detail.
 */
function buildRouteChain(routes, limit = 512) {
  const kept = [];
  for (const route of [...routes].reverse()) {
    const candidate = [route, ...kept].join(">");
    if (candidate.length > limit) break;
    kept.unshift(route);
  }
  return kept.length === 0 ? routes.at(-1).slice(0, limit) : kept.join(">");
}

function routeModelName(route) {
  const parsed = parseRoute(route);
  return parsed?.provider === "ollama" ? parsed.detail : route;
}

/**
 * The local resolution cap applies to every rung. The message names the
 * provider whose answer was too long, and `failureKind` is declared only for a
 * local rung: §3 has no cloud output kind, so an oversized cloud answer stays
 * `unknown` and fails closed to the owner.
 */
function resolutionLimitError(provider) {
  if (provider === "ollama") {
    return new Error("Ollama response exceeds the task resolution limit");
  }
  const error = new Error(
    `${provider} response exceeds the task resolution limit`,
  );
  error.provider = provider;
  return error;
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

function normalizeReviewerProvider(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    // §7 leaves reviewer routing open: with no declared provider the reviewer
    // is an ordinary Mission Control agent and this engine tracks no window
    // for it. Declaring one turns on the §4.4 reviewer capacity check.
    return null;
  }
  const provider = String(value).trim();
  if (!CLOUD_PROVIDERS.includes(provider)) {
    throw new TypeError(
      `ANTONIN_REVIEWER_PROVIDER must be one of ${CLOUD_PROVIDERS.join(", ")}`,
    );
  }
  return provider;
}

function reviewerRouteOf(normalized) {
  return normalized.reviewerProvider === null
    ? `external/${normalized.reviewer}`
    : `${normalized.reviewerProvider}/${PROVIDER_PLANS[normalized.reviewerProvider]}`;
}

async function estimateRouteCost(receiptLedger, route) {
  try {
    return percentile90(await receiptLedger.recentSuccessCosts(route));
  } catch {
    // §2.7 the estimator is a routing hint built from evidence we already
    // have. An unreadable ledger makes the cost unknown; it never fails a run.
    return null;
  }
}

/**
 * A route cost is read from the evidence already on disk (§2.7). The lookup
 * handed to the pure planner has to be synchronous, so the tail of the ledger
 * is read once per route per invocation and memoised here.
 */
async function routeCostLookup(receiptLedger, routes, cache) {
  for (const route of routes) {
    if (!cache.has(route)) {
      cache.set(route, await estimateRouteCost(receiptLedger, route));
    }
  }
  return (route) => cache.get(route) ?? null;
}

/**
 * §4.1-§4.5 one attempt: choose the rung, admit it, and claim the canaries the
 * admission asked for. Everything that decides is pure (`resolveNextAttempt`);
 * everything here is the state it needs — the snapshot, the cost history, and
 * the compare-and-set that stops two invocations both believing they are the
 * canary (§2.6).
 */
async function resolveAttempt({
  normalized,
  ladder,
  failureKind,
  attemptedRoutes,
  quotaStore,
  receiptLedger,
  costCache,
  now,
}) {
  const snapshot = await quotaStore.snapshot(now);
  await quotaStore.recordSnapshot(snapshot);
  const reviewerRoute = reviewerRouteOf(normalized);
  const costForRoute = await routeCostLookup(
    receiptLedger,
    [
      ...ladder.local.map((entry) => entry.route),
      ...ladder.cloud.map((entry) => entry.route),
      reviewerRoute,
    ],
    costCache,
  );
  const outcome = resolveNextAttempt({
    riskClass: "mechanical",
    failureKind,
    attemptedRoutes,
    ladder,
    reviewerRoute,
    snapshot,
    policy: normalized.quotaPolicy,
    now,
    costForRoute,
  });
  if (outcome.decision !== "execute") {
    return { ...outcome, snapshotId: snapshot.snapshot_id };
  }

  for (const claim of outcome.canaryClaims) {
    const claimed = await quotaStore.claimCanary(claim.provider, claim.window_id, {
      plan: claim.plan,
      now,
    });
    if (!claimed) {
      // A concurrent invocation took the canary between the snapshot and the
      // compare-and-set. Nothing has been spent here, so this one waits.
      return {
        decision: "defer",
        route: null,
        kind: null,
        attempt: outcome.attempt,
        reasonCode: "canary_claimed_by_a_concurrent_invocation",
        deferredUntil: now + normalized.quotaPolicy.canaryIntervalMs,
        canaryClaims: [],
        snapshotId: snapshot.snapshot_id,
      };
    }
  }
  return { ...outcome, snapshotId: snapshot.snapshot_id };
}

/**
 * §4.7 the attempt history that survives process exit: route identifiers and
 * enum values only, never a prompt, never model output, never an error string
 * that could carry task content. Anything else in that array — an operator
 * edit, a truncated write — is ignored rather than trusted.
 */
function readAttemptLog(task) {
  const stored = task?.metadata?.policy_mvp?.attempt_log;
  if (!Array.isArray(stored)) return [];
  return stored
    .filter(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry.route === "string" &&
        entry.route.length > 0 &&
        entry.route.length <= 512 &&
        FAILURE_KINDS.includes(entry.failure_kind) &&
        typeof entry.at === "string" &&
        entry.at.length <= 64,
    )
    .map((entry) => ({
      route: entry.route,
      failure_kind: entry.failure_kind,
      at: entry.at,
    }))
    .slice(-ATTEMPT_LOG_LIMIT);
}

function mergedPolicyMetadata(task, fields) {
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
  return { ...freshMetadata, policy_mvp: { ...freshPolicyMetadata, ...fields } };
}

/**
 * §4.3 the ladder ran out, or the attempt ceiling did. That is a decision, not
 * a crash: the task goes to Antonin with the attempt history attached and the
 * invocation exits 0, exactly as a deferral does.
 */
function ownerTaskUpdate({ task, reasonCode, attemptLog, policyVersion }) {
  return {
    status: "awaiting_owner",
    metadata: mergedPolicyMetadata(
      task,
      attemptLog.length === 0 ? {} : { attempt_log: attemptLog },
    ),
    error_message: `Policy ${policyVersion} requires owner: ${reasonCode}`,
  };
}

/**
 * §4.6 a deferral is not work, and §4.3's owner handoff is a decision rather
 * than a crash: both write no completion journal entry, no token record and no
 * receipt, release the lease, and exit 0. The attempt history rides along so
 * the next invocation resumes the ladder where this one left it.
 */
async function concludeWithoutExecution({
  plan,
  task,
  taskId,
  decision,
  attemptLog,
  normalized,
  missionControl,
  leaseStore,
  lease,
  recoveryLeaseTtlMs,
}) {
  const deferredUntil =
    plan.decision === "defer"
      ? new Date(plan.deferredUntil).toISOString()
      : null;
  // A stale owner exits without mutating anything: the lease is renewed to a
  // TTL longer than the bounded HTTP call, and a takeover in the meantime
  // stops this hand-off before it can touch a task it no longer owns.
  await renewForNetwork(
    leaseStore,
    { task_id: taskId, owner: normalized.agent, fencing_token: lease.fencing_token },
    recoveryLeaseTtlMs,
  );
  let mutationError = null;
  try {
    await missionControl.updateTask(
      task.id,
      deferredUntil === null
        ? ownerTaskUpdate({
            task,
            reasonCode: plan.reasonCode,
            attemptLog,
            policyVersion: decision.policyVersion,
          })
        : deferredTaskUpdate({
            task,
            agent: normalized.agent,
            deferredUntil,
            reasonCode: plan.reasonCode,
            attemptLog,
          }),
    );
  } catch (error) {
    mutationError = error;
  }
  const cleanupWarning = await releaseLeaseForCleanup(
    leaseStore,
    taskId,
    normalized.agent,
    lease.fencing_token,
  );
  if (mutationError !== null) {
    throw new AttemptHandoffError(
      new Error(safeErrorMessage(mutationError, normalized.mcApiKey)),
    );
  }
  return {
    ...(deferredUntil === null
      ? { outcome: "awaiting_owner", processed: 1, taskId: task.id }
      : { outcome: "deferred", processed: 0, taskId: task.id, deferredUntil }),
    reasonCode: plan.reasonCode,
    ...(cleanupWarning ? { cleanupWarning } : {}),
  };
}

/**
 * §4.6 a deferral is not work: no completion journal entry, no token record
 * and no receipt. The task goes back to the policy agent with an
 * operator-visible instant, merged into metadata read moments ago by the queue
 * claim so a concurrent operator edit is not clobbered.
 */
function deferredTaskUpdate({ task, agent, deferredUntil, reasonCode, attemptLog }) {
  return {
    status: "assigned",
    assigned_to: agent,
    metadata: mergedPolicyMetadata(task, {
      deferred_until: deferredUntil,
      deferred_reason: reasonCode,
      ...(attemptLog.length === 0 ? {} : { attempt_log: attemptLog }),
    }),
    error_message: `Policy deferred this task until ${deferredUntil}: ${reasonCode}`,
  };
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

  const reviewerProvider = normalizeReviewerProvider(config.reviewerProvider);
  const quotaPolicy = resolveQuotaPolicy(config.quotaPolicyOverrides ?? {});
  const localModels = normalizeLocalModels(config.localModels);
  const cloudRunners = normalizeCloudRunners(config.cloudRunners);
  const cloudTimeoutMs = positiveInteger(
    config.cloudTimeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS,
    "ANTONIN_CLOUD_TIMEOUT_MS",
  );

  return {
    stateDirectory,
    stateStoreOptions,
    mcUrl,
    mcApiKey,
    agent,
    reviewer,
    reviewerProvider,
    localEndpoint,
    localModel,
    localModels,
    cloudRunners,
    cloudTimeoutMs,
    leaseTtlMs,
    quotaPolicy,
    pocRuntimeDirectory,
  };
}

/** §4.1 rungs 2-3: the other local models this machine may fall back to. */
function normalizeLocalModels(value) {
  if (value === undefined || value === null) return DEFAULT_LOCAL_LADDER_MODELS;
  const models = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
  for (const model of models) {
    requireNonEmptyString(model, "ANTONIN_LOCAL_MODELS");
  }
  return models;
}

/**
 * §7 the runner invocation per provider. It is configuration and not a
 * constant because the CLIs are not this repository's contract: `codex` is not
 * even installed on this machine, and a flag can change under us. An operator
 * corrects the argv through the environment; a wrong one fails as
 * `cloud_auth_missing` and drops that provider for the run.
 */
function normalizeCloudRunners(overrides = {}) {
  const runners = {};
  for (const provider of CLOUD_PROVIDERS) {
    const declared = overrides?.[provider] ?? {};
    const command = declared.command ?? CLOUD_RUNNER_DEFAULTS[provider].command;
    const args = declared.args ?? CLOUD_RUNNER_DEFAULTS[provider].args;
    requireNonEmptyString(command, `${provider} runner command`);
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
      throw new TypeError(`${provider} runner args must be an array of strings`);
    }
    runners[provider] = { command, args: [...args] };
  }
  return runners;
}

function environmentNumber(environment, name) {
  const raw = environment[name];
  if (raw === undefined || String(raw).trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a number`);
  }
  return value;
}

function environmentBoolean(environment, name) {
  const raw = environment[name];
  if (raw === undefined || String(raw).trim() === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new TypeError(`${name} must be true or false`);
}

function environmentArgv(environment, name) {
  const raw = environment[name];
  if (raw === undefined || String(raw).trim() === "") return undefined;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(`${name} must be a JSON array of strings`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${name} must be a JSON array of strings`);
  }
  return parsed;
}

function cloudRunnersFromEnvironment(environment) {
  return {
    "claude-code": {
      command: environment.ANTONIN_CLAUDE_CLI,
      args: environmentArgv(environment, "ANTONIN_CLAUDE_CLI_ARGS"),
    },
    codex: {
      command: environment.ANTONIN_CODEX_CLI,
      args: environmentArgv(environment, "ANTONIN_CODEX_CLI_ARGS"),
    },
  };
}

function quotaPolicyOverridesFromEnvironment(environment) {
  return {
    warnThreshold: environmentNumber(environment, "ANTONIN_QUOTA_WARN_THRESHOLD"),
    weeklyReserveFraction: environmentNumber(
      environment,
      "ANTONIN_QUOTA_WEEKLY_RESERVE",
    ),
    sessionSafetyFactor: environmentNumber(
      environment,
      "ANTONIN_QUOTA_SAFETY_FACTOR",
    ),
    admissionAppliesToReviews: environmentBoolean(
      environment,
      "ANTONIN_QUOTA_ADMIT_REVIEWS",
    ),
    // §5.11 was answered "Autoriser": this override can only close the gate.
    cloudSubprocessAllowed: environmentBoolean(
      environment,
      "ANTONIN_CLOUD_SUBPROCESS",
    ),
    maxAttempts: environmentNumber(environment, "ANTONIN_MAX_ATTEMPTS"),
    operatorTimeZone:
      environment.ANTONIN_OPERATOR_TZ === undefined ||
      String(environment.ANTONIN_OPERATOR_TZ).trim() === ""
        ? undefined
        : String(environment.ANTONIN_OPERATOR_TZ).trim(),
    maxStalenessMs: environmentNumber(
      environment,
      "ANTONIN_QUOTA_MAX_STALENESS_MS",
    ),
    canaryIntervalMs: environmentNumber(
      environment,
      "ANTONIN_QUOTA_CANARY_INTERVAL_MS",
    ),
    maxDeferMs: environmentNumber(environment, "ANTONIN_MAX_DEFER_MS"),
    tokensPerWindow: {
      [planKey("claude-code", PROVIDER_PLANS["claude-code"])]: environmentNumber(
        environment,
        "ANTONIN_QUOTA_TOKENS_PER_WINDOW_CLAUDE_CODE",
      ),
      [planKey("codex", PROVIDER_PLANS.codex)]: environmentNumber(
        environment,
        "ANTONIN_QUOTA_TOKENS_PER_WINDOW_CODEX",
      ),
    },
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
    reviewerProvider: environment.ANTONIN_REVIEWER_PROVIDER,
    localEndpoint: environment.LOCAL_LLM_ENDPOINT ?? DEFAULT_LOCAL_ENDPOINT,
    localModel: environment.LOCAL_LLM_MODEL ?? DEFAULT_LOCAL_MODEL,
    leaseTtlMs:
      environment.ANTONIN_LEASE_TTL_MS ?? DEFAULT_LEASE_TTL_MS,
    quotaPolicyOverrides: quotaPolicyOverridesFromEnvironment(environment),
    localModels: environment.ANTONIN_LOCAL_MODELS,
    cloudRunners: cloudRunnersFromEnvironment(environment),
    cloudTimeoutMs: environmentNumber(environment, "ANTONIN_CLOUD_TIMEOUT_MS"),
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

function recoveryLeaseTtl(configuredTtlMs, missionControl, ollama, override, cloudTimeoutMs = 0) {
  const timeoutMs =
    override ??
    Math.max(
      missionControl.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
      ollama.timeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS,
      cloudTimeoutMs,
    );
  return Math.max(configuredTtlMs, timeoutMs + NETWORK_LEASE_MARGIN_MS);
}

/**
 * §4.1 a rung is a runner. Local rungs stay on the loopback-HTTP client the
 * MVP shipped; cloud rungs are the §7 subprocess contract, whose working
 * directory is a dedicated empty directory inside the external state
 * directory — never the repository, and never a directory holding state the
 * child could read.
 */
async function runnerForRoute(route, normalized, dependencies) {
  const parsed = parseRoute(route);
  if (parsed.provider === "ollama") {
    if (dependencies.ollama !== undefined) return dependencies.ollama;
    return new OllamaClient({
      endpoint: normalized.localEndpoint,
      model: parsed.detail,
    });
  }
  const workingDirectory = path.join(
    normalized.stateDirectory,
    CLOUD_RUNNER_WORKING_DIRECTORY,
  );
  await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
  const declared = normalized.cloudRunners[parsed.provider];
  return new CloudSubprocessRunner({
    provider: parsed.provider,
    command: declared.command,
    args: declared.args,
    workingDirectory,
    timeoutMs: normalized.cloudTimeoutMs,
    outputFormat: parsed.provider === "claude-code" ? "claude_json" : "text",
    timeZone: normalized.quotaPolicy.operatorTimeZone,
  });
}

/**
 * §2.6 the canary reads the outcome of the attempt it authorised. A refusal
 * latches the window until its parsed reset; a success proves only that the
 * window was open at that instant, which is why it carries no fraction.
 *
 * Recording is best-effort by construction: a quota write must never fail a
 * completion that already happened, and `quotas.json` is a routing hint, not
 * the audit trail.
 */
async function recordProviderOutcome({ quotaStore, provider, outcome, error, now }) {
  if (!CLOUD_PROVIDERS.includes(provider)) return;
  const plan = PROVIDER_PLANS[provider];
  try {
    if (outcome === "refused") {
      await quotaStore.observe({
        provider,
        plan,
        window_id: error?.quotaWindowId ?? "session_5h",
        source: "refusal_observed",
        observed_at: now,
        remaining_fraction: 0,
        ...(Number.isSafeInteger(error?.resetsAt)
          ? { exhausted_until: error.resetsAt }
          : {}),
      });
      return;
    }
    for (const windowId of ["weekly", "session_5h"]) {
      await quotaStore.observe({
        provider,
        plan,
        window_id: windowId,
        source: "success_observed",
        observed_at: now,
      });
    }
  } catch {
    // A routing hint that cannot be written is a routing hint we do without.
  }
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

/**
 * The audit record of an attempt that produced nothing. It is hash-only like
 * every other receipt, and best-effort: a broken local ledger must not turn a
 * failed attempt into an unrecoverable invocation. A stale lease is the one
 * exception — it means this invocation no longer owns the task and must stop
 * touching it.
 */
async function appendFailureReceipt({
  task,
  taskId,
  decision,
  lease,
  prompt,
  completion,
  attempt,
  leaseStore,
  receiptLedger,
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
          attempt,
        }),
      ),
    );
  } catch (error) {
    if (isStaleLeaseError(error)) throw error;
    // Failure receipts remain best-effort when the local ledger itself is broken.
  }
}

async function recoverExecutionFailure({
  task,
  taskId,
  decision,
  lease,
  prompt,
  completion,
  attempt,
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
  await appendFailureReceipt({
    task,
    taskId,
    decision,
    lease,
    prompt,
    completion,
    attempt,
    leaseStore,
    receiptLedger,
    owner,
    recoveryLeaseTtlMs,
  });

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
  const quotaStore =
    dependencies.quotaStore ??
    new QuotaStore(normalized.stateDirectory, {
      ...normalized.stateStoreOptions,
      now,
      policy: normalized.quotaPolicy,
    });
  const completionJournal =
    dependencies.completionJournal ??
    new CompletionJournal(normalized.stateDirectory, { now });
  const recoveryLeaseTtlMs = recoveryLeaseTtl(
    normalized.leaseTtlMs,
    missionControl,
    ollama,
    dependencies.networkTimeoutMs,
    normalized.cloudTimeoutMs,
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
  const ladder = buildRouteLadder({
    localModel: normalized.localModel,
    localModels: normalized.localModels,
  });
  const attemptLog = readAttemptLog(task);
  const costCache = new Map();
  let attempt = null;
  let completion = null;
  let duration = 0;
  let completedResult;

  try {
    // §4.2 the fallback loop is bounded by construction to the execution
    // attempt: it contains the provider call and nothing else. Past this loop
    // a completion exists, `reconcileCompletion` owns the outcome, and no
    // route is ever re-planned — which is what makes double execution
    // impossible rather than merely unlikely.
    while (completion === null) {
      let plan;
      try {
        plan = await resolveAttempt({
          normalized,
          ladder,
          failureKind: attemptLog.at(-1)?.failure_kind ?? null,
          attemptedRoutes: attemptLog.map((entry) => entry.route),
          quotaStore,
          receiptLedger,
          costCache,
          now: now(),
        });
      } catch (error) {
        // Planning runs before any provider call, so nothing has been
        // executed: hand the lease back rather than holding it to its TTL.
        await releaseLeaseForCleanup(
          leaseStore,
          taskId,
          normalized.agent,
          lease.fencing_token,
        );
        throw new AttemptHandoffError(error);
      }
      if (plan.decision !== "execute") {
        if (plan.decision !== "defer" && attempt !== null) {
          // §4.3 the ladder ended with Antonin after real attempts were spent:
          // the audit chain records that capacity was consumed. A deferral
          // does not reach here, because §4.6 says a deferral is not work.
          await appendFailureReceipt({
            task,
            taskId,
            decision,
            lease,
            prompt,
            completion: null,
            attempt,
            leaseStore,
            receiptLedger,
            owner: normalized.agent,
            recoveryLeaseTtlMs,
          });
        }
        return await concludeWithoutExecution({
          plan,
          task,
          taskId,
          decision,
          attemptLog,
          normalized,
          missionControl,
          leaseStore,
          lease,
          recoveryLeaseTtlMs,
        });
      }

      const provider = parseRoute(plan.route).provider;
      attempt = {
        number: plan.attempt,
        route: plan.route,
        routeChain: buildRouteChain([
          ...attemptLog.map((entry) => entry.route),
          plan.route,
        ]),
        quotaSnapshotHash: plan.snapshotId,
      };
      try {
        const runner = await runnerForRoute(plan.route, normalized, dependencies);
        await leaseStore.renew(
          taskId,
          normalized.agent,
          lease.fencing_token,
          recoveryLeaseTtlMs,
        );
        const startedAt = now();
        const produced = await runner.complete(prompt);
        duration = Math.max(0, now() - startedAt);
        if (produced.text.length > MAX_RESOLUTION_LENGTH) {
          throw resolutionLimitError(provider);
        }
        await recordProviderOutcome({
          quotaStore,
          provider,
          outcome: "succeeded",
          now: now(),
        });
        completion = produced;
      } catch (error) {
        const failureKind = classifyFailure(error, { provider });
        if (failureKind === "cloud_quota_exhausted") {
          await recordProviderOutcome({
            quotaStore,
            provider,
            outcome: "refused",
            error,
            now: now(),
          });
        }
        if (!isFallbackEligible(failureKind)) {
          // §4.2 and §3: the completion boundary kinds and anything
          // unclassified keep the delivered behaviour — failure receipt,
          // owner, non-zero exit — instead of being re-routed.
          throw error;
        }
        attemptLog.push({
          route: plan.route,
          failure_kind: failureKind,
          at: new Date(now()).toISOString(),
        });
        while (attemptLog.length > ATTEMPT_LOG_LIMIT) attemptLog.shift();
      }
    }

    const entry = completionEntry({
      task,
      decision,
      lease,
      prompt,
      completion,
      duration,
      owner: normalized.agent,
      model: routeModelName(attempt.route),
      now: now(),
      attempt,
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
    if (
      error instanceof CompletionPendingError ||
      error instanceof AttemptHandoffError
    ) {
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
        attempt,
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
      quotaFile: path.join(config.stateDirectory, "quotas.json"),
      mcUrl: config.mcUrl,
      agent: config.agent,
      reviewer: config.reviewer,
      reviewerProvider: config.reviewerProvider,
      localEndpoint: config.localEndpoint,
      localModel: config.localModel,
      routeLadder: buildRouteLadder({
        localModel: config.localModel,
        localModels: config.localModels,
      }),
      cloudRunnerCommands: Object.fromEntries(
        Object.entries(config.cloudRunners).map(([provider, runner]) => [
          provider,
          runner.command,
        ]),
      ),
      cloudSubprocessAllowed: config.quotaPolicy.cloudSubprocessAllowed,
      leaseTtlMs: config.leaseTtlMs,
      apiKeyConfigured: true,
    };
  }
  if (command === "quota-status") {
    const snapshot = await new QuotaStore(config.stateDirectory, {
      ...config.stateStoreOptions,
      policy: config.quotaPolicy,
    }).snapshot();
    return {
      command,
      snapshotId: snapshot.snapshot_id,
      takenAt: new Date(snapshot.taken_at).toISOString(),
      reviewerRoute: reviewerRouteOf(config),
      windows: snapshot.windows,
      policy: config.quotaPolicy,
      ownerDecisionsTaken: OWNER_DECISIONS_TAKEN,
      ownerDecisionsPending: OWNER_DECISION_PLACEHOLDERS,
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
  throw new Error(
    "usage: run-once.mjs process|status|quota-status|verify-ledger",
  );
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
