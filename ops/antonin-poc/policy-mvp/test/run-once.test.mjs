import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { LeaseStore } from "../lease-store.mjs";
import { MissionControlClient } from "../mc-client.mjs";
import { OllamaClient } from "../ollama-client.mjs";
import { ReceiptLedger } from "../receipt-ledger.mjs";
import { processOne } from "../run-once.mjs";

const execFile = promisify(execFileCallback);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const policyDirectory = path.resolve(testDirectory, "..");
const repositoryRoot = path.resolve(policyDirectory, "../../..");
const runOncePath = path.join(policyDirectory, "run-once.mjs");

async function fakeHttpServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function temporaryPolicyState(t) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "antonin-policy-run-once-"));
  const testRepositoryRoot = path.join(sandbox, "repository");
  const runtimeDirectory = path.join(sandbox, "runtime");
  const stateDirectory = path.join(sandbox, "external", "policy-state");
  await Promise.all([
    mkdir(testRepositoryRoot),
    mkdir(runtimeDirectory),
    mkdir(path.dirname(stateDirectory)),
  ]);
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return {
    stateDirectory,
    stateStoreOptions: {
      repositoryRoot: testRepositoryRoot,
      runtimeDirectory,
    },
  };
}

function processConfig(state, overrides = {}) {
  return {
    stateDirectory: state.stateDirectory,
    stateStoreOptions: state.stateStoreOptions,
    mcUrl: overrides.mcUrl,
    mcApiKey: "mc-process-secret",
    agent: "antonin-policy-engine",
    reviewer: "poc-aegis-cloud",
    localEndpoint: overrides.localEndpoint ?? "http://127.0.0.1:9/v1",
    localModel: "qwen2.5-coder:7b",
    leaseTtlMs: overrides.leaseTtlMs ?? 120_000,
  };
}

function queuedTask(overrides = {}) {
  return {
    id: 42,
    title: "Simple sort",
    description: "Sort harmless labels",
    priority: "medium",
    metadata: {},
    version: 7,
    ...overrides,
  };
}

function queueResponse(task) {
  return {
    task,
    reason: "assigned",
    agent: "antonin-policy-engine",
    timestamp: 1_788_000_000,
  };
}

async function assertLeaseReleased(state, taskId = "42") {
  const store = new LeaseStore(state.stateDirectory, state.stateStoreOptions);
  await assert.rejects(
    store.assertCurrent(taskId, "antonin-policy-engine", 1),
    /lease is not current/,
  );
}

test("Mission Control client uses the exact queue, task, comment, and token contracts", async (t) => {
  const apiKey = "mc-test-secret";
  const requests = [];
  const baseUrl = await fakeHttpServer(t, async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      apiKey: request.headers["x-api-key"],
      body:
        request.method === "GET" ? null : await readJson(request),
    });

    if (request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(response, 200, {
        task: {
          id: 42,
          title: "Simple sort",
          description: "Sort harmless labels",
          priority: "medium",
          metadata: {},
          version: 7,
        },
        reason: "assigned",
        agent: "antonin-policy-engine",
        timestamp: 1_788_000_000,
      });
      return;
    }
    if (request.url === "/api/tasks/42/comments") {
      sendJson(response, 201, { comment: { id: 8, content: "Needs owner" } });
      return;
    }
    if (request.url === "/api/tokens") {
      sendJson(response, 200, { success: true, record: { id: "token-1" } });
      return;
    }
    sendJson(response, 200, { task: { id: 42, status: "review" } });
  });
  const client = new MissionControlClient({ baseUrl, apiKey });

  const task = await client.claimOne("antonin-policy-engine");
  const updated = await client.updateTask(42, {
    status: "review",
    assigned_to: "poc-aegis-cloud",
    resolution: "Sorted result",
    metadata: { policy_version: "antonin-policy-v0" },
    error_message: "",
  });
  const comment = await client.addComment(42, "Needs owner");
  const tokenRecord = await client.recordTokens({
    model: "qwen2.5-coder:7b",
    sessionId: "antonin-policy-engine:task-42",
    inputTokens: 12,
    outputTokens: 4,
    operation: "chat_completion",
    duration: 25,
    taskId: 42,
  });

  assert.equal(task.id, 42);
  assert.equal(updated.task.status, "review");
  assert.equal(comment.comment.id, 8);
  assert.equal(tokenRecord.record.id, "token-1");
  assert.deepEqual(requests, [
    {
      method: "GET",
      url: "/api/tasks/queue?agent=antonin-policy-engine&max_capacity=1",
      apiKey,
      body: null,
    },
    {
      method: "PUT",
      url: "/api/tasks/42",
      apiKey,
      body: {
        status: "review",
        assigned_to: "poc-aegis-cloud",
        resolution: "Sorted result",
        metadata: { policy_version: "antonin-policy-v0" },
        error_message: "",
      },
    },
    {
      method: "POST",
      url: "/api/tasks/42/comments",
      apiKey,
      body: { content: "Needs owner" },
    },
    {
      method: "POST",
      url: "/api/tokens",
      apiKey,
      body: {
        model: "qwen2.5-coder:7b",
        sessionId: "antonin-policy-engine:task-42",
        inputTokens: 12,
        outputTokens: 4,
        operation: "chat_completion",
        duration: 25,
        taskId: 42,
      },
    },
  ]);
});

test("Mission Control queue claim returns null for a 204 response", async (t) => {
  const baseUrl = await fakeHttpServer(t, (_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const client = new MissionControlClient({ baseUrl, apiKey: "secret" });

  assert.equal(await client.claimOne("antonin-policy-engine"), null);
});

test("Mission Control errors are bounded and redact the API key", async (t) => {
  const apiKey = "never-print-this-key";
  const baseUrl = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 500, {
      error: `failed with ${apiKey}: ${"x".repeat(5_000)}`,
    });
  });
  const client = new MissionControlClient({ baseUrl, apiKey });

  await assert.rejects(client.claimOne("agent"), (error) => {
    assert.equal(error.message.includes(apiKey), false);
    assert.equal(error.message.includes("[REDACTED]"), true);
    assert.ok(error.message.length <= 384, error.message.length);
    return true;
  });
});

test("REST clients reject non-loopback or HTTPS endpoints before making requests", () => {
  assert.throws(
    () =>
      new MissionControlClient({
        baseUrl: "http://example.com:3000",
        apiKey: "secret",
      }),
    /loopback host/,
  );
  assert.throws(
    () => new OllamaClient({ endpoint: "https://127.0.0.1:11434/v1", model: "local" }),
    /must use http:/,
  );
});

test("Ollama client sends an OpenAI-compatible request and normalizes text and tokens", async (t) => {
  let observed;
  const endpoint = await fakeHttpServer(t, async (request, response) => {
    observed = {
      method: request.method,
      url: request.url,
      body: await readJson(request),
    };
    sendJson(response, 200, {
      id: "chatcmpl-local",
      choices: [{ message: { role: "assistant", content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 },
    });
  });
  const client = new OllamaClient({
    endpoint: `${endpoint}/v1`,
    model: "qwen2.5-coder:7b",
  });

  const result = await client.complete("Sort these labels: beta, alpha");

  assert.deepEqual(result, {
    text: "alpha\nbeta",
    inputTokens: 17,
    outputTokens: 5,
  });
  assert.deepEqual(observed, {
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "Sort these labels: beta, alpha" }],
      stream: false,
    },
  });
});

test("processOne exits cleanly when Mission Control has no queued task", async (t) => {
  const state = await temporaryPolicyState(t);
  let requests = 0;
  const mcUrl = await fakeHttpServer(t, (_request, response) => {
    requests += 1;
    sendJson(response, 200, {
      task: null,
      reason: "no_tasks_available",
      agent: "antonin-policy-engine",
      timestamp: 1_788_000_000,
    });
  });

  const result = await processOne(processConfig(state, { mcUrl }));

  assert.deepEqual(result, { outcome: "no_task", processed: 0 });
  assert.equal(requests, 1);
});

test("processOne moves a policy-rejected task to awaiting_owner without calling Ollama", async (t) => {
  const state = await temporaryPolicyState(t);
  const requests = [];
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    const body = request.method === "GET" ? null : await readJson(request);
    requests.push({ method: request.method, url: request.url, body });
    if (request.method === "GET") {
      sendJson(response, 200, queueResponse(queuedTask({ priority: "high" })));
      return;
    }
    sendJson(response, 200, { task: { id: 42, status: "awaiting_owner" } });
  });

  const result = await processOne(processConfig(state, { mcUrl }));

  assert.deepEqual(result, {
    outcome: "awaiting_owner",
    processed: 1,
    taskId: 42,
    reasonCode: "priority_requires_owner",
  });
  assert.deepEqual(requests, [
    {
      method: "GET",
      url: "/api/tasks/queue?agent=antonin-policy-engine&max_capacity=1",
      body: null,
    },
    {
      method: "PUT",
      url: "/api/tasks/42",
      body: {
        status: "awaiting_owner",
        error_message:
          "Policy antonin-policy-v0 requires owner: priority_requires_owner",
      },
    },
  ]);
});

test("processOne completes an allowed task under a lease and leaves a hash-only receipt", async (t) => {
  const state = await temporaryPolicyState(t);
  const events = [];
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    const body = request.method === "GET" ? null : await readJson(request);
    events.push({ boundary: "mc", method: request.method, url: request.url, body });
    if (request.method === "GET") {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.url === "/api/tokens") {
      sendJson(response, 200, { success: true, record: { id: "token-1" } });
      return;
    }
    sendJson(response, 200, { task: { id: 42, status: "review" } });
  });
  const localEndpoint = await fakeHttpServer(t, async (request, response) => {
    const body = await readJson(request);
    events.push({ boundary: "ollama", method: request.method, url: request.url, body });
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });

  const result = await processOne(
    processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
  );

  assert.equal(result.outcome, "review");
  assert.equal(result.processed, 1);
  assert.equal(result.taskId, 42);
  assert.match(result.receiptHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    events.map(({ boundary, method, url }) => ({ boundary, method, url })),
    [
      {
        boundary: "mc",
        method: "GET",
        url: "/api/tasks/queue?agent=antonin-policy-engine&max_capacity=1",
      },
      {
        boundary: "ollama",
        method: "POST",
        url: "/v1/chat/completions",
      },
      { boundary: "mc", method: "POST", url: "/api/tokens" },
      { boundary: "mc", method: "PUT", url: "/api/tasks/42" },
    ],
  );
  const ollamaRequest = events[1].body;
  assert.equal(ollamaRequest.model, "qwen2.5-coder:7b");
  assert.match(ollamaRequest.messages[0].content, /text-only response/i);
  assert.match(ollamaRequest.messages[0].content, /no filesystem, network, Git/i);
  assert.match(ollamaRequest.messages[0].content, /Simple sort/);

  const tokenRequest = events[2].body;
  assert.deepEqual(
    Object.keys(tokenRequest).sort(),
    [
      "duration",
      "inputTokens",
      "model",
      "operation",
      "outputTokens",
      "sessionId",
      "taskId",
    ],
  );
  assert.equal(tokenRequest.model, "qwen2.5-coder:7b");
  assert.equal(tokenRequest.sessionId, "antonin-policy-engine:task-42");
  assert.equal(tokenRequest.inputTokens, 19);
  assert.equal(tokenRequest.outputTokens, 5);
  assert.equal(tokenRequest.operation, "policy_mvp");
  assert.equal(tokenRequest.taskId, 42);
  assert.ok(Number.isFinite(tokenRequest.duration));

  assert.deepEqual(events[3].body, {
    status: "review",
    assigned_to: "poc-aegis-cloud",
    resolution: "alpha\nbeta",
    error_message: "",
  });
  const ledgerText = await readFile(
    path.join(state.stateDirectory, "receipts.jsonl"),
    "utf8",
  );
  assert.equal(ledgerText.includes("Simple sort"), false);
  assert.equal(ledgerText.includes("Sort harmless labels"), false);
  assert.equal(ledgerText.includes("alpha"), false);
  const [receipt] = ledgerText.trimEnd().split("\n").map(JSON.parse);
  assert.equal(receipt.outcome, "success");
  assert.equal(receipt.output_hash, createHash("sha256").update("alpha\nbeta").digest("hex"));
  assert.deepEqual(receipt.token_usage, { input: 19, output: 5 });
  assert.equal(receipt.reviewer, "poc-aegis-cloud");
  assert.equal(receipt.fencing_token, 1);
  await assertLeaseReleased(state);
});

test("processOne records a guarded failure, attempts awaiting_owner, and releases the lease", async (t) => {
  const state = await temporaryPolicyState(t);
  const mcRequests = [];
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    const body = request.method === "GET" ? null : await readJson(request);
    mcRequests.push({ method: request.method, url: request.url, body });
    if (request.method === "GET") {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    sendJson(response, 200, { task: { id: 42, status: "awaiting_owner" } });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 500, { error: "local model unavailable" });
  });

  await assert.rejects(
    processOne(
      processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
    ),
    /Ollama request failed \(500\)/,
  );

  assert.equal(
    mcRequests.some((request) => request.url === "/api/tokens"),
    false,
  );
  assert.deepEqual(mcRequests.at(-1), {
    method: "PUT",
    url: "/api/tasks/42",
    body: {
      status: "awaiting_owner",
      error_message: "External policy execution failed; owner review required",
    },
  });
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  assert.equal((await ledger.verify()).records, 1);
  const [receipt] = (await readFile(ledger.filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  assert.equal(receipt.outcome, "failure");
  assert.equal(receipt.output_hash, createHash("sha256").update("").digest("hex"));
  assert.deepEqual(receipt.token_usage, { input: 0, output: 0 });
  assert.equal(JSON.stringify(receipt).includes("local model unavailable"), false);
  await assertLeaseReleased(state);
});

test("a replaced fencing token blocks receipt, token post, and review completion", async (t) => {
  const state = await temporaryPolicyState(t);
  const mcRequests = [];
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    const body = request.method === "GET" ? null : await readJson(request);
    mcRequests.push({ method: request.method, url: request.url, body });
    if (request.method === "GET") {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    sendJson(response, 200, { task: { id: 42, status: "awaiting_owner" } });
  });
  const contender = new LeaseStore(state.stateDirectory, state.stateStoreOptions);
  const localEndpoint = await fakeHttpServer(t, async (_request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const takeover = await contender.acquire("42", "replacement-owner", {
      ttlMs: 10_000,
      taskVersion: 7,
    });
    assert.equal(takeover.fencing_token, 2);
    sendJson(response, 200, {
      choices: [{ message: { content: "must not complete" } }],
      usage: { prompt_tokens: 9, completion_tokens: 3 },
    });
  });

  await assert.rejects(
    processOne(
      processConfig(state, {
        mcUrl,
        localEndpoint: `${localEndpoint}/v1`,
        leaseTtlMs: 5,
      }),
    ),
    /lease is not current/,
  );

  assert.equal(
    mcRequests.some((request) => request.url === "/api/tokens"),
    false,
  );
  assert.equal(
    mcRequests.some((request) => request.body?.status === "review"),
    false,
  );
  assert.equal(mcRequests.at(-1).body.status, "awaiting_owner");
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  assert.deepEqual(await ledger.verify(), {
    valid: true,
    records: 0,
    lastHash: null,
  });
  assert.equal(
    (await contender.assertCurrent("42", "replacement-owner", 2)).fencing_token,
    2,
  );
});

test("processOne validates all configuration before claiming a task", async (t) => {
  const state = await temporaryPolicyState(t);
  let requests = 0;
  const mcUrl = await fakeHttpServer(t, (_request, response) => {
    requests += 1;
    sendJson(response, 200, queueResponse(queuedTask()));
  });

  await assert.rejects(
    processOne({
      ...processConfig(state, { mcUrl }),
      reviewer: "antonin-policy-engine",
    }),
    /reviewer must be distinct from the policy agent/,
  );
  assert.equal(requests, 0);
});

test("the process, status, and verify-ledger CLI commands emit non-secret JSON", async (t) => {
  const state = await temporaryPolicyState(t);
  const apiKey = "cli-secret-must-not-print";
  const mcUrl = await fakeHttpServer(t, (_request, response) => {
    response.writeHead(204);
    response.end();
  });
  const env = {
    ...process.env,
    ANTONIN_POLICY_STATE_DIR: state.stateDirectory,
    MC_URL: mcUrl,
    MC_API_KEY: apiKey,
    ANTONIN_POLICY_AGENT: "antonin-policy-engine",
    ANTONIN_CLOUD_REVIEWER: "poc-aegis-cloud",
    LOCAL_LLM_ENDPOINT: "http://127.0.0.1:11434/v1",
    LOCAL_LLM_MODEL: "qwen2.5-coder:7b",
    ANTONIN_LEASE_TTL_MS: "120000",
  };

  const status = await execFile(process.execPath, [runOncePath, "status"], {
    cwd: repositoryRoot,
    env,
  });
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.command, "status");
  assert.equal(
    statusJson.stateDirectory,
    path.join(await realpath(path.dirname(state.stateDirectory)), path.basename(state.stateDirectory)),
  );
  assert.equal(statusJson.mcUrl, mcUrl);
  assert.equal(statusJson.apiKeyConfigured, true);
  assert.equal(status.stdout.includes(apiKey), false);
  assert.equal(status.stderr.includes(apiKey), false);

  const verify = await execFile(
    process.execPath,
    [runOncePath, "verify-ledger"],
    { cwd: repositoryRoot, env },
  );
  assert.deepEqual(JSON.parse(verify.stdout), {
    command: "verify-ledger",
    valid: true,
    records: 0,
    lastHash: null,
  });

  const processResult = await execFile(
    process.execPath,
    [runOncePath, "process"],
    { cwd: repositoryRoot, env },
  );
  assert.deepEqual(JSON.parse(processResult.stdout), {
    command: "process",
    outcome: "no_task",
    processed: 0,
  });
});
