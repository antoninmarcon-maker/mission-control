import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OWNER_DECISIONS_TAKEN,
  OWNER_DECISION_PLACEHOLDERS,
  QUOTA_WINDOW_CATALOG,
  resolveQuotaPolicy,
} from "../quota-config.mjs";
import { QuotaStore, deriveQuotaState } from "../quota-store.mjs";

const BASE_INSTANT = 1_800_000_000_000;

async function temporaryStateDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "antonin-policy-quota-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function storeAt(directory, clock, overrides = {}) {
  return new QuotaStore(directory, {
    now: () => clock.value,
    policy: resolveQuotaPolicy(overrides),
  });
}

function clockAt(value) {
  return { value };
}

function weeklyObservation(overrides = {}) {
  return {
    provider: "codex",
    plan: "pro",
    window_id: "weekly",
    source: "operator_declaration",
    observed_at: BASE_INSTANT,
    remaining_fraction: 0.5,
    ...overrides,
  };
}

function windowOf(snapshot, provider, windowId) {
  const found = snapshot.windows.find(
    (candidate) =>
      candidate.provider === provider && candidate.window_id === windowId,
  );
  assert.ok(found, `snapshot is missing ${provider}/${windowId}`);
  return found;
}

test("quota store writes mode-600 state and replaces it atomically", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const store = storeAt(directory, clock);

  const stored = await store.observe(weeklyObservation());
  assert.equal(stored.provider, "codex");
  assert.equal(stored.plan, "pro");
  assert.equal(stored.window_id, "weekly");
  assert.equal(stored.window_minutes, 10_080);
  assert.equal(stored.remaining_fraction, 0.5);
  assert.equal(stored.used_fraction, 0.5);
  assert.equal(stored.confidence, "declarative");
  assert.equal(stored.state, "ok");

  const filePath = path.join(directory, "quotas.json");
  const first = await stat(filePath);
  assert.equal(first.mode & 0o777, 0o600);

  clock.value = BASE_INSTANT + 1_000;
  await store.observe(
    weeklyObservation({ observed_at: clock.value, remaining_fraction: 0.4 }),
  );
  const second = await stat(filePath);
  assert.notEqual(second.ino, first.ino);
  assert.equal(second.mode & 0o777, 0o600);
});

test("observe discards an observation older than the stored one", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT + 5_000);
  const store = storeAt(directory, clock);

  await store.observe(
    weeklyObservation({ observed_at: BASE_INSTANT + 4_000, remaining_fraction: 0.4 }),
  );
  const stale = await store.observe(
    weeklyObservation({ observed_at: BASE_INSTANT + 1_000, remaining_fraction: 0.9 }),
  );

  assert.equal(stale.remaining_fraction, 0.4);
  assert.equal(stale.observed_at, BASE_INSTANT + 4_000);
});

test("an exhausted latch survives snapshots and only the clock or a contractual success clears it", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const store = storeAt(directory, clock);
  const resetAt = BASE_INSTANT + 3_600_000;

  await store.observe({
    provider: "codex",
    plan: "pro",
    window_id: "weekly",
    source: "refusal_observed",
    observed_at: BASE_INSTANT,
    remaining_fraction: 0,
    resets_at: resetAt,
    exhausted_until: resetAt,
  });

  for (const offset of [1, 1_000, 60_000]) {
    clock.value = BASE_INSTANT + offset;
    const snapshot = await store.snapshot(clock.value);
    assert.equal(windowOf(snapshot, "codex", "weekly").state, "exhausted");
  }

  clock.value = BASE_INSTANT + 120_000;
  const heuristic = await store.observe({
    provider: "codex",
    plan: "pro",
    window_id: "weekly",
    source: "codex_rollout_rate_limits",
    observed_at: clock.value,
    remaining_fraction: 0.9,
  });
  assert.equal(heuristic.state, "exhausted");
  assert.equal(heuristic.exhausted_until, resetAt);

  clock.value = resetAt;
  const afterReset = await store.snapshot(clock.value);
  assert.equal(windowOf(afterReset, "codex", "weekly").state, "unknown");

  const stateBytes = await readFile(path.join(directory, "quotas.json"), "utf8");
  assert.equal(JSON.parse(stateBytes).windows["codex:pro:weekly"].exhausted_until, resetAt);

  clock.value = BASE_INSTANT + 200_000;
  const success = await store.observe({
    provider: "codex",
    plan: "pro",
    window_id: "weekly",
    source: "success_observed",
    observed_at: clock.value,
  });
  assert.equal(success.exhausted_until, null);
  assert.equal(success.state, "unknown");
});

test("after the reset the window is unknown and one canary is immediately available", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const store = storeAt(directory, clock);
  const resetAt = BASE_INSTANT + 3_600_000;

  await store.observe({
    provider: "claude-code",
    plan: "max",
    window_id: "session_5h",
    source: "refusal_observed",
    observed_at: BASE_INSTANT,
    remaining_fraction: 0,
    exhausted_until: resetAt,
  });

  clock.value = BASE_INSTANT + 1_000;
  assert.equal(await store.claimCanary("claude-code", "session_5h"), false);

  clock.value = resetAt + 1;
  const snapshot = await store.snapshot(clock.value);
  const window = windowOf(snapshot, "claude-code", "session_5h");
  assert.equal(window.state, "unknown");
  assert.equal(window.canary_available, true);
  assert.equal(await store.claimCanary("claude-code", "session_5h"), true);
  assert.equal(await store.claimCanary("claude-code", "session_5h"), false);
});

test("staleness beyond the maximum degrades any value to unknown", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const store = storeAt(directory, clock, { maxStalenessMs: 60_000 });

  await store.observe(weeklyObservation({ remaining_fraction: 0.8 }));

  clock.value = BASE_INSTANT + 60_000;
  assert.equal(
    windowOf(await store.snapshot(clock.value), "codex", "weekly").state,
    "ok",
  );

  clock.value = BASE_INSTANT + 60_001;
  assert.equal(
    windowOf(await store.snapshot(clock.value), "codex", "weekly").state,
    "unknown",
  );
});

test("a heuristic source reaches warn, critical and exhausted but never ok", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);

  const permissive = storeAt(await temporaryStateDirectory(t), clock);
  const optimistic = await permissive.observe(
    weeklyObservation({
      source: "codex_rollout_rate_limits",
      remaining_fraction: 0.95,
    }),
  );
  assert.equal(optimistic.remaining_fraction, 0.95);
  assert.equal(optimistic.state, "unknown");

  const warned = storeAt(await temporaryStateDirectory(t), clock);
  assert.equal(
    (
      await warned.observe(
        weeklyObservation({
          source: "codex_rollout_rate_limits",
          remaining_fraction: 0.3,
        }),
      )
    ).state,
    "warn",
  );

  const critical = storeAt(await temporaryStateDirectory(t), clock);
  assert.equal(
    (
      await critical.observe(
        weeklyObservation({
          source: "codex_rollout_rate_limits",
          remaining_fraction: 0.1,
        }),
      )
    ).state,
    "critical",
  );

  const exhausted = storeAt(await temporaryStateDirectory(t), clock);
  assert.equal(
    (
      await exhausted.observe(
        weeklyObservation({
          source: "codex_rollout_rate_limits",
          remaining_fraction: 0,
          exhausted_until: BASE_INSTANT + 600_000,
        }),
      )
    ).state,
    "exhausted",
  );

  const store = storeAt(directory, clock, { maxStalenessMs: 60_000 });
  await store.observe(
    weeklyObservation({ source: "mc_token_usage", remaining_fraction: 0.1 }),
  );
  clock.value = BASE_INSTANT + 30_000;
  const clamped = await store.observe(
    weeklyObservation({
      source: "codex_rollout_rate_limits",
      observed_at: clock.value,
      remaining_fraction: 0.95,
    }),
  );
  assert.equal(clamped.remaining_fraction, 0.1);
  assert.equal(clamped.state, "critical");
});

test("a declarative observation outranks a heuristic one until it goes stale", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const store = storeAt(directory, clock, { maxStalenessMs: 60_000 });

  await store.observe(weeklyObservation({ remaining_fraction: 0.9 }));

  clock.value = BASE_INSTANT + 1_000;
  const outranked = await store.observe(
    weeklyObservation({
      source: "codex_rollout_rate_limits",
      observed_at: clock.value,
      remaining_fraction: 0.3,
    }),
  );
  assert.equal(outranked.confidence, "declarative");
  assert.equal(outranked.remaining_fraction, 0.9);
  assert.equal(outranked.state, "ok");

  clock.value = BASE_INSTANT + 60_001;
  const afterStaleness = await store.observe(
    weeklyObservation({
      source: "codex_rollout_rate_limits",
      observed_at: clock.value,
      remaining_fraction: 0.3,
    }),
  );
  assert.equal(afterStaleness.confidence, "heuristic");
  assert.equal(afterStaleness.remaining_fraction, 0.3);
  assert.equal(afterStaleness.state, "warn");
});

test("a heuristic exhaustion latch still applies while a declarative reading is fresh", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const store = storeAt(directory, clock);

  await store.observe(weeklyObservation({ remaining_fraction: 0.9 }));
  clock.value = BASE_INSTANT + 1_000;
  const latched = await store.observe(
    weeklyObservation({
      source: "codex_rollout_rate_limits",
      observed_at: clock.value,
      remaining_fraction: 0,
      exhausted_until: BASE_INSTANT + 600_000,
    }),
  );

  assert.equal(latched.state, "exhausted");
  assert.equal(latched.exhausted_until, BASE_INSTANT + 600_000);
  assert.equal(latched.confidence, "declarative");
  assert.equal(latched.remaining_fraction, 0.9);
});

test("claimCanary elects exactly one winner for concurrent invocations", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const first = storeAt(directory, clock);
  const second = storeAt(directory, clock);

  const outcomes = await Promise.all([
    first.claimCanary("codex", "session_5h"),
    second.claimCanary("codex", "session_5h"),
  ]);

  assert.deepEqual(outcomes.filter(Boolean).length, 1);

  clock.value = BASE_INSTANT + resolveQuotaPolicy().canaryIntervalMs;
  assert.equal(await first.claimCanary("codex", "session_5h"), true);
});

test("quota state and the observation log only carry enumerated non-secret fields", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const store = storeAt(directory, clock);

  await assert.rejects(
    store.observe(
      weeklyObservation({ prompt: "sort the secret customer list" }),
    ),
    /unsupported quota observation field: prompt/,
  );
  await assert.rejects(
    store.observe(weeklyObservation({ session_id: "abc" })),
    /unsupported quota observation field: session_id/,
  );

  await store.observe(weeklyObservation());
  const snapshot = await store.snapshot(clock.value);
  await store.recordSnapshot(snapshot);

  const stateBytes = await readFile(path.join(directory, "quotas.json"), "utf8");
  const observationBytes = await readFile(
    path.join(directory, "quota-observations.jsonl"),
    "utf8",
  );
  const allowedKeys = new Set([
    "version",
    "windows",
    "snapshot_id",
    "taken_at",
    "provider",
    "plan",
    "window_id",
    "window_minutes",
    "metered",
    "used_fraction",
    "remaining_fraction",
    "resets_at",
    "observed_at",
    "source",
    "confidence",
    "exhausted_until",
    "last_canary_at",
    "state",
    "canary_available",
    "codex:pro:weekly",
  ]);
  for (const bytes of [stateBytes, observationBytes]) {
    for (const key of bytes.matchAll(/"([^"]+)":/g)) {
      assert.equal(allowedKeys.has(key[1]), true, `unexpected key ${key[1]}`);
    }
  }
  assert.equal(
    (await stat(path.join(directory, "quota-observations.jsonl"))).mode & 0o777,
    0o600,
  );
});

test("a snapshot covers the whole catalog and is identified by its windows", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const clock = clockAt(BASE_INSTANT);
  const store = storeAt(directory, clock);

  const first = await store.snapshot(clock.value);
  assert.equal(first.windows.length, QUOTA_WINDOW_CATALOG.length);
  assert.equal(windowOf(first, "ollama", "none").state, "ok");
  assert.equal(windowOf(first, "ollama", "none").metered, false);
  assert.equal(windowOf(first, "codex", "weekly").state, "unknown");

  clock.value = BASE_INSTANT + 1_000;
  const second = await store.snapshot(clock.value);
  assert.equal(second.snapshot_id, first.snapshot_id);
  assert.equal(second.taken_at, BASE_INSTANT + 1_000);

  await store.observe(weeklyObservation({ observed_at: clock.value }));
  const third = await store.snapshot(clock.value);
  assert.notEqual(third.snapshot_id, first.snapshot_id);
  assert.match(third.snapshot_id, /^[a-f0-9]{64}$/);
});

test("observe refuses epoch seconds, unknown sources and unknown windows", async (t) => {
  const directory = await temporaryStateDirectory(t);
  const store = storeAt(directory, clockAt(BASE_INSTANT));

  await assert.rejects(
    store.observe(weeklyObservation({ observed_at: 1_788_272_042 })),
    /observed_at must be an epoch-millisecond instant/,
  );
  await assert.rejects(
    store.observe(weeklyObservation({ resets_at: 1_788_272_042 })),
    /resets_at must be an epoch-millisecond instant/,
  );
  await assert.rejects(
    store.observe(weeklyObservation({ source: "guessed" })),
    /unknown quota source: guessed/,
  );
  await assert.rejects(
    store.observe(weeklyObservation({ window_id: "daily" })),
    /unknown quota window: codex:pro:daily/,
  );
  await assert.rejects(
    store.observe(weeklyObservation({ remaining_fraction: 1.5 })),
    /remaining_fraction must be a fraction between 0 and 1/,
  );
  await assert.rejects(
    store.observe(
      weeklyObservation({ remaining_fraction: 0.5, used_fraction: 0.9 }),
    ),
    /used_fraction and remaining_fraction must sum to 1/,
  );
});

test("derived states are a pure function of the record, the clock and the policy", () => {
  const policy = resolveQuotaPolicy();
  const record = {
    provider: "codex",
    plan: "pro",
    window_id: "weekly",
    window_minutes: 10_080,
    metered: true,
    used_fraction: 0.5,
    remaining_fraction: 0.5,
    resets_at: null,
    observed_at: BASE_INSTANT,
    source: "operator_declaration",
    confidence: "declarative",
    exhausted_until: null,
    last_canary_at: null,
  };

  assert.equal(deriveQuotaState(record, { now: BASE_INSTANT, policy }), "ok");
  assert.equal(
    deriveQuotaState(record, { now: BASE_INSTANT, policy }),
    deriveQuotaState(record, { now: BASE_INSTANT, policy }),
  );
  assert.equal(
    deriveQuotaState(
      { ...record, remaining_fraction: null, used_fraction: null },
      { now: BASE_INSTANT, policy },
    ),
    "unknown",
  );
  assert.equal(
    deriveQuotaState(
      { ...record, resets_at: BASE_INSTANT + 10 },
      { now: BASE_INSTANT + 11, policy },
    ),
    "unknown",
  );
});

test("the reserved owner decisions are split between taken and still pending", () => {
  const policy = resolveQuotaPolicy();
  const pending = new Map(
    OWNER_DECISION_PLACEHOLDERS.map((entry) => [entry.id, entry]),
  );
  const taken = new Map(OWNER_DECISIONS_TAKEN.map((entry) => [entry.id, entry]));

  for (const entry of OWNER_DECISION_PLACEHOLDERS) {
    assert.equal(entry.status, "DÉCISION ANTONIN EN ATTENTE");
    assert.match(entry.spec, /^§5\.\d+$/);
  }
  for (const entry of OWNER_DECISIONS_TAKEN) {
    assert.equal(entry.status, "DÉCIDÉ PAR ANTONIN");
    assert.equal(entry.decided_at, "2026-08-28");
    assert.match(entry.spec, /^§5\.\d+$/);
    assert.equal(typeof entry.answer, "string");
    assert.notEqual(entry.answer, "");
  }
  assert.equal(pending.has("weekly_reserve_fraction"), false);
  assert.equal(pending.has("cloud_subprocess_allowed"), false);

  // §5.1 decided at 20 %, so this is a value and no longer a placeholder.
  assert.equal(taken.get("weekly_reserve_fraction").value, 0.2);
  assert.equal(taken.get("weekly_reserve_fraction").answer, "20 % (Recommandé)");
  assert.equal(policy.weeklyReserveFraction, 0.2);

  // §5.11 authorised, so rungs 4-5 exist. It can still be switched off, and
  // only off: the environment may narrow the ladder, never widen it.
  assert.equal(taken.get("cloud_subprocess_allowed").value, true);
  assert.equal(
    taken.get("cloud_subprocess_allowed").answer,
    "Autoriser (Recommandé)",
  );
  assert.equal(policy.cloudSubprocessAllowed, true);
  assert.equal(
    resolveQuotaPolicy({ cloudSubprocessAllowed: false }).cloudSubprocessAllowed,
    false,
  );
  assert.equal(
    resolveQuotaPolicy({ cloudSubprocessAllowed: true }).cloudSubprocessAllowed,
    true,
  );

  // §5.3 still unanswered: only /usage can source it.
  assert.equal(pending.get("tokens_per_window").value, null);
  assert.deepEqual(policy.tokensPerWindow, {
    "claude-code:max": null,
    "codex:pro": null,
  });
  // §5.5 and §5.10 are consumed by the ladder, so they are declared pending.
  assert.equal(pending.get("max_attempts").value, 3);
  assert.equal(policy.maxAttempts, 3);
  assert.equal(pending.get("operator_time_zone").value, "Europe/Paris");
  assert.equal(policy.operatorTimeZone, "Europe/Paris");
});

test("policy resolution validates thresholds and keeps the reserve below the warning band", () => {
  assert.throws(
    () => resolveQuotaPolicy({ warnThreshold: 0.1, weeklyReserveFraction: 0.2 }),
    /warnThreshold must be greater than weeklyReserveFraction/,
  );
  assert.throws(
    () => resolveQuotaPolicy({ sessionSafetyFactor: 0 }),
    /sessionSafetyFactor must be a positive number/,
  );
  assert.throws(
    () => resolveQuotaPolicy({ maxDeferMs: -1 }),
    /maxDeferMs must be a positive integer/,
  );
  assert.throws(
    () => resolveQuotaPolicy({ tokensPerWindow: { "codex:pro": 0 } }),
    /tokensPerWindow\["codex:pro"\] must be null or a positive integer/,
  );
  assert.equal(
    resolveQuotaPolicy({ tokensPerWindow: { "codex:pro": 5_000_000 } })
      .tokensPerWindow["codex:pro"],
    5_000_000,
  );
});
