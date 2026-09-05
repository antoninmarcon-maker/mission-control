import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";

import { MissionControlClient } from "../mc-client.mjs";

async function fakeHttpServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  return `http://127.0.0.1:${server.address().port}`;
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

function proposalInput() {
  return {
    sourceType: "event",
    sourceRef: "task:42",
    idempotencyKey: "event:42:1788560000:action",
    title: "Recover import",
    objective: "Diagnose the failed import.",
    context: "CSV parser rejected row 81",
    rationale: "The task failed and needs recovery.",
    risk: "medium",
    routeForecast: {
      runtime: "local",
      model: "qwen2.5-coder:7b",
      reason: "eligible_mechanical_task",
    },
    metadata: { source_task_id: 42 },
  };
}

test("proposal client requests the exact bounded candidate cursor and validates its response", async (t) => {
  let request;
  const baseUrl = await fakeHttpServer(t, (incoming, response) => {
    request = {
      method: incoming.method,
      url: incoming.url,
      apiKey: incoming.headers["x-api-key"],
    };
    sendJson(response, 200, {
      tasks: [{ id: 43, updated_at: 1_788_560_001 }],
      nextCursor: { updatedAt: 1_788_560_001, id: 43 },
    });
  });
  const client = new MissionControlClient({ baseUrl, apiKey: "proposal-secret" });

  const page = await client.listProposalCandidates({
    updatedAt: 1_788_560_000,
    id: 42,
  });

  assert.deepEqual(request, {
    method: "GET",
    url: "/api/tasks?proposal_candidate=1&updated_since=1788560000&after_id=42&limit=200",
    apiKey: "proposal-secret",
  });
  assert.deepEqual(page, {
    tasks: [{ id: 43, updated_at: 1_788_560_001 }],
    nextCursor: { updatedAt: 1_788_560_001, id: 43 },
  });
});

test("proposal client fails closed on malformed candidate and proposal acknowledgements", async (t) => {
  let call = 0;
  const baseUrl = await fakeHttpServer(t, async (request, response) => {
    call += 1;
    if (request.method === "POST") await readJson(request);
    sendJson(
      response,
      200,
      call === 1
        ? { tasks: {}, nextCursor: { updatedAt: 4, id: 2 } }
        : { proposal: { id: "12", revision: "" } },
    );
  });
  const client = new MissionControlClient({ baseUrl, apiKey: "proposal-secret" });

  await assert.rejects(
    client.listProposalCandidates({ updatedAt: 4, id: 2 }),
    /invalid proposal candidate response/,
  );
  await assert.rejects(
    client.createProposal(proposalInput()),
    /invalid proposal mutation response/,
  );
});

test("proposal client retries an ambiguous idempotent POST and returns the persisted acknowledgement", async (t) => {
  const requests = [];
  const input = proposalInput();
  const baseUrl = await fakeHttpServer(t, async (request, response) => {
    const body = await readJson(request);
    requests.push(body);
    if (requests.length === 1) {
      response.socket.destroy();
      return;
    }
    sendJson(response, 200, {
      proposal: { id: 91, revision: "c6f1bd11-208b-451e-898a-26776a5e6635" },
    });
  });
  const client = new MissionControlClient({ baseUrl, apiKey: "proposal-secret" });

  const acknowledgement = await client.createProposal(input);

  assert.deepEqual(requests, [input, input]);
  assert.deepEqual(acknowledgement, {
    proposal: { id: 91, revision: "c6f1bd11-208b-451e-898a-26776a5e6635" },
  });
});
