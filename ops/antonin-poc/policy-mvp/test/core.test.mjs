import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FAILURE_KINDS,
  POLICY_VERSION,
  admitAttempt,
  classifyFailure,
  evaluateTask,
  isFallbackEligible,
  percentile90,
  validateLoopbackHttpUrl,
} from "../policy-core.mjs";
import { LeaseStore } from "../lease-store.mjs";
import { MissionControlClient } from "../mc-client.mjs";
import { OllamaClient } from "../ollama-client.mjs";
import { QUOTA_WINDOW_CATALOG, resolveQuotaPolicy } from "../quota-config.mjs";
import {
  RECEIPT_SCHEMA_VERSION,
  ReceiptLedger,
} from "../receipt-ledger.mjs";

async function temporaryStateDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "antonin-policy-core-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("policy routes a medium-priority simple local sort to Ollama and a distinct cloud reviewer", () => {
  const decision = evaluateTask({
    id: "task-1",
    title: "Simple local sort",
    description: "Sort these harmless labels.",
    priority: "medium",
    metadata: {},
  });

  assert.deepEqual(decision, {
    policyVersion: "antonin-policy-v0",
    status: "execute_local",
    route: "ollama/qwen2.5-coder:7b",
    reviewer: "poc-aegis-cloud",
    reasonCode: "eligible_mechanical_task",
  });
  assert.equal(POLICY_VERSION, "antonin-policy-v0");
});

test("policy denies high and critical priority tasks", () => {
  for (const priority of ["high", "critical"]) {
    const decision = evaluateTask({
      title: "Simple sort",
      description: "Mechanical work",
      priority,
    });

    assert.equal(decision.status, "awaiting_owner", priority);
    assert.equal(decision.reasonCode, "priority_requires_owner", priority);
    assert.equal(decision.route, null, priority);
  }
});

test("policy denies SOLIDE tasks", () => {
  const decision = evaluateTask({
    title: "Simple sort",
    priority: "medium",
    metadata: { tier: "SOLIDE" },
  });

  assert.equal(decision.status, "awaiting_owner");
  assert.equal(decision.reasonCode, "solide_requires_owner");
});

test("policy denies every sensitive vocabulary term", () => {
  const deniedTerms = [
    "deploy",
    "production",
    "migration",
    "database",
    "security",
    "secret",
    "payment",
    "delete",
    "merge",
    "release",
  ];

  for (const term of deniedTerms) {
    const decision = evaluateTask({
      title: "Simple sort",
      description: `Routine ${term} work`,
      priority: "medium",
    });

    assert.equal(decision.status, "awaiting_owner", term);
    assert.equal(decision.reasonCode, "sensitive_keyword_requires_owner", term);
  }
});

test("policy denies deployment even when the title also looks mechanical", () => {
  const decision = evaluateTask({
    title: "Simple deployment",
    description: "Routine packaging",
    priority: "medium",
  });

  assert.equal(decision.status, "awaiting_owner");
  assert.equal(decision.reasonCode, "sensitive_keyword_requires_owner");
});

test("policy denies tasks outside the exact mechanical vocabulary", () => {
  const decision = evaluateTask({
    title: "Write a new feature",
    description: "Create application behavior",
    priority: "medium",
  });

  assert.equal(decision.status, "awaiting_owner");
  assert.equal(decision.reasonCode, "non_mechanical_requires_owner");
});

test("policy denies a reviewer resolving to the local route identity", () => {
  const decision = evaluateTask(
    {
      title: "Simple sort",
      priority: "medium",
    },
    { reviewer: "ollama/qwen2.5-coder:7b" },
  );

  assert.equal(decision.status, "awaiting_owner");
  assert.equal(decision.reasonCode, "reviewer_must_be_distinct");
  assert.equal(decision.route, null);
});

test("loopback URL validation accepts HTTP loopback and rejects external or HTTPS URLs", () => {
  assert.equal(
    validateLoopbackHttpUrl("http://127.0.0.1:3000/api", "MC_URL").href,
    "http://127.0.0.1:3000/api",
  );
  assert.equal(
    validateLoopbackHttpUrl("http://[::1]:11434/v1", "LOCAL_LLM_ENDPOINT").href,
    "http://[::1]:11434/v1",
  );
  assert.throws(
    () => validateLoopbackHttpUrl("http://example.com:3000", "MC_URL"),
    /MC_URL must use a loopback host/,
  );
  assert.throws(
    () => validateLoopbackHttpUrl("https://127.0.0.1:3000", "MC_URL"),
    /MC_URL must use http:/,
  );
});

test("lease first acquisition uses fencing token 1 and writes mode-600 state", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const store = new LeaseStore(stateDirectory, { now: () => 1_000 });

  const lease = await store.acquire("task-1", "owner-a", {
    ttlMs: 500,
    taskVersion: 7,
  });

  assert.deepEqual(lease, {
    task_id: "task-1",
    owner: "owner-a",
    fencing_token: 1,
    acquired_at: 1_000,
    expires_at: 1_500,
    task_version: 7,
  });
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.deepEqual(persisted.leases["task-1"], lease);
});

test("lease same-owner acquisition and explicit renewal keep the fencing token", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let now = 1_000;
  const store = new LeaseStore(stateDirectory, { now: () => now });
  await store.acquire("task-1", "owner-a", { ttlMs: 500 });

  now = 1_100;
  const reacquired = await store.acquire("task-1", "owner-a", { ttlMs: 800 });
  assert.equal(reacquired.fencing_token, 1);
  assert.equal(reacquired.acquired_at, 1_000);
  assert.equal(reacquired.expires_at, 1_900);

  now = 1_200;
  const renewed = await store.renew("task-1", "owner-a", 1, 900);
  assert.equal(renewed.fencing_token, 1);
  assert.equal(renewed.expires_at, 2_100);
});

test("lease excludes a different owner while the lease is current", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const store = new LeaseStore(stateDirectory, { now: () => 1_000 });
  await store.acquire("task-1", "owner-a", { ttlMs: 500 });

  assert.equal(
    await store.acquire("task-1", "owner-b", { ttlMs: 500 }),
    null,
  );
});

test("lease expired takeover increments the token and fences stale completion", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let now = 1_000;
  const store = new LeaseStore(stateDirectory, { now: () => now });
  await store.acquire("task-1", "owner-a", { ttlMs: 100 });

  now = 1_101;
  const takeover = await store.acquire("task-1", "owner-b", { ttlMs: 500 });

  assert.equal(takeover.fencing_token, 2);
  assert.equal(takeover.owner, "owner-b");
  await assert.rejects(
    store.assertCurrent("task-1", "owner-a", 1),
    /lease is not current/,
  );
  assert.deepEqual(
    await store.assertCurrent("task-1", "owner-b", 2),
    takeover,
  );
});

test("lease completion guard blocks an expired takeover until completion finishes", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let now = 1_000;
  const holder = new LeaseStore(stateDirectory, { now: () => now });
  await holder.acquire("task-1", "owner-a", { ttlMs: 100 });
  const completionEntered = deferred();
  const finishCompletion = deferred();

  const completion = holder.withCompletionGuard(
    "task-1",
    "owner-a",
    1,
    async (lease) => {
      completionEntered.resolve();
      await finishCompletion.promise;
      return lease.fencing_token;
    },
  );
  await completionEntered.promise;

  now = 1_101;
  const retryObserved = deferred();
  const allowRetry = deferred();
  const contender = new LeaseStore(stateDirectory, {
    now: () => now,
    lockMaxAttempts: 3,
    sleep: async () => {
      retryObserved.resolve();
      await allowRetry.promise;
    },
  });
  const takeover = contender.acquire("task-1", "owner-b", { ttlMs: 500 });

  await retryObserved.promise;
  finishCompletion.resolve();
  assert.equal(await completion, 1);
  allowRetry.resolve();
  assert.equal((await takeover).fencing_token, 2);
});

test("lease release removes only a matching owner and fencing token", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const store = new LeaseStore(stateDirectory, { now: () => 1_000 });
  await store.acquire("task-1", "owner-a", { ttlMs: 500 });

  assert.equal(await store.release("task-1", "owner-b", 1), false);
  assert.equal(await store.release("task-1", "owner-a", 2), false);
  assert.equal(await store.release("task-1", "owner-a", 1), true);
  await assert.rejects(
    store.assertCurrent("task-1", "owner-a", 1),
    /lease is not current/,
  );
});

test("lease store rejects non-absolute and filesystem-root state paths", () => {
  assert.throws(() => new LeaseStore("relative/state"), /absolute path/);
  assert.throws(() => new LeaseStore(path.parse(process.cwd()).root), /filesystem root/);
});

test("state stores reject repository and Mission Control runtime paths through descendants and symlinks", async (t) => {
  const sandbox = await temporaryStateDirectory(t);
  const repositoryRoot = path.join(sandbox, "repository");
  const runtimeDirectory = path.join(sandbox, "runtime");
  const externalDirectory = path.join(sandbox, "external");
  const repositoryAlias = path.join(sandbox, "repository-alias");
  const runtimeAlias = path.join(sandbox, "runtime-alias");
  await Promise.all([
    mkdir(repositoryRoot),
    mkdir(runtimeDirectory),
    mkdir(externalDirectory),
  ]);
  await Promise.all([
    symlink(repositoryRoot, repositoryAlias),
    symlink(runtimeDirectory, runtimeAlias),
  ]);
  const options = { repositoryRoot, runtimeDirectory };
  const forbiddenDirectories = [
    repositoryRoot,
    path.join(repositoryRoot, "new", "state"),
    runtimeDirectory,
    path.join(runtimeDirectory, "new", "state"),
    repositoryAlias,
    path.join(repositoryAlias, "new", "state"),
    runtimeAlias,
    path.join(runtimeAlias, "new", "state"),
  ];

  for (const Store of [LeaseStore, ReceiptLedger]) {
    assert.throws(
      () => new Store(process.cwd()),
      /external to the repository and Mission Control runtime/,
    );
    for (const directory of forbiddenDirectories) {
      assert.throws(
        () => new Store(directory, options),
        /external to the repository and Mission Control runtime/,
        `${Store.name}: ${directory}`,
      );
    }
    assert.doesNotThrow(() => new Store(externalDirectory, options));
  }
});

function receipt(overrides = {}) {
  return {
    task_id: "task-1",
    task_version: 7,
    policy_version: "antonin-policy-v0",
    route: "ollama/qwen2.5-coder:7b",
    reviewer: "poc-aegis-cloud",
    lease_id: "task-1:1",
    fencing_token: 1,
    input_hash: "a".repeat(64),
    output_hash: "b".repeat(64),
    token_usage: { output: 3, input: 2 },
    outcome: "success",
    ...overrides,
  };
}

test("receipt genesis append is canonical, hash-linked, compact, and mode 600", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const ledger = new ReceiptLedger(stateDirectory, {
    now: () => Date.parse("2026-08-27T10:00:00.000Z"),
  });

  const record = await ledger.append(receipt());
  const canonicalWithoutHash =
    `{"fencing_token":1,"input_hash":"${"a".repeat(64)}","lease_id":"task-1:1","outcome":"success","output_hash":"${"b".repeat(64)}","policy_version":"antonin-policy-v0","previous_hash":null,"reviewer":"poc-aegis-cloud","route":"ollama/qwen2.5-coder:7b","schema_version":"antonin-receipt-v0","task_id":"task-1","task_version":7,"timestamp":"2026-08-27T10:00:00.000Z","token_usage":{"input":2,"output":3}}`;
  const expectedHash = createHash("sha256")
    .update(canonicalWithoutHash)
    .digest("hex");

  assert.equal(RECEIPT_SCHEMA_VERSION, "antonin-receipt-v0");
  assert.equal(record.previous_hash, null);
  assert.equal(record.record_hash, expectedHash);
  assert.equal((await stat(ledger.filePath)).mode & 0o777, 0o600);
  const contents = await readFile(ledger.filePath, "utf8");
  assert.equal(contents, `${JSON.stringify(record)}\n`);
});

test("receipt second append links to the first hash and the full chain verifies", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  let now = Date.parse("2026-08-27T10:00:00.000Z");
  const ledger = new ReceiptLedger(stateDirectory, { now: () => now });
  const first = await ledger.append(receipt());

  now += 1_000;
  const second = await ledger.append(
    receipt({
      task_id: "task-2",
      task_version: 2,
      lease_id: "task-2:1",
      output_hash: "c".repeat(64),
    }),
  );

  assert.equal(second.previous_hash, first.record_hash);
  assert.deepEqual(await ledger.verify(), {
    valid: true,
    records: 2,
    lastHash: second.record_hash,
  });
});

test("receipt append extends the existing ledger inode instead of replacing it", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const ledger = new ReceiptLedger(stateDirectory, { now: () => 1_000 });
  await ledger.append(receipt());
  const firstContents = await readFile(ledger.filePath, "utf8");
  const originalHandle = await open(ledger.filePath, "r");
  t.after(() => originalHandle.close());

  await ledger.append(
    receipt({
      task_id: "task-2",
      lease_id: "task-2:1",
      input_hash: "c".repeat(64),
      output_hash: "d".repeat(64),
    }),
  );

  const currentContents = await readFile(ledger.filePath, "utf8");
  const contentsThroughOriginalHandle = await originalHandle.readFile("utf8");
  assert.ok(currentContents.startsWith(firstContents));
  assert.equal(contentsThroughOriginalHandle, currentContents);
  assert.equal(currentContents.trimEnd().split("\n").length, 2);
});

test("receipt verification detects tampering", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const ledger = new ReceiptLedger(stateDirectory, { now: () => 1_000 });
  await ledger.append(receipt());
  const [line] = (await readFile(ledger.filePath, "utf8")).trimEnd().split("\n");
  const tampered = { ...JSON.parse(line), outcome: "tampered" };
  await writeFile(ledger.filePath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });

  await assert.rejects(ledger.verify(), /record hash mismatch at line 1/);
});

test("receipt verification rejects a malformed JSONL line", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const ledger = new ReceiptLedger(stateDirectory);
  await writeFile(ledger.filePath, '{"schema_version":\n', { mode: 0o600 });

  await assert.rejects(ledger.verify(), /malformed JSON at line 1/);
});

test("receipt append refuses raw input, raw output, and API-key fields", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const ledger = new ReceiptLedger(stateDirectory, { now: () => 1_000 });

  for (const forbidden of [
    { input: "raw prompt sentinel" },
    { output: "raw output sentinel" },
    { api_key: "api-key sentinel" },
  ]) {
    await assert.rejects(
      ledger.append(receipt(forbidden)),
      /unsupported or sensitive receipt field/,
    );
  }

  await assert.rejects(readFile(ledger.filePath, "utf8"), { code: "ENOENT" });
});

test("receipt append rejects raw values disguised as hashes or token counts and invalid JSON schema values", async (t) => {
  const stateDirectory = await temporaryStateDirectory(t);
  const ledger = new ReceiptLedger(stateDirectory, { now: () => 1_000 });
  const invalidOverrides = [
    { input_hash: "raw prompt" },
    { output_hash: "raw result" },
    { token_usage: { input: "raw prompt", output: 2 } },
    { token_usage: { input: 2, output: -1 } },
    { token_usage: { input: 1.5, output: 2 } },
    { token_usage: { input: 1, output: undefined } },
    { route: undefined },
    { reviewer: "x".repeat(513) },
    { task_version: 1n },
  ];

  for (const overrides of invalidOverrides) {
    await assert.rejects(
      ledger.append(receipt(overrides)),
      /invalid receipt field/,
    );
  }

  await assert.rejects(readFile(ledger.filePath, "utf8"), { code: "ENOENT" });
});

const QUOTA_BASE_INSTANT = 1_800_000_000_000;

async function fakeLocalServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function quotaSnapshot(states = {}, overrides = {}) {
  const windows = QUOTA_WINDOW_CATALOG.map((entry) => {
    const key = `${entry.provider}/${entry.window_id}`;
    const state = entry.metered ? (states[key] ?? "ok") : "ok";
    return {
      ...entry,
      used_fraction: state === "ok" ? 0.1 : 0.9,
      remaining_fraction: state === "ok" ? 0.9 : 0.1,
      resets_at: QUOTA_BASE_INSTANT + 3_600_000,
      observed_at: QUOTA_BASE_INSTANT,
      source: "operator_declaration",
      confidence: "declarative",
      exhausted_until: state === "exhausted" ? QUOTA_BASE_INSTANT + 3_600_000 : null,
      last_canary_at: null,
      state,
      canary_available: state === "unknown",
      ...(overrides[key] ?? {}),
    };
  });
  return { snapshot_id: "x".repeat(64), taken_at: QUOTA_BASE_INSTANT, windows };
}

function admission(overrides = {}) {
  return admitAttempt({
    riskClass: "mechanical",
    executorRoute: "ollama/qwen2.5-coder:7b",
    reviewerRoute: "external/poc-aegis-cloud",
    snapshot: quotaSnapshot(),
    policy: resolveQuotaPolicy(),
    now: QUOTA_BASE_INSTANT,
    ...overrides,
  });
}

test("failure classification maps the errors the existing clients really produce", async (t) => {
  const refused = await new OllamaClient({
    endpoint: "http://127.0.0.1:9/v1",
    model: "qwen2.5-coder:7b",
    timeoutMs: 2_000,
  })
    .complete("hello")
    .catch((error) => error);
  assert.equal(classifyFailure(refused), "local_daemon_unreachable");

  const silent = await fakeLocalServer(t, () => {});
  const timedOut = await new OllamaClient({
    endpoint: `${silent}/v1`,
    model: "qwen2.5-coder:7b",
    timeoutMs: 100,
  })
    .complete("hello")
    .catch((error) => error);
  assert.equal(classifyFailure(timedOut), "local_transient");

  const modelMissing = await fakeLocalServer(t, (_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "model not found" } }));
  });
  const notFound = await new OllamaClient({
    endpoint: `${modelMissing}/v1`,
    model: "qwen2.5-coder:7b",
    timeoutMs: 2_000,
  })
    .complete("hello")
    .catch((error) => error);
  assert.equal(classifyFailure(notFound), "local_model_error");

  const broken = await fakeLocalServer(t, (_request, response) => {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "local model unavailable" }));
  });
  const serverError = await new OllamaClient({
    endpoint: `${broken}/v1`,
    model: "qwen2.5-coder:7b",
    timeoutMs: 2_000,
  })
    .complete("hello")
    .catch((error) => error);
  assert.equal(classifyFailure(serverError), "local_transient");

  const truncated = await fakeLocalServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: {} }] }));
  });
  const invalidOutput = await new OllamaClient({
    endpoint: `${truncated}/v1`,
    model: "qwen2.5-coder:7b",
    timeoutMs: 2_000,
  })
    .complete("hello")
    .catch((error) => error);
  assert.equal(classifyFailure(invalidOutput), "local_output_invalid");

  const ambiguous = await fakeLocalServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task: { id: 42, status: "assigned" } }));
  });
  const ambiguousMutation = await new MissionControlClient({
    baseUrl: ambiguous,
    apiKey: "secret",
  })
    .updateTask(42, { status: "review" })
    .catch((error) => error);
  assert.equal(classifyFailure(ambiguousMutation), "control_plane_ambiguous");

  const directory = await temporaryStateDirectory(t);
  const leaseStore = new LeaseStore(directory);
  const staleLease = await leaseStore
    .renew("42", "antonin-policy-engine", 1, 1_000)
    .catch((error) => error);
  assert.equal(classifyFailure(staleLease), "lease_lost");
});

test("the completion boundary never yields a fallback route", () => {
  const contended = new Error("completion abc is already claimed");
  contended.name = "CompletionContendedError";
  assert.equal(classifyFailure(contended), "lease_lost");

  const disguised = new Error("lease is not current for task 42");
  disguised.failureKind = "local_transient";
  assert.equal(classifyFailure(disguised), "lease_lost");

  const ambiguous = new Error("Mission Control returned an invalid response");
  ambiguous.name = "MissionControlRequestError";
  ambiguous.ambiguous = true;
  ambiguous.failureKind = "cloud_transient";
  assert.equal(classifyFailure(ambiguous), "control_plane_ambiguous");

  assert.equal(isFallbackEligible("lease_lost"), false);
  assert.equal(isFallbackEligible("control_plane_ambiguous"), false);
});

test("an unclassified error fails closed and the taxonomy is total", () => {
  assert.equal(classifyFailure(new Error("something new happened")), "unknown");
  assert.equal(classifyFailure(null), "unknown");
  assert.equal(classifyFailure(undefined, {}), "unknown");
  assert.equal(isFallbackEligible("unknown"), false);
  assert.equal(isFallbackEligible("policy_reject"), false);
  assert.equal(classifyFailure(new Error("x"), { policyRejected: true }), "policy_reject");

  for (const kind of FAILURE_KINDS) {
    assert.equal(typeof isFallbackEligible(kind), "boolean");
  }
  assert.equal(FAILURE_KINDS.filter(isFallbackEligible).length, 7);

  const declared = new Error("cloud runner refused");
  declared.failureKind = "cloud_quota_exhausted";
  assert.equal(classifyFailure(declared), "cloud_quota_exhausted");
  const rateLimited = new Error("Codex request failed (429)");
  rateLimited.status = 429;
  assert.equal(
    classifyFailure(rateLimited, { provider: "codex" }),
    "cloud_quota_exhausted",
  );
  assert.equal(classifyFailure(rateLimited, { provider: "ollama" }), "unknown");
});

test("admission is pure: it performs no I/O and is deterministic", () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("admission must not perform I/O");
  };
  try {
    const first = admission();
    const second = admission();
    assert.deepEqual(first, second);
    assert.equal(first.decision, "execute");
    assert.deepEqual(first.canaryClaims, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a sensitive task stays with the owner at every quota state", () => {
  for (const state of ["ok", "warn", "critical", "exhausted", "unknown"]) {
    const decision = admission({
      riskClass: "sensitive",
      reviewerRoute: "codex/pro",
      snapshot: quotaSnapshot({
        "codex/weekly": state,
        "codex/session_5h": state,
      }),
    });
    assert.equal(decision.decision, "awaiting_owner");
    assert.equal(decision.reasonCode, "sensitive_requires_owner");
    assert.deepEqual(decision.canaryClaims, []);
  }
});

test("admission enumerates exactly one decision for every risk and window state", () => {
  const decisions = new Set(["execute", "defer", "awaiting_owner"]);
  for (const riskClass of ["mechanical", "sensitive"]) {
    for (const weekly of ["ok", "warn", "critical", "exhausted", "unknown"]) {
      for (const session of ["ok", "warn", "critical", "exhausted", "unknown"]) {
        const outcome = admission({
          riskClass,
          reviewerRoute: "codex/pro",
          snapshot: quotaSnapshot({
            "codex/weekly": weekly,
            "codex/session_5h": session,
          }),
        });
        assert.equal(
          decisions.has(outcome.decision),
          true,
          `${riskClass}/${weekly}/${session}`,
        );
        assert.equal(typeof outcome.reasonCode, "string");
        assert.notEqual(outcome.reasonCode, "");
        assert.equal(Array.isArray(outcome.canaryClaims), true);
        if (outcome.decision === "defer") {
          assert.equal(Number.isSafeInteger(outcome.deferredUntil), true);
        } else {
          assert.equal(outcome.deferredUntil, null);
        }
      }
    }
  }
});

test("executor capacity alone does not admit a task without reviewer capacity", () => {
  const executorFine = admission({
    reviewerRoute: "codex/pro",
    snapshot: quotaSnapshot({ "codex/weekly": "critical" }),
  });
  assert.equal(executorFine.decision, "defer");
  assert.equal(executorFine.reasonCode, "review_window_critical");
  assert.equal(executorFine.deferredUntil, QUOTA_BASE_INSTANT + 3_600_000);

  const exhausted = admission({
    reviewerRoute: "codex/pro",
    snapshot: quotaSnapshot({ "codex/session_5h": "exhausted" }),
  });
  assert.equal(exhausted.decision, "defer");
  assert.equal(exhausted.reasonCode, "review_window_exhausted");

  const warnBandKeepsReviews = admission({
    reviewerRoute: "codex/pro",
    snapshot: quotaSnapshot({
      "codex/weekly": "warn",
      "codex/session_5h": "warn",
    }),
  });
  assert.equal(warnBandKeepsReviews.decision, "execute");
});

test("an untracked reviewer route carries no window to evaluate", () => {
  const decision = admission({ reviewerRoute: "external/poc-aegis-cloud" });
  assert.equal(decision.decision, "execute");
  assert.deepEqual(decision.canaryClaims, []);
});

test("a reviewer on the executor provider is refused instead of grading itself", () => {
  const decision = admission({
    executorRoute: "codex/pro",
    reviewerRoute: "codex/pro",
  });
  assert.equal(decision.decision, "awaiting_owner");
  assert.equal(decision.reasonCode, "reviewer_must_be_distinct");
});

test("the open subprocess gate admits a cloud executor and closing it refuses one", () => {
  assert.equal(resolveQuotaPolicy().cloudSubprocessAllowed, true);
  const admitted = admission({
    executorRoute: "claude-code/max",
    reviewerRoute: "codex/pro",
  });
  assert.equal(admitted.decision, "execute");

  const closed = admission({
    executorRoute: "claude-code/max",
    reviewerRoute: "codex/pro",
    policy: resolveQuotaPolicy({ cloudSubprocessAllowed: false }),
  });
  assert.equal(closed.decision, "awaiting_owner");
  assert.equal(closed.reasonCode, "cloud_subprocess_not_allowed");
});

test("an unknown window spends one canary and then defers", () => {
  const unknown = quotaSnapshot({ "codex/session_5h": "unknown" });
  const admitted = admission({ reviewerRoute: "codex/pro", snapshot: unknown });
  assert.equal(admitted.decision, "execute");
  assert.deepEqual(admitted.canaryClaims, [
    { provider: "codex", plan: "pro", window_id: "session_5h" },
  ]);

  const spent = admission({
    reviewerRoute: "codex/pro",
    snapshot: quotaSnapshot(
      { "codex/session_5h": "unknown" },
      { "codex/session_5h": { canary_available: false } },
    ),
  });
  assert.equal(spent.decision, "defer");
  assert.equal(spent.reasonCode, "review_window_unknown_canary_spent");
  assert.equal(
    spent.deferredUntil,
    QUOTA_BASE_INSTANT + resolveQuotaPolicy().canaryIntervalMs,
  );
});

test("the 5 h inequality defers a job whose p90 cost exceeds the remaining window", () => {
  const policy = resolveQuotaPolicy({
    admissionAppliesToReviews: true,
    tokensPerWindow: { "codex:pro": 100_000 },
  });
  const snapshot = quotaSnapshot(
    {},
    { "codex/session_5h": { remaining_fraction: 0.5, used_fraction: 0.5 } },
  );

  const fits = admitAttempt({
    riskClass: "mechanical",
    executorRoute: "ollama/qwen2.5-coder:7b",
    reviewerRoute: "codex/pro",
    snapshot,
    reviewerCostTokens: 33_000,
    policy,
    now: QUOTA_BASE_INSTANT,
  });
  assert.equal(fits.decision, "execute");

  const doesNotFit = admitAttempt({
    riskClass: "mechanical",
    executorRoute: "ollama/qwen2.5-coder:7b",
    reviewerRoute: "codex/pro",
    snapshot,
    reviewerCostTokens: 34_000,
    policy,
    now: QUOTA_BASE_INSTANT,
  });
  assert.equal(doesNotFit.decision, "defer");
  assert.equal(doesNotFit.reasonCode, "review_session_window_too_small");

  // An undeclared window size (§5.3) makes the inequality unevaluable, not
  // false: the window state and the refusal circuit breaker still govern.
  const unmetered = admitAttempt({
    riskClass: "mechanical",
    executorRoute: "ollama/qwen2.5-coder:7b",
    reviewerRoute: "codex/pro",
    snapshot,
    reviewerCostTokens: 10_000_000,
    policy: resolveQuotaPolicy({ admissionAppliesToReviews: true }),
    now: QUOTA_BASE_INSTANT,
  });
  assert.equal(unmetered.decision, "execute");
  const unmeteredAndCritical = admitAttempt({
    riskClass: "mechanical",
    executorRoute: "ollama/qwen2.5-coder:7b",
    reviewerRoute: "codex/pro",
    snapshot: quotaSnapshot({ "codex/session_5h": "critical" }),
    reviewerCostTokens: 10,
    policy: resolveQuotaPolicy({ admissionAppliesToReviews: true }),
    now: QUOTA_BASE_INSTANT,
  });
  assert.equal(unmeteredAndCritical.decision, "defer");
  assert.equal(unmeteredAndCritical.reasonCode, "review_window_critical");

  const reviewsNotGated = admitAttempt({
    riskClass: "mechanical",
    executorRoute: "ollama/qwen2.5-coder:7b",
    reviewerRoute: "codex/pro",
    snapshot,
    reviewerCostTokens: 10_000_000,
    policy: resolveQuotaPolicy(),
    now: QUOTA_BASE_INSTANT,
  });
  assert.equal(reviewsNotGated.decision, "execute");
});

test("a reset beyond the maximum deferral becomes an owner decision", () => {
  const decision = admission({
    reviewerRoute: "codex/pro",
    snapshot: quotaSnapshot(
      { "codex/weekly": "exhausted" },
      {
        "codex/weekly": {
          exhausted_until: QUOTA_BASE_INSTANT + 7 * 24 * 3_600_000,
        },
      },
    ),
  });
  assert.equal(decision.decision, "awaiting_owner");
  assert.equal(
    decision.reasonCode,
    "review_window_exhausted_beyond_max_defer",
  );
});

test("the cost estimator ignores failure receipts and reads a bounded tail", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const ledger = new ReceiptLedger(directory);

  for (const [index, outcome] of [
    "success",
    "failure",
    "success",
    "success",
  ].entries()) {
    await ledger.append(
      receipt({
        task_id: `task-${index}`,
        outcome,
        token_usage: { input: 100 * (index + 1), output: 10 },
      }),
    );
  }
  await ledger.append(
    receipt({
      task_id: "other-route",
      route: "ollama/qwen3:14b",
      token_usage: { input: 9_000, output: 9_000 },
    }),
  );

  const costs = await ledger.recentSuccessCosts("ollama/qwen2.5-coder:7b");
  assert.deepEqual(costs, [110, 310, 410]);
  assert.equal(percentile90(costs), 410);
  assert.equal(percentile90([]), null);
  assert.equal(percentile90([5]), 5);
  assert.equal(percentile90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9);

  const tail = await ledger.recentSuccessCosts("ollama/qwen2.5-coder:7b", {
    maximumBytes: 900,
  });
  assert.equal(tail.length < costs.length, true);
  assert.equal(
    await ledger
      .recentSuccessCosts("ollama/qwen2.5-coder:7b", { maximumSamples: 1 })
      .then((values) => values.length),
    1,
  );

  const missing = new ReceiptLedger(await temporaryStateDirectory(t));
  assert.deepEqual(await missing.recentSuccessCosts("ollama/qwen2.5-coder:7b"), []);
});

test("an executor route this engine tracks no window for is refused", () => {
  for (const executorRoute of [
    "gemini/pro",
    "qwen2.5-coder:7b",
    "/leading",
    "trailing/",
  ]) {
    const decision = admission({ executorRoute });
    assert.equal(decision.decision, "awaiting_owner", executorRoute);
    assert.equal(decision.reasonCode, "unknown_executor_route", executorRoute);
  }
});
