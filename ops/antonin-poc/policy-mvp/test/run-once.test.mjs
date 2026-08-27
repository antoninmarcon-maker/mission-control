import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { configFromEnvironment, processOne } from "../run-once.mjs";

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
      sendJson(response, 200, {
        success: true,
        record: { id: "token-1", sessionId: requests.at(-1).body.sessionId },
      });
      return;
    }
    sendJson(response, 200, {
      task: {
        id: 42,
        status: "review",
        assigned_to: "poc-aegis-cloud",
        resolution: "Sorted result",
        metadata: { policy_version: "antonin-policy-v0" },
      },
    });
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

test("Mission Control client reads tasks and deterministic token records for reconciliation", async (t) => {
  const requests = [];
  const baseUrl = await fakeHttpServer(t, (request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.url === "/api/tasks/42") {
      sendJson(response, 200, {
        task: { id: 42, status: "review", assigned_to: "poc-aegis-cloud" },
      });
      return;
    }
    sendJson(response, 200, {
      usage: [
        {
          id: "token-1",
          model: "qwen2.5-coder:7b",
          sessionId: "antonin-policy-engine:policy-mvp:task-42:fence-3",
          inputTokens: 12,
          outputTokens: 4,
          operation: "policy_mvp",
          taskId: 42,
        },
      ],
      total: 1,
      timeframe: "all",
    });
  });
  const client = new MissionControlClient({ baseUrl, apiKey: "secret" });

  const task = await client.getTask(42);
  const token = await client.findTokenRecord(
    "antonin-policy-engine:policy-mvp:task-42:fence-3",
  );

  assert.equal(task.status, "review");
  assert.equal(token.id, "token-1");
  assert.deepEqual(requests, [
    { method: "GET", url: "/api/tasks/42" },
    { method: "GET", url: "/api/tokens?action=list&timeframe=all" },
  ]);
});

test("Mission Control client rejects semantically invalid 2xx mutation responses", async (t) => {
  const baseUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.url === "/api/tokens") {
      await readJson(request);
      sendJson(response, 200, { success: false });
      return;
    }
    await readJson(request);
    sendJson(response, 200, {
      task: { id: 42, status: "in_progress", assigned_to: "wrong-reviewer" },
    });
  });
  const client = new MissionControlClient({ baseUrl, apiKey: "secret" });

  await assert.rejects(
    client.recordTokens({
      model: "qwen2.5-coder:7b",
      sessionId: "deterministic-session",
      inputTokens: 1,
      outputTokens: 1,
      taskId: 42,
    }),
    /invalid token mutation response/,
  );
  await assert.rejects(
    client.updateTask(42, {
      status: "review",
      assigned_to: "poc-aegis-cloud",
    }),
    /did not confirm status review/,
  );
});

test("Mission Control task mutations require exact resolution and completion metadata", async (t) => {
  let requestCount = 0;
  const baseUrl = await fakeHttpServer(t, async (request, response) => {
    const body = await readJson(request);
    requestCount += 1;
    sendJson(response, 200, {
      task: {
        id: 42,
        status: body.status,
        assigned_to: body.assigned_to,
        resolution: requestCount === 1 ? "some other completion" : body.resolution,
        metadata:
          requestCount === 1
            ? body.metadata
            : { policy_mvp: { completion_id: "some-other-id" } },
      },
    });
  });
  const client = new MissionControlClient({ baseUrl, apiKey: "secret" });
  const update = {
    status: "review",
    assigned_to: "poc-aegis-cloud",
    resolution: "exact completion",
    metadata: { policy_mvp: { completion_id: "expected-id" } },
  };

  await assert.rejects(client.updateTask(42, update), /confirm resolution/i);
  await assert.rejects(client.updateTask(42, update), /confirm completion/i);
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
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    const body = request.method === "GET" ? null : await readJson(request);
    events.push({ boundary: "mc", method: request.method, url: request.url, body });
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      tokenRecord = { id: "token-1", ...body };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    taskState = { ...taskState, ...body };
    sendJson(response, 200, { task: taskState });
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
      {
        boundary: "mc",
        method: "GET",
        url: "/api/tokens?action=list&timeframe=all",
      },
      { boundary: "mc", method: "POST", url: "/api/tokens" },
      { boundary: "mc", method: "GET", url: "/api/tasks/42" },
      { boundary: "mc", method: "PUT", url: "/api/tasks/42" },
    ],
  );
  const ollamaRequest = events[1].body;
  assert.equal(ollamaRequest.model, "qwen2.5-coder:7b");
  assert.match(ollamaRequest.messages[0].content, /text-only response/i);
  assert.match(ollamaRequest.messages[0].content, /no filesystem, network, Git/i);
  assert.match(ollamaRequest.messages[0].content, /Simple sort/);

  const tokenRequest = events[3].body;
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
  assert.equal(
    tokenRequest.sessionId,
    `antonin-policy-engine:policy-mvp:completion-${createHash("sha256")
      .update(
        [
          "42",
          createHash("sha256").update(ollamaRequest.messages[0].content).digest("hex"),
          createHash("sha256").update("alpha\nbeta").digest("hex"),
        ].join("\0"),
      )
      .digest("hex")}`,
  );
  assert.equal(tokenRequest.inputTokens, 19);
  assert.equal(tokenRequest.outputTokens, 5);
  assert.equal(tokenRequest.operation, "policy_mvp");
  assert.equal(tokenRequest.taskId, 42);
  assert.ok(Number.isFinite(tokenRequest.duration));

  const expectedInputHash = createHash("sha256")
    .update(ollamaRequest.messages[0].content)
    .digest("hex");
  const expectedOutputHash = createHash("sha256")
    .update("alpha\nbeta")
    .digest("hex");
  const expectedCompletionId = createHash("sha256")
    .update(["42", expectedInputHash, expectedOutputHash].join("\0"))
    .digest("hex");
  assert.deepEqual(events[5].body, {
    status: "review",
    assigned_to: "poc-aegis-cloud",
    resolution: "alpha\nbeta",
    metadata: {
      policy_mvp: {
        completion_id: expectedCompletionId,
        input_hash: expectedInputHash,
        output_hash: expectedOutputHash,
        policy_version: "antonin-policy-v0",
      },
    },
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

test("processOne reconciles ambiguous token and task mutations before appending success", async (t) => {
  const state = await temporaryPolicyState(t);
  const counts = { queue: 0, tokenPost: 0, taskPut: 0 };
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      counts.queue += 1;
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      counts.tokenPost += 1;
      const body = await readJson(request);
      tokenRecord = { id: "token-ambiguous", ...body };
      response.socket.destroy();
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      counts.taskPut += 1;
      const body = await readJson(request);
      taskState = { ...taskState, ...body };
      response.socket.destroy();
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });

  const result = await processOne(
    processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
  );

  assert.equal(result.outcome, "review");
  assert.deepEqual(counts, { queue: 1, tokenPost: 1, taskPut: 1 });
  assert.equal(
    tokenRecord.sessionId.startsWith(
      "antonin-policy-engine:policy-mvp:completion-",
    ),
    true,
  );
  assert.equal(taskState.status, "review");
  assert.equal(taskState.assigned_to, "poc-aegis-cloud");
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  assert.equal((await ledger.verify()).records, 1);
  const journalPath = path.join(state.stateDirectory, "completions.json");
  assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const [entry] = Object.values(journal.entries);
  assert.match(entry.completion_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(entry.phases, {
    token_confirmed: true,
    task_confirmed: true,
    receipt_confirmed: true,
  });
  assert.equal(entry.task_update.resolution, null);
});

test("an ambiguous token attempt outside the visible 100 is never posted again", async (t) => {
  const state = await temporaryPolicyState(t);
  const counts = { queue: 0, tokenPost: 0, ollama: 0 };
  const lateRecords = Array.from({ length: 100 }, (_, index) => ({
    id: `newer-${index}`,
    sessionId: `unrelated-session-${index}`,
  }));
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      counts.queue += 1;
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: lateRecords,
        total: lateRecords.length + 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      counts.tokenPost += 1;
      await readJson(request);
      response.socket.destroy();
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    counts.ollama += 1;
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });
  const config = processConfig(state, {
    mcUrl,
    localEndpoint: `${localEndpoint}/v1`,
  });

  await assert.rejects(processOne(config), /completion pending reconciliation/);
  await assert.rejects(processOne(config), /completion pending reconciliation/);

  assert.deepEqual(counts, { queue: 1, tokenPost: 1, ollama: 1 });
  const journal = JSON.parse(
    await readFile(path.join(state.stateDirectory, "completions.json"), "utf8"),
  );
  const [entry] = Object.values(journal.entries);
  assert.equal(entry.token_attempted, true);
  assert.equal(entry.token_ambiguous, true);
  assert.equal(entry.phases.token_confirmed, false);
  assert.equal((await stat(path.join(state.stateDirectory, "completions.json"))).mode & 0o777, 0o600);
});

test("overlapping same-owner invocations elect exactly one token POST winner", async (t) => {
  const state = await temporaryPolicyState(t);
  const counts = { queue: 0, tokenList: 0, tokenPost: 0, ollama: 0 };
  let releaseQueueClaims;
  const queueClaimsMayFinish = new Promise((resolve) => {
    releaseQueueClaims = resolve;
  });
  let releaseInitialTokenLists;
  const initialTokenListsMayFinish = new Promise((resolve) => {
    releaseInitialTokenLists = resolve;
  });
  let announceFirstTokenPost;
  const firstTokenPostStarted = new Promise((resolve) => {
    announceFirstTokenPost = resolve;
  });
  let releaseFirstTokenPost;
  const firstTokenPostMayFinish = new Promise((resolve) => {
    releaseFirstTokenPost = resolve;
  });
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      counts.queue += 1;
      if (counts.queue === 2) releaseQueueClaims();
      await queueClaimsMayFinish;
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      counts.tokenList += 1;
      if (counts.tokenList <= 2) {
        if (counts.tokenList === 2) releaseInitialTokenLists();
        await initialTokenListsMayFinish;
      }
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      counts.tokenPost += 1;
      const body = await readJson(request);
      announceFirstTokenPost();
      await firstTokenPostMayFinish;
      tokenRecord = { id: `token-overlap-${counts.tokenPost}`, ...body };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      taskState = { ...taskState, ...(await readJson(request)) };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    counts.ollama += 1;
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });
  const config = processConfig(state, {
    mcUrl,
    localEndpoint: `${localEndpoint}/v1`,
  });

  const invocations = Promise.allSettled([processOne(config), processOne(config)]);
  await firstTokenPostStarted;
  releaseFirstTokenPost();
  const results = await invocations;

  assert.equal(counts.queue, 2);
  assert.equal(counts.ollama, 2);
  assert.equal(counts.tokenPost, 1);
  assert.equal(results.some((result) => result.status === "fulfilled"), true);
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  assert.equal((await ledger.verify()).records, 1);
});

test("the losing token claimant yields instead of inventing an ambiguity", async (t) => {
  const state = await temporaryPolicyState(t);
  const counts = { queue: 0, tokenList: 0, tokenPost: 0, ollama: 0 };
  let releaseQueueClaims;
  const queueClaimsMayFinish = new Promise((resolve) => {
    releaseQueueClaims = resolve;
  });
  let releaseInitialTokenLists;
  const initialTokenListsMayFinish = new Promise((resolve) => {
    releaseInitialTokenLists = resolve;
  });
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      counts.queue += 1;
      if (counts.queue === 2) releaseQueueClaims();
      await queueClaimsMayFinish;
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      counts.tokenList += 1;
      if (counts.tokenList <= 2) {
        if (counts.tokenList === 2) releaseInitialTokenLists();
        await initialTokenListsMayFinish;
      }
      // The posted session never becomes visible in the bounded window, so a
      // read-back can only ever report absence here.
      sendJson(response, 200, { usage: [], total: 0, timeframe: "all" });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      counts.tokenPost += 1;
      const body = await readJson(request);
      sendJson(response, 200, {
        success: true,
        record: { id: `token-contended-${counts.tokenPost}`, ...body },
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      taskState = { ...taskState, ...(await readJson(request)) };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    counts.ollama += 1;
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });
  const config = processConfig(state, {
    mcUrl,
    localEndpoint: `${localEndpoint}/v1`,
  });

  const results = await Promise.allSettled([
    processOne(config),
    processOne(config),
  ]);

  assert.equal(
    results.every((result) => result.status === "fulfilled"),
    true,
    `both invocations must settle without an operator alarm: ${results
      .map((result) => result.reason?.message ?? result.value?.outcome)
      .join(" | ")}`,
  );
  assert.deepEqual(
    results.map((result) => result.value.outcome).sort(),
    ["contended", "review"],
  );
  const contended = results.find(
    (result) => result.value.outcome === "contended",
  ).value;
  assert.equal(contended.processed, 0);
  assert.equal(contended.taskId, 42);
  assert.match(contended.completionId, /^[a-f0-9]{64}$/);
  // The loser stops at the compare-and-set: no read-back, no post, no mutation.
  assert.deepEqual(counts, { queue: 2, tokenList: 2, tokenPost: 1, ollama: 2 });
  assert.equal(taskState.status, "review");
  assert.equal(taskState.assigned_to, "poc-aegis-cloud");
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  assert.equal((await ledger.verify()).records, 1);
  const journal = JSON.parse(
    await readFile(path.join(state.stateDirectory, "completions.json"), "utf8"),
  );
  const entries = Object.values(journal.entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].completion_id, contended.completionId);
  assert.equal(entries[0].token_attempted, true);
  assert.equal(entries[0].token_ambiguous, false);
  assert.equal(entries[0].phases.receipt_confirmed, true);
  await assertLeaseReleased(state);
});

test("an unrelated review cannot confirm this completion and the exact metadata is preserved", async (t) => {
  const state = await temporaryPolicyState(t);
  let tokenRecord = null;
  let taskPut = null;
  let taskState = {
    ...queuedTask({ metadata: { existing: "keep", policy_mvp: { previous: "keep" } } }),
    status: "review",
    assigned_to: "poc-aegis-cloud",
    resolution: "unrelated result",
    metadata: {
      existing: "keep",
      policy_mvp: { completion_id: "unrelated", previous: "keep" },
    },
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(
        response,
        200,
        queueResponse(
          queuedTask({ metadata: { existing: "keep", policy_mvp: { previous: "keep" } } }),
        ),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      const body = await readJson(request);
      tokenRecord = { id: "token-exact", ...body };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      taskPut = await readJson(request);
      taskState = { ...taskState, ...taskPut };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });

  const result = await processOne(
    processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
  );
  const journal = JSON.parse(
    await readFile(path.join(state.stateDirectory, "completions.json"), "utf8"),
  );
  const [entry] = Object.values(journal.entries);

  assert.equal(result.outcome, "review");
  assert.equal(taskPut.resolution, "alpha\nbeta");
  assert.equal(taskPut.metadata.existing, "keep");
  assert.equal(taskPut.metadata.policy_mvp.previous, "keep");
  assert.deepEqual(taskPut.metadata.policy_mvp, {
    previous: "keep",
    completion_id: entry.completion_id,
    input_hash: entry.receipt.input_hash,
    output_hash: entry.receipt.output_hash,
    policy_version: entry.receipt.policy_version,
  });
  assert.equal(taskState.metadata.policy_mvp.completion_id, entry.completion_id);
});

test("the completion PUT merges metadata fetched immediately before the mutation", async (t) => {
  const state = await temporaryPolicyState(t);
  const requests = [];
  let tokenRecord = null;
  let taskPut = null;
  let taskState = {
    ...queuedTask({ metadata: { queued_key: "queued" } }),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
    metadata: {
      queued_key: "queued",
      concurrent_key: "fresh",
      policy_mvp: { concurrent_policy_key: "keep" },
    },
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    requests.push({ method: request.method, url: request.url });
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(
        response,
        200,
        queueResponse(queuedTask({ metadata: { queued_key: "queued" } })),
      );
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      tokenRecord = { id: "token-fresh-metadata", ...(await readJson(request)) };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      taskPut = await readJson(request);
      taskState = { ...taskState, ...taskPut };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });

  await processOne(
    processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
  );

  assert.equal(taskPut.metadata.queued_key, "queued");
  assert.equal(taskPut.metadata.concurrent_key, "fresh");
  assert.equal(taskPut.metadata.policy_mvp.concurrent_policy_key, "keep");
  assert.match(taskPut.metadata.policy_mvp.completion_id, /^[a-f0-9]{64}$/);
  assert.deepEqual(requests.slice(-2), [
    { method: "GET", url: "/api/tasks/42" },
    { method: "PUT", url: "/api/tasks/42" },
  ]);
});

test("a failed fresh task read prevents a stale metadata PUT", async (t) => {
  const state = await temporaryPolicyState(t);
  let tokenRecord = null;
  let taskPutCount = 0;
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      tokenRecord = { id: "token-failed-task-read", ...(await readJson(request)) };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 503, { error: "task read unavailable" });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      taskPutCount += 1;
      const body = await readJson(request);
      sendJson(response, 200, { task: { ...queuedTask(), ...body } });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });

  await assert.rejects(
    processOne(
      processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
    ),
    /completion pending reconciliation.*task read unavailable/i,
  );
  assert.equal(taskPutCount, 0);
});

test("a delayed Mission Control request does not hold the global lease lock", async (t) => {
  const state = await temporaryPolicyState(t);
  let announceTokenList;
  const tokenListStarted = new Promise((resolve) => {
    announceTokenList = resolve;
  });
  let releaseTokenList;
  const tokenListMayFinish = new Promise((resolve) => {
    releaseTokenList = resolve;
  });
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      announceTokenList();
      await tokenListMayFinish;
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      const body = await readJson(request);
      tokenRecord = { id: "token-delayed", ...body };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      taskState = { ...taskState, ...(await readJson(request)) };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });

  const processing = processOne(
    processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
  );
  await tokenListStarted;
  const contender = new LeaseStore(state.stateDirectory, {
    ...state.stateStoreOptions,
    lockRetryMs: 1,
    lockMaxAttempts: 3,
  });
  const attempt = await contender
    .acquire("independent-task", "independent-owner", {
      ttlMs: 10_000,
      taskVersion: 1,
    })
    .then((lease) => ({ lease }), (error) => ({ error }));
  releaseTokenList();
  await processing;

  assert.equal(attempt.error, undefined);
  assert.equal(attempt.lease.task_id, "independent-task");
});

test("processOne resumes the first unconfirmed completion phase without re-running Ollama", async (t) => {
  const state = await temporaryPolicyState(t);
  const counts = { queue: 0, tokenPost: 0, taskPut: 0, ollama: 0 };
  let allowTaskPut = false;
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      counts.queue += 1;
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      counts.tokenPost += 1;
      const body = await readJson(request);
      tokenRecord = { id: "token-resumed", ...body };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      counts.taskPut += 1;
      const body = await readJson(request);
      if (!allowTaskPut) {
        sendJson(response, 503, { error: "temporarily unavailable" });
        return;
      }
      taskState = { ...taskState, ...body };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    counts.ollama += 1;
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });
  const config = processConfig(state, {
    mcUrl,
    localEndpoint: `${localEndpoint}/v1`,
  });

  await assert.rejects(processOne(config), /completion pending reconciliation/);
  assert.deepEqual(counts, { queue: 1, tokenPost: 1, taskPut: 1, ollama: 1 });
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  assert.equal((await ledger.verify()).records, 0);

  allowTaskPut = true;
  const result = await processOne(config);

  assert.equal(result.outcome, "review");
  assert.deepEqual(counts, { queue: 1, tokenPost: 1, taskPut: 2, ollama: 1 });
  assert.equal((await ledger.verify()).records, 1);
  await assertLeaseReleased(state);
});

test("confirmed Mission Control mutations remain pending when the receipt ledger is corrupt", async (t) => {
  const state = await temporaryPolicyState(t);
  await mkdir(state.stateDirectory, { recursive: true });
  await writeFile(path.join(state.stateDirectory, "receipts.jsonl"), "not-json\n", {
    mode: 0o600,
  });
  const updates = [];
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      const body = await readJson(request);
      tokenRecord = { id: "token-corrupt-ledger", ...body };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      const body = await readJson(request);
      updates.push(body);
      taskState = { ...taskState, ...body };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });

  await assert.rejects(
    processOne(
      processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
    ),
    /completion pending reconciliation.*malformed JSON/i,
  );

  assert.match(
    tokenRecord.sessionId,
    /^antonin-policy-engine:policy-mvp:completion-[a-f0-9]{64}$/,
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "review");
  assert.equal(updates[0].assigned_to, "poc-aegis-cloud");
  assert.equal(updates[0].resolution, "alpha\nbeta");
  assert.match(updates[0].metadata.policy_mvp.completion_id, /^[a-f0-9]{64}$/);
  const journal = JSON.parse(
    await readFile(path.join(state.stateDirectory, "completions.json"), "utf8"),
  );
  const [entry] = Object.values(journal.entries);
  assert.deepEqual(entry.phases, {
    token_confirmed: true,
    task_confirmed: true,
    receipt_confirmed: false,
  });
});

test("a release cleanup failure cannot reclassify a confirmed completion", async (t) => {
  const state = await temporaryPolicyState(t);
  const updates = [];
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      const body = await readJson(request);
      tokenRecord = { id: "token-release-failure", ...body };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      const body = await readJson(request);
      updates.push(body);
      taskState = { ...taskState, ...body };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });
  const realLeaseStore = new LeaseStore(
    state.stateDirectory,
    state.stateStoreOptions,
  );
  const leaseStore = {
    acquire: realLeaseStore.acquire.bind(realLeaseStore),
    renew: realLeaseStore.renew.bind(realLeaseStore),
    withCompletionGuard:
      realLeaseStore.withCompletionGuard.bind(realLeaseStore),
    release: async () => {
      throw new Error("injected release cleanup failure");
    },
  };

  const result = await processOne(
    processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
    { leaseStore },
  );

  assert.equal(result.outcome, "review");
  assert.match(result.cleanupWarning, /release cleanup failure/);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "review");
  assert.equal(updates[0].assigned_to, "poc-aegis-cloud");
  assert.equal(updates[0].resolution, "alpha\nbeta");
  assert.match(updates[0].metadata.policy_mvp.completion_id, /^[a-f0-9]{64}$/);
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  assert.equal((await ledger.verify()).records, 1);
  const [receipt] = (await readFile(ledger.filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  assert.equal(receipt.outcome, "success");
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

test("lease acquisition contention causes no compensating Mission Control mutation", async (t) => {
  const state = await temporaryPolicyState(t);
  const holder = new LeaseStore(state.stateDirectory, state.stateStoreOptions);
  await holder.acquire("42", "replacement-owner", {
    ttlMs: 60_000,
    taskVersion: 7,
  });
  const counts = { queue: 0, taskPut: 0, ollama: 0 };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      counts.queue += 1;
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "PUT") {
      counts.taskPut += 1;
      await readJson(request);
      sendJson(response, 200, { task: { id: 42, status: "awaiting_owner" } });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    counts.ollama += 1;
    sendJson(response, 500, { error: "must not run" });
  });

  await assert.rejects(
    processOne(
      processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
    ),
    /lease is unavailable/,
  );

  assert.deepEqual(counts, { queue: 1, taskPut: 0, ollama: 0 });
  assert.equal(
    (await holder.assertCurrent("42", "replacement-owner", 1)).fencing_token,
    1,
  );
});

test("takeover between failure receipt and recovery blocks compensation and release", async (t) => {
  const state = await temporaryPolicyState(t);
  let clock = 10;
  const leaseOptions = { ...state.stateStoreOptions, now: () => clock };
  const holder = new LeaseStore(state.stateDirectory, leaseOptions);
  const contender = new LeaseStore(state.stateDirectory, leaseOptions);
  let releaseCalls = 0;
  let injectedTakeover = null;
  const leaseStore = {
    acquire: holder.acquire.bind(holder),
    renew: holder.renew.bind(holder),
    withCompletionGuard: async (...arguments_) => {
      const result = await holder.withCompletionGuard(...arguments_);
      if (injectedTakeover === null) {
        clock += 1_000_000;
        injectedTakeover = await contender.acquire("42", "replacement-owner", {
          ttlMs: 60_000,
          taskVersion: 7,
        });
      }
      return result;
    },
    release: async (...arguments_) => {
      releaseCalls += 1;
      return holder.release(...arguments_);
    },
  };
  const taskUpdates = [];
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "PUT") {
      taskUpdates.push(await readJson(request));
      sendJson(response, 200, { task: { id: 42, status: "awaiting_owner" } });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    sendJson(response, 500, { error: "local model unavailable" });
  });

  await assert.rejects(
    processOne(
      processConfig(state, { mcUrl, localEndpoint: `${localEndpoint}/v1` }),
      { leaseStore, now: () => clock, networkTimeoutMs: 20 },
    ),
    /lease is not current/,
  );

  assert.equal(injectedTakeover.fencing_token, 2);
  assert.deepEqual(taskUpdates, []);
  assert.equal(releaseCalls, 0);
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  const [receipt] = (await readFile(ledger.filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  assert.equal(receipt.outcome, "failure");
  assert.equal(
    (await contender.assertCurrent("42", "replacement-owner", 2)).fencing_token,
    2,
  );
});

test("a replaced fencing token blocks receipt, token post, and review completion", async (t) => {
  const state = await temporaryPolicyState(t);
  let clock = 10;
  const leaseOptions = { ...state.stateStoreOptions, now: () => clock };
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
  const holder = new LeaseStore(state.stateDirectory, leaseOptions);
  let releaseCalls = 0;
  const leaseStore = {
    acquire: holder.acquire.bind(holder),
    renew: holder.renew.bind(holder),
    withCompletionGuard: holder.withCompletionGuard.bind(holder),
    release: async (...arguments_) => {
      releaseCalls += 1;
      return holder.release(...arguments_);
    },
  };
  const contender = new LeaseStore(state.stateDirectory, leaseOptions);
  const localEndpoint = await fakeHttpServer(t, async (_request, response) => {
    clock += 1_000_000;
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
      { leaseStore, now: () => clock, networkTimeoutMs: 20 },
    ),
    /lease is not current/,
  );

  assert.deepEqual(mcRequests, [
    {
      method: "GET",
      url: "/api/tasks/queue?agent=antonin-policy-engine&max_capacity=1",
      body: null,
    },
  ]);
  assert.equal(releaseCalls, 0);
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

test("an expired pending completion is rebound to fencing token 2 and resumed", async (t) => {
  const state = await temporaryPolicyState(t);
  let clock = 100;
  const leaseStore = new LeaseStore(state.stateDirectory, {
    ...state.stateStoreOptions,
    now: () => clock,
  });
  const counts = { queue: 0, tokenPost: 0, taskPut: 0, ollama: 0 };
  let allowTaskUpdate = false;
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      counts.queue += 1;
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      counts.tokenPost += 1;
      tokenRecord = { id: "token-before-expiry", ...(await readJson(request)) };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      counts.taskPut += 1;
      const body = await readJson(request);
      if (!allowTaskUpdate) {
        sendJson(response, 503, { error: "temporarily unavailable" });
        return;
      }
      taskState = { ...taskState, ...body };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    counts.ollama += 1;
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });
  const config = processConfig(state, {
    mcUrl,
    localEndpoint: `${localEndpoint}/v1`,
    leaseTtlMs: 25,
  });
  const dependencies = { leaseStore, now: () => clock, networkTimeoutMs: 20 };

  await assert.rejects(
    processOne(config, dependencies),
    /completion pending reconciliation/,
  );
  const before = JSON.parse(
    await readFile(path.join(state.stateDirectory, "completions.json"), "utf8"),
  );
  const [pending] = Object.values(before.entries);
  assert.equal(pending.fencing_token, 1);
  assert.equal(pending.phases.token_confirmed, true);

  clock += 1_000_000;
  allowTaskUpdate = true;
  const result = await processOne(config, dependencies);
  const after = JSON.parse(
    await readFile(path.join(state.stateDirectory, "completions.json"), "utf8"),
  );
  const [completed] = Object.values(after.entries);

  assert.equal(result.outcome, "review");
  assert.equal(result.reconciled, true);
  assert.deepEqual(counts, { queue: 1, tokenPost: 1, taskPut: 2, ollama: 1 });
  assert.equal(completed.completion_id, pending.completion_id);
  assert.equal(completed.token_session_id, pending.token_session_id);
  assert.equal(completed.fencing_token, 2);
  assert.equal(completed.receipt.fencing_token, 2);
  assert.equal(completed.receipt.lease_id, "42:2");
  assert.equal(completed.phases.receipt_confirmed, true);
  await assertLeaseReleased(state);
});

test("receipt crash recovery reuses the stable token-1 success after token-2 adoption", async (t) => {
  const state = await temporaryPolicyState(t);
  let clock = 100;
  const holder = new LeaseStore(state.stateDirectory, {
    ...state.stateStoreOptions,
    now: () => clock,
  });
  let suppressRelease = true;
  const leaseStore = {
    acquire: holder.acquire.bind(holder),
    renew: holder.renew.bind(holder),
    withCompletionGuard: holder.withCompletionGuard.bind(holder),
    release: (...arguments_) =>
      suppressRelease ? Promise.resolve(false) : holder.release(...arguments_),
  };
  const counts = { queue: 0, tokenPost: 0, taskPut: 0, ollama: 0 };
  let tokenRecord = null;
  let taskState = {
    ...queuedTask(),
    status: "in_progress",
    assigned_to: "antonin-policy-engine",
  };
  const mcUrl = await fakeHttpServer(t, async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/tasks/queue?")) {
      counts.queue += 1;
      sendJson(response, 200, queueResponse(queuedTask()));
      return;
    }
    if (request.method === "GET" && request.url === "/api/tokens?action=list&timeframe=all") {
      sendJson(response, 200, {
        usage: tokenRecord === null ? [] : [tokenRecord],
        total: tokenRecord === null ? 0 : 1,
        timeframe: "all",
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/tokens") {
      counts.tokenPost += 1;
      tokenRecord = { id: "token-crash-boundary", ...(await readJson(request)) };
      sendJson(response, 200, { success: true, record: tokenRecord });
      return;
    }
    if (request.method === "GET" && request.url === "/api/tasks/42") {
      sendJson(response, 200, { task: taskState });
      return;
    }
    if (request.method === "PUT" && request.url === "/api/tasks/42") {
      counts.taskPut += 1;
      taskState = { ...taskState, ...(await readJson(request)) };
      sendJson(response, 200, { task: taskState });
      return;
    }
    sendJson(response, 404, { error: "unexpected route" });
  });
  const localEndpoint = await fakeHttpServer(t, (_request, response) => {
    counts.ollama += 1;
    sendJson(response, 200, {
      choices: [{ message: { content: "alpha\nbeta" } }],
      usage: { prompt_tokens: 19, completion_tokens: 5 },
    });
  });
  const config = processConfig(state, {
    mcUrl,
    localEndpoint: `${localEndpoint}/v1`,
    leaseTtlMs: 25,
  });
  const dependencies = { leaseStore, now: () => clock, networkTimeoutMs: 20 };

  const first = await processOne(config, dependencies);
  assert.match(first.cleanupWarning, /did not release/);
  const ledger = new ReceiptLedger(state.stateDirectory, state.stateStoreOptions);
  const [tokenOneReceipt] = (await readFile(ledger.filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  assert.equal(tokenOneReceipt.fencing_token, 1);

  const journalPath = path.join(state.stateDirectory, "completions.json");
  const crashedJournal = JSON.parse(await readFile(journalPath, "utf8"));
  const [crashedEntry] = Object.values(crashedJournal.entries);
  crashedEntry.phases.receipt_confirmed = false;
  crashedEntry.receipt_hash = null;
  await writeFile(journalPath, `${JSON.stringify(crashedJournal)}\n`, {
    mode: 0o600,
  });

  clock += 1_000_000;
  suppressRelease = false;
  const recovered = await processOne(config, dependencies);
  const receipts = (await readFile(ledger.filePath, "utf8"))
    .trimEnd()
    .split("\n")
    .map(JSON.parse);
  const recoveredJournal = JSON.parse(await readFile(journalPath, "utf8"));
  const [recoveredEntry] = Object.values(recoveredJournal.entries);

  assert.equal(recovered.outcome, "review");
  assert.equal(recovered.reconciled, true);
  assert.deepEqual(counts, { queue: 1, tokenPost: 1, taskPut: 1, ollama: 1 });
  assert.equal(receipts.length, 1);
  assert.equal(recoveredEntry.fencing_token, 2);
  assert.equal(recoveredEntry.receipt.fencing_token, 1);
  assert.equal(recoveredEntry.receipt_hash, tokenOneReceipt.record_hash);
  assert.equal(recoveredEntry.phases.receipt_confirmed, true);
  await assert.rejects(
    holder.assertCurrent("42", "antonin-policy-engine", 2),
    /lease is not current/,
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

test("environment config rejects Mission Control and POC runtime paths including symlinks", async (t) => {
  const state = await temporaryPolicyState(t);
  const sandbox = path.dirname(path.dirname(state.stateDirectory));
  const pocRuntime = path.join(sandbox, "mc-poc-runtime");
  const pocRuntimeAlias = path.join(sandbox, "mc-poc-runtime-alias");
  await mkdir(pocRuntime);
  await symlink(pocRuntime, pocRuntimeAlias);
  const baseEnvironment = {
    ANTONIN_POLICY_STATE_DIR: path.join(sandbox, "safe-policy-state"),
    MC_URL: "http://127.0.0.1:4318",
    MC_API_KEY: "secret",
    LOCAL_LLM_ENDPOINT: "http://127.0.0.1:11434/v1",
  };

  for (const candidate of [
    pocRuntime,
    path.join(pocRuntime, "policy-state"),
    path.join(pocRuntimeAlias, "nested", "policy-state"),
  ]) {
    assert.throws(
      () =>
        configFromEnvironment({
          ...baseEnvironment,
          ANTONIN_POLICY_STATE_DIR: candidate,
          MC_POC_STATE_DIR: pocRuntime,
        }),
      /external to the repository and Mission Control runtime/,
      candidate,
    );
  }

  assert.throws(
    () =>
      configFromEnvironment({
        ...baseEnvironment,
        ANTONIN_POLICY_STATE_DIR: path.join(pocRuntime, "policy-state"),
        MISSION_CONTROL_DATA_DIR: pocRuntime,
      }),
    /external to the repository and Mission Control runtime/,
  );
});

test("CLI fails closed when policy state is inside MC_POC_STATE_DIR", async (t) => {
  const state = await temporaryPolicyState(t);
  const pocRuntime = path.join(
    path.dirname(path.dirname(state.stateDirectory)),
    "cli-mc-poc-runtime",
  );
  await mkdir(pocRuntime);
  const apiKey = "cli-runtime-secret";
  const environment = {
    ...process.env,
    ANTONIN_POLICY_STATE_DIR: path.join(pocRuntime, "policy-state"),
    MC_POC_STATE_DIR: pocRuntime,
    MISSION_CONTROL_DATA_DIR: "",
    MC_URL: "http://127.0.0.1:4318",
    MC_API_KEY: apiKey,
    LOCAL_LLM_ENDPOINT: "http://127.0.0.1:11434/v1",
  };

  await assert.rejects(
    execFile(process.execPath, [runOncePath, "status"], {
      cwd: repositoryRoot,
      env: environment,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /external to the repository and Mission Control runtime/);
      assert.equal(error.stderr.includes(apiKey), false);
      assert.equal(error.stdout, "");
      return true;
    },
  );
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
