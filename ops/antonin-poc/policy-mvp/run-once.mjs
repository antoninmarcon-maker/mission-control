#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { LeaseStore, resolveExternalStateDirectory } from "./lease-store.mjs";
import { MissionControlClient } from "./mc-client.mjs";
import { OllamaClient } from "./ollama-client.mjs";
import { evaluateTask, validateLoopbackHttpUrl } from "./policy-core.mjs";
import { ReceiptLedger } from "./receipt-ledger.mjs";

const DEFAULT_AGENT = "antonin-policy-engine";
const DEFAULT_REVIEWER = "poc-aegis-cloud";
const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:11434/v1";
const DEFAULT_LOCAL_MODEL = "qwen2.5-coder:7b";
const DEFAULT_LEASE_TTL_MS = 120_000;
const MAX_ERROR_LENGTH = 320;

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
  };
}

export function configFromEnvironment(environment = process.env) {
  return validateProcessConfig({
    stateDirectory: environment.ANTONIN_POLICY_STATE_DIR,
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
    await moveToAwaitingOwner(
      missionControl,
      task.id,
      "External policy lease is held by another owner",
    );
    throw new Error(`lease is unavailable for task ${taskId}`);
  }

  const prompt = localPrompt(task);
  let completion = null;
  let duration = 0;
  try {
    const startedAt = now();
    completion = await ollama.complete(prompt);
    duration = Math.max(0, now() - startedAt);
    if (completion.text.length > 5_000) {
      throw new Error("Ollama response exceeds the task resolution limit");
    }

    const receipt = await leaseStore.withCompletionGuard(
      taskId,
      normalized.agent,
      lease.fencing_token,
      async () => {
        const storedReceipt = await receiptLedger.append(
          receiptInput({
            task,
            decision,
            lease,
            prompt,
            completion,
            outcome: "success",
          }),
        );
        await missionControl.recordTokens({
          model: normalized.localModel,
          sessionId: `${normalized.agent}:task-${taskId}`,
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          operation: "policy_mvp",
          duration,
          taskId: task.id,
        });
        await missionControl.updateTask(task.id, {
          status: "review",
          assigned_to: decision.reviewer,
          resolution: completion.text,
          error_message: "",
        });
        return storedReceipt;
      },
    );

    await leaseStore.release(taskId, normalized.agent, lease.fencing_token);
    return {
      outcome: "review",
      processed: 1,
      taskId: task.id,
      reviewer: decision.reviewer,
      receiptHash: receipt.record_hash,
    };
  } catch (error) {
    try {
      await leaseStore.withCompletionGuard(
        taskId,
        normalized.agent,
        lease.fencing_token,
        () =>
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
    } catch {
      // The failure receipt is best-effort; stale fencing must not be bypassed.
    }
    try {
      await moveToAwaitingOwner(
        missionControl,
        task.id,
        "External policy execution failed; owner review required",
      );
    } catch {
      // Preserve the original failure while still attempting recovery.
    }
    try {
      await leaseStore.release(taskId, normalized.agent, lease.fencing_token);
    } catch {
      // Preserve the original failure after the matching release was attempted.
    }
    throw new Error(safeErrorMessage(error, normalized.mcApiKey));
  }
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
