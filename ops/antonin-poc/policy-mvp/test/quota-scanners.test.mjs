import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveQuotaPolicy } from "../quota-config.mjs";
import {
  parseCodexRateLimits,
  scanClaudeRefusals,
  scanCodexRateLimits,
} from "../quota-scanners.mjs";
import { QuotaStore } from "../quota-store.mjs";

const PARIS = "Europe/Paris";
const NOW = Date.parse("2026-08-28T10:00:00.000Z");

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "antonin-quota-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** The shape observed on this machine on 2026-08-27, verbatim field names. */
function rolloutLine(overrides = {}) {
  return `${JSON.stringify({
    timestamp: "2026-08-28T09:30:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 12 } },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: {
          used_percent: 100,
          window_minutes: 10_080,
          resets_at: 1_788_272_042,
        },
        secondary: null,
        credits: { has_credits: true, unlimited: false, balance: "367.62" },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: "pro",
        rate_limit_reached_type: null,
        ...overrides,
      },
    },
  })}\n`;
}

test("a Codex rollout yields the weekly window with seconds decoded as milliseconds", async (t) => {
  const root = await temporaryDirectory(t);
  const day = path.join(root, "2026", "08", "28");
  await mkdir(day, { recursive: true });
  await writeFile(
    path.join(day, "rollout-2026-08-28T09-30-00-abc.jsonl"),
    `${JSON.stringify({ type: "session_meta", payload: { id: "s-1" } })}\n${rolloutLine()}`,
    "utf8",
  );

  const [observation, ...rest] = await scanCodexRateLimits({
    root,
    allowedRoots: [root],
    now: NOW,
  });

  assert.deepEqual(rest, []);
  assert.equal(observation.provider, "codex");
  assert.equal(observation.plan, "pro");
  assert.equal(observation.window_id, "weekly");
  assert.equal(observation.source, "codex_rollout_rate_limits");
  assert.equal(observation.used_fraction, 1);
  // §1 `resets_at` is epoch seconds; read as milliseconds it would be 1970.
  assert.equal(
    new Date(observation.resets_at).toISOString(),
    "2026-09-01T14:14:02.000Z",
  );
  assert.equal(observation.exhausted_until, observation.resets_at);
  assert.equal(
    new Date(observation.observed_at).toISOString(),
    "2026-08-28T09:30:00.000Z",
  );

  // The derived state of that reading is `exhausted`, and a heuristic source
  // can produce it because that direction is only ever more cautious.
  const store = new QuotaStore(await temporaryDirectory(t), {
    now: () => NOW,
    policy: resolveQuotaPolicy(),
  });
  assert.equal((await store.observe(observation)).state, "exhausted");
});

test("the Codex parser reads the short window and refuses to guess an unknown one", () => {
  const both = parseCodexRateLimits(
    {
      primary: { used_percent: 40, window_minutes: 10_080, resets_at: 1_788_272_042 },
      secondary: { used_percent: 90, window_minutes: 300, resets_at: 1_788_100_000 },
    },
    { observedAt: NOW, now: NOW },
  );
  assert.deepEqual(
    both.map((entry) => [entry.window_id, entry.used_fraction]),
    [
      ["weekly", 0.4],
      ["session_5h", 0.9],
    ],
  );
  // A window length the catalog does not know is skipped, never mapped by
  // guesswork; a used share below 100 % latches nothing.
  assert.equal(both[0].exhausted_until, undefined);
  assert.deepEqual(
    parseCodexRateLimits(
      { primary: { used_percent: 10, window_minutes: 60, resets_at: 1_788_272_042 } },
      { observedAt: NOW, now: NOW },
    ),
    [],
  );
  assert.deepEqual(parseCodexRateLimits(null, { observedAt: NOW, now: NOW }), []);
  assert.deepEqual(
    parseCodexRateLimits(
      { primary: { used_percent: "many", window_minutes: 10_080, resets_at: 1 } },
      { observedAt: NOW, now: NOW },
    ),
    [],
  );
  // An exhaustion whose reset has already passed latches nothing.
  assert.equal(
    parseCodexRateLimits(
      {
        primary: {
          used_percent: 100,
          window_minutes: 10_080,
          resets_at: Math.floor((NOW - 3_600_000) / 1000),
        },
      },
      { observedAt: NOW - 7_200_000, now: NOW },
    )[0].exhausted_until,
    undefined,
  );
});

test("the scan is bounded: it opens the newest files only and stops at the first record", async (t) => {
  const root = await temporaryDirectory(t);
  const day = path.join(root, "2026", "08", "28");
  await mkdir(day, { recursive: true });
  const noise = `${JSON.stringify({ type: "event_msg", payload: { type: "agent_message" } })}\n`;
  for (let index = 0; index < 300; index += 1) {
    const file = path.join(day, `rollout-${String(index).padStart(4, "0")}.jsonl`);
    // Only the newest file carries a reading; the others must not be parsed
    // once it has been found.
    await writeFile(file, index === 299 ? rolloutLine() : noise, "utf8");
  }
  const opened = [];

  const observations = await scanCodexRateLimits({
    root,
    allowedRoots: [root],
    now: NOW,
    limit: 20,
    readTail: async (filePath, maximumBytes) => {
      opened.push(filePath);
      return readFile(filePath, "utf8").then((text) => text.slice(-maximumBytes));
    },
  });

  assert.equal(observations.length, 1);
  // The newest file answers first, so exactly one file is opened.
  assert.equal(opened.length, 1);
  assert.equal(path.basename(opened[0]), "rollout-0299.jsonl");

  // With no reading anywhere, the sweep still stops at the configured cap
  // instead of turning a routing decision into a disk sweep of 300 files.
  await writeFile(path.join(day, "rollout-0299.jsonl"), noise, "utf8");
  const sweep = [];
  assert.deepEqual(
    await scanCodexRateLimits({
      root,
      allowedRoots: [root],
      now: NOW,
      limit: 20,
      readTail: async (filePath) => {
        sweep.push(filePath);
        return readFile(filePath, "utf8");
      },
    }),
    [],
  );
  assert.equal(sweep.length, 20);
});

test("a Claude refusal is read from a transcript and an expired one is ignored", async (t) => {
  const root = await temporaryDirectory(t);
  const project = path.join(root, "-Users-antonin-Documents-example");
  await mkdir(project, { recursive: true });
  const refusal = (timestamp) =>
    `${JSON.stringify({
      type: "assistant",
      timestamp,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "You've hit your session limit · resets 7:30pm (Europe/Paris)",
          },
        ],
      },
    })}\n`;
  await writeFile(
    path.join(project, "session-1.jsonl"),
    `${JSON.stringify({ type: "user", timestamp: "2026-08-28T11:00:00.000Z" })}\n${refusal("2026-08-28T11:05:00.000Z")}`,
    "utf8",
  );

  const [observation] = await scanClaudeRefusals({
    root,
    allowedRoots: [root],
    now: NOW,
    timeZone: PARIS,
  });

  assert.equal(observation.provider, "claude-code");
  assert.equal(observation.plan, "max");
  assert.equal(observation.window_id, "session_5h");
  assert.equal(observation.source, "claude_refusal_string");
  assert.equal(observation.used_fraction, 1);
  assert.equal(
    new Date(observation.exhausted_until).toISOString(),
    "2026-08-28T17:30:00.000Z",
  );
  assert.equal(
    new Date(observation.observed_at).toISOString(),
    "2026-08-28T11:05:00.000Z",
  );

  // The same refusal read after its reset says nothing about now.
  assert.deepEqual(
    await scanClaudeRefusals({
      root,
      allowedRoots: [root],
      now: Date.parse("2026-08-29T09:00:00.000Z"),
      timeZone: PARIS,
    }),
    [],
  );
});

test("a scan root outside the allowed roots is refused, symlinks included", async (t) => {
  const sandbox = await temporaryDirectory(t);
  const allowed = path.join(sandbox, "allowed");
  const outside = path.join(sandbox, "outside");
  const alias = path.join(allowed, "escape");
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, alias);

  for (const root of [outside, alias, path.join(sandbox, "missing")]) {
    await assert.rejects(
      scanCodexRateLimits({ root, allowedRoots: [allowed], now: NOW }),
      /scan root must resolve inside/,
      root,
    );
    await assert.rejects(
      scanClaudeRefusals({ root, allowedRoots: [allowed], now: NOW, timeZone: PARIS }),
      /scan root must resolve inside/,
      root,
    );
  }
  assert.deepEqual(
    await scanCodexRateLimits({ root: allowed, allowedRoots: [allowed], now: NOW }),
    [],
  );
});

test("a file escaping the root through a symlink is skipped, not read", async (t) => {
  const sandbox = await temporaryDirectory(t);
  const root = path.join(sandbox, "sessions");
  const elsewhere = path.join(sandbox, "elsewhere");
  await mkdir(root, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await writeFile(path.join(elsewhere, "secret.jsonl"), rolloutLine(), "utf8");
  await symlink(
    path.join(elsewhere, "secret.jsonl"),
    path.join(root, "linked.jsonl"),
  );
  const opened = [];

  const observations = await scanCodexRateLimits({
    root,
    allowedRoots: [root],
    now: NOW,
    readTail: async (filePath) => {
      opened.push(filePath);
      return readFile(filePath, "utf8");
    },
  });

  assert.deepEqual(observations, []);
  assert.deepEqual(opened, []);
});

test("scanned state carries no prompt, session id or project path", async (t) => {
  const codexRoot = await temporaryDirectory(t);
  const claudeRoot = await temporaryDirectory(t);
  const day = path.join(codexRoot, "2026", "08", "28");
  const project = path.join(claudeRoot, "-Users-antonin-Documents-secret-project");
  await mkdir(day, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(day, "rollout-01a040c3-65b7-7552-bd77-0478860eba0f.jsonl"),
    `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "prompt sentinel that must never be persisted",
      },
    })}\n${rolloutLine()}`,
    "utf8",
  );
  await writeFile(
    path.join(project, "session-01a040c3.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-28T11:05:00.000Z",
      message: {
        content: [
          { type: "text", text: "prompt sentinel that must never be persisted" },
          {
            type: "text",
            text: "You've hit your session limit · resets 7:30pm (Europe/Paris)",
          },
        ],
      },
    })}\n`,
    "utf8",
  );
  const stateDirectory = await temporaryDirectory(t);
  const store = new QuotaStore(stateDirectory, {
    now: () => NOW,
    policy: resolveQuotaPolicy(),
  });

  for (const observation of [
    ...(await scanCodexRateLimits({
      root: codexRoot,
      allowedRoots: [codexRoot],
      now: NOW,
    })),
    ...(await scanClaudeRefusals({
      root: claudeRoot,
      allowedRoots: [claudeRoot],
      now: NOW,
      timeZone: PARIS,
    })),
  ]) {
    await store.observe(observation);
  }
  await store.recordSnapshot(await store.snapshot(NOW));

  const written = [
    await readFile(path.join(stateDirectory, "quotas.json"), "utf8"),
    await readFile(path.join(stateDirectory, "quota-observations.jsonl"), "utf8"),
  ].join("\n");
  for (const forbidden of [
    "prompt sentinel",
    "01a040c3",
    "secret-project",
    "session limit",
    codexRoot,
    claudeRoot,
  ]) {
    assert.equal(written.includes(forbidden), false, forbidden);
  }
  assert.match(written, /"codex:pro:weekly"/);
  assert.match(written, /"claude-code:max:session_5h"/);
});
