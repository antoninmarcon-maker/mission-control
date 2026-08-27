import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  POLICY_VERSION,
  evaluateTask,
  validateLoopbackHttpUrl,
} from "../policy-core.mjs";
import { LeaseStore } from "../lease-store.mjs";
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
