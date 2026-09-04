import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CloudSubprocessRunner,
  parseQuotaRefusal,
  resolveWallClockInstant,
} from "../cloud-runner.mjs";
import { classifyFailure } from "../policy-core.mjs";

const PARIS = "Europe/Paris";
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

async function fixtureDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "antonin-cloud-runner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * The binaries are mocked, always: no test in this suite may reach the real
 * `claude` or `codex` CLI, because a real call would spend Antonin's quota.
 * The mock is a Node script, so the spawn path, the stdin handover, the
 * environment allow-list, the output cap and the timeout are all exercised for
 * real against a process we control.
 */
async function mockBinary(t, source) {
  const directory = await fixtureDirectory(t);
  const scriptPath = path.join(directory, "mock-cli.mjs");
  await writeFile(scriptPath, source, { encoding: "utf8", mode: 0o700 });
  return { scriptPath, directory };
}

function runnerFor(scriptPath, options = {}) {
  return new CloudSubprocessRunner({
    provider: "claude-code",
    command: process.execPath,
    args: [scriptPath, "--print"],
    workingDirectory: options.workingDirectory ?? tmpdir(),
    timeoutMs: options.timeoutMs ?? 10_000,
    now: options.now ?? (() => Date.parse("2026-08-28T12:00:00.000Z")),
    timeZone: PARIS,
    outputFormat: options.outputFormat ?? "claude_json",
    maxOutputBytes: options.maxOutputBytes,
  });
}

test("a cloud run takes its prompt on stdin and returns text with token counts", async (t) => {
  const { scriptPath } = await mockBinary(
    t,
    `import { readFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "alpha\\nbeta",
    usage: { input_tokens: 21, output_tokens: 4 },
    argv: process.argv.slice(2),
    stdin,
  }),
);
`,
  );

  const completion = await runnerFor(scriptPath).complete("sort these labels");

  assert.deepEqual(completion, {
    text: "alpha\nbeta",
    inputTokens: 21,
    outputTokens: 4,
  });
});

test("the prompt never reaches argv and the child inherits no secret", async (t) => {
  const { scriptPath } = await mockBinary(
    t,
    `import { readFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
process.stdout.write(
  JSON.stringify({
    result: JSON.stringify({
      argv: process.argv.slice(2),
      stdin,
      env: Object.keys(process.env).sort(),
      cwd: process.cwd(),
    }),
    usage: { input_tokens: 1, output_tokens: 1 },
  }),
);
`,
  );
  const workingDirectory = await fixtureDirectory(t);
  const secretEnvironment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MC_API_KEY: "mc-secret-must-not-leak",
    ANTHROPIC_API_KEY: "anthropic-secret-must-not-leak",
    OPENAI_API_KEY: "openai-secret-must-not-leak",
    ANTONIN_POLICY_STATE_DIR: "/tmp/should-not-be-inherited",
  };

  const completion = await new CloudSubprocessRunner({
    provider: "claude-code",
    command: process.execPath,
    args: [scriptPath, "--print"],
    workingDirectory,
    timeoutMs: 10_000,
    outputFormat: "claude_json",
    environment: secretEnvironment,
  }).complete("prompt sentinel");
  const observed = JSON.parse(completion.text);

  assert.deepEqual(observed.argv, ["--print"]);
  assert.equal(observed.argv.join(" ").includes("prompt sentinel"), false);
  assert.equal(observed.stdin, "prompt sentinel");
  // macOS injects `__CF_USER_TEXT_ENCODING` into every child regardless of the
  // environment handed to spawn; everything else must come from the allow-list.
  assert.deepEqual(
    observed.env.filter((name) => !name.startsWith("__")).sort(),
    ["HOME", "PATH"],
  );
  assert.equal(observed.env.includes("MC_API_KEY"), false);
  // §5.8: no paid API-key route. Dropping the key also stops a subscription
  // rung from silently becoming metered API spend.
  assert.equal(observed.env.includes("ANTHROPIC_API_KEY"), false);
  assert.equal(observed.cwd, await realpath(workingDirectory));
  assert.equal(observed.cwd.startsWith(path.resolve(testDirectory, "../../..")), false);
});

test("a refusal becomes a typed quota exhaustion carrying the parsed reset", async (t) => {
  const { scriptPath } = await mockBinary(
    t,
    `process.stdout.write(
  JSON.stringify({
    result: "You've hit your session limit \\u00b7 resets 7:30pm (Europe/Paris)",
    usage: { input_tokens: 3, output_tokens: 2 },
  }),
);
`,
  );
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  const error = await runnerFor(scriptPath, { now: () => now })
    .complete("sort these labels")
    .catch((thrown) => thrown);

  assert.equal(error.failureKind, "cloud_quota_exhausted");
  assert.equal(classifyFailure(error), "cloud_quota_exhausted");
  assert.equal(error.provider, "claude-code");
  assert.equal(error.quotaWindowId, "session_5h");
  assert.equal(
    new Date(error.resetsAt).toISOString(),
    "2026-08-28T17:30:00.000Z",
  );
  // The runner must not re-emit what it read: no model text in the message.
  assert.equal(/session limit|resets/.test(error.message), false);
  assert.match(error.message, /^claude-code refused the request: quota exhausted$/);
});

test("a missing binary is a missing subscription and never a retry", async (t) => {
  const directory = await fixtureDirectory(t);
  const error = await new CloudSubprocessRunner({
    provider: "codex",
    command: path.join(directory, "definitely-not-installed"),
    args: ["exec", "-"],
    workingDirectory: directory,
    timeoutMs: 5_000,
  })
    .complete("sort these labels")
    .catch((thrown) => thrown);

  assert.equal(error.failureKind, "cloud_auth_missing");
  assert.equal(classifyFailure(error), "cloud_auth_missing");
  assert.equal(error.message.includes(directory), false);
});

test("a run that never answers is killed and classified transient", async (t) => {
  const { scriptPath } = await mockBinary(
    t,
    `setTimeout(() => process.stdout.write("too late"), 60_000);
`,
  );

  const started = Date.now();
  const error = await runnerFor(scriptPath, { timeoutMs: 300 })
    .complete("sort these labels")
    .catch((thrown) => thrown);

  assert.equal(error.failureKind, "cloud_transient");
  assert.equal(classifyFailure(error), "cloud_transient");
  assert.equal(Date.now() - started < 30_000, true);
});

test("an unclassifiable exit and an oversized answer both fail closed", async (t) => {
  const { scriptPath: failing } = await mockBinary(
    t,
    `process.stderr.write("stderr sentinel with an api key value");
process.exit(3);
`,
  );
  const exitError = await runnerFor(failing)
    .complete("sort these labels")
    .catch((thrown) => thrown);
  assert.equal(exitError.failureKind, undefined);
  assert.equal(classifyFailure(exitError, { provider: "claude-code" }), "unknown");
  assert.equal(exitError.message.includes("stderr sentinel"), false);
  assert.match(exitError.message, /^claude-code runner exited with code 3$/);

  const { scriptPath: chatty } = await mockBinary(
    t,
    `process.stdout.write("x".repeat(20_000));
setTimeout(() => {}, 30_000);
`,
  );
  const capError = await runnerFor(chatty, { maxOutputBytes: 1_024 })
    .complete("sort these labels")
    .catch((thrown) => thrown);
  assert.equal(capError.failureKind, undefined);
  assert.equal(classifyFailure(capError, { provider: "claude-code" }), "unknown");
  assert.match(capError.message, /exceeded 1024 bytes/);
  assert.equal(capError.message.includes("xxxx"), false);
});

test("plain-text output is returned as it stands with unknown token counts", async (t) => {
  const { scriptPath } = await mockBinary(
    t,
    `process.stdout.write("alpha\\nbeta\\n");
`,
  );

  const completion = await runnerFor(scriptPath, {
    outputFormat: "text",
  }).complete("sort these labels");

  assert.deepEqual(completion, {
    text: "alpha\nbeta",
    inputTokens: 0,
    outputTokens: 0,
  });
});

test("a refusal in plain-text output is recognised too", async (t) => {
  const { scriptPath } = await mockBinary(
    t,
    `process.stdout.write("You've hit your weekly limit \\u00b7 resets 9:00am\\n");
`,
  );
  const now = Date.parse("2026-08-28T12:00:00.000Z");

  const error = await runnerFor(scriptPath, {
    outputFormat: "text",
    now: () => now,
  })
    .complete("sort these labels")
    .catch((thrown) => thrown);

  assert.equal(error.failureKind, "cloud_quota_exhausted");
  assert.equal(error.quotaWindowId, "weekly");
  assert.equal(
    new Date(error.resetsAt).toISOString(),
    "2026-08-29T07:00:00.000Z",
  );
});

test("refusal parsing resolves a wall clock, rolls over, and survives DST", () => {
  const observedAt = Date.parse("2026-08-28T12:00:00.000Z"); // 14:00 Paris
  const sameDay = parseQuotaRefusal(
    "You've hit your session limit · resets 7:30pm (Europe/Paris)",
    { now: observedAt, timeZone: PARIS },
  );
  assert.equal(sameDay.windowId, "session_5h");
  assert.equal(new Date(sameDay.resetsAt).toISOString(), "2026-08-28T17:30:00.000Z");

  // Observed at 20:00 local, so 7:30pm has passed: it means tomorrow.
  const rollover = parseQuotaRefusal(
    "You've hit your session limit · resets 7:30pm (Europe/Paris)",
    { now: Date.parse("2026-08-28T18:00:00.000Z"), timeZone: PARIS },
  );
  assert.equal(
    new Date(rollover.resetsAt).toISOString(),
    "2026-08-29T17:30:00.000Z",
  );

  // A 24-hour reading and a refusal with no time at all.
  assert.equal(
    new Date(
      parseQuotaRefusal("You've hit your session limit · resets 23:15", {
        now: observedAt,
        timeZone: PARIS,
      }).resetsAt,
    ).toISOString(),
    "2026-08-28T21:15:00.000Z",
  );
  const timeless = parseQuotaRefusal("You've hit your usage limit", {
    now: observedAt,
    timeZone: PARIS,
  });
  assert.equal(timeless.windowId, "session_5h");
  assert.equal(timeless.resetsAt, null);

  assert.equal(parseQuotaRefusal("alpha\nbeta", { now: observedAt, timeZone: PARIS }), null);
  assert.equal(parseQuotaRefusal("", { now: observedAt, timeZone: PARIS }), null);

  // Autumn DST in Paris: 2026-10-25 03:00 local falls back to 02:00. The
  // resolved instant must still land on 02:30 local and must never precede now.
  const dstNow = Date.parse("2026-10-24T22:30:00.000Z"); // 00:30 Paris on the 25th
  const dst = resolveWallClockInstant({
    hour: 2,
    minute: 30,
    timeZone: PARIS,
    now: dstNow,
  });
  assert.equal(dst > dstNow, true);
  assert.equal(dst - dstNow < 26 * 3_600_000, true);
  assert.equal(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: PARIS,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(dst)),
    "02:30",
  );

  // Spring forward: 02:30 local does not exist on 2026-03-29 in Paris. The
  // resolution must still be a real instant strictly after now.
  const springNow = Date.parse("2026-03-28T23:30:00.000Z"); // 00:30 Paris
  const spring = resolveWallClockInstant({
    hour: 2,
    minute: 30,
    timeZone: PARIS,
    now: springNow,
  });
  assert.equal(Number.isSafeInteger(spring), true);
  assert.equal(spring > springNow, true);
  assert.equal(spring - springNow < 26 * 3_600_000, true);
});

test("the runner refuses a configuration it cannot bound", async (t) => {
  const directory = await fixtureDirectory(t);
  assert.throws(
    () =>
      new CloudSubprocessRunner({
        provider: "gemini",
        command: "gemini",
        args: [],
        workingDirectory: directory,
      }),
    /provider must be one of claude-code, codex/,
  );
  assert.throws(
    () =>
      new CloudSubprocessRunner({
        provider: "codex",
        command: "codex",
        args: ["exec", 7],
        workingDirectory: directory,
      }),
    /args must be an array of strings/,
  );
  assert.throws(
    () =>
      new CloudSubprocessRunner({
        provider: "codex",
        command: "",
        args: [],
        workingDirectory: directory,
      }),
    /command must be a non-empty string/,
  );
  assert.throws(
    () =>
      new CloudSubprocessRunner({
        provider: "codex",
        command: "codex",
        args: [],
        workingDirectory: "relative/path",
      }),
    /workingDirectory must be an absolute path/,
  );
  assert.throws(
    () =>
      new CloudSubprocessRunner({
        provider: "codex",
        command: "codex",
        args: [],
        workingDirectory: directory,
        timeoutMs: 0,
      }),
    /timeoutMs must be a positive integer/,
  );
});
