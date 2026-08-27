import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { resolveExternalStateDirectory } from "./lease-store.mjs";
import {
  PROVIDER_PLANS,
  QUOTA_SOURCES,
  QUOTA_WINDOW_CATALOG,
  catalogWindow,
  resolveQuotaPolicy,
  windowKey,
} from "./quota-config.mjs";
import { canonicalJson, sha256 } from "./receipt-ledger.mjs";

export const QUOTA_STATE_VERSION = 1;

// §2.2 every instant is epoch milliseconds, UTC. These bounds reject the two
// traps of §1 at the boundary: a Codex `resets_at` left in seconds decodes
// below the floor, and a microsecond value decodes above the ceiling.
const EARLIEST_INSTANT_MS = 1_000_000_000_000; // 2001-09-09T01:46:40Z
const LATEST_INSTANT_MS = 4_102_444_800_000; // 2100-01-01T00:00:00Z

const OBSERVATION_FIELDS = new Set([
  "provider",
  "plan",
  "window_id",
  "source",
  "observed_at",
  "used_fraction",
  "remaining_fraction",
  "resets_at",
  "exhausted_until",
]);

const REQUIRED_OBSERVATION_FIELDS = [
  "provider",
  "plan",
  "window_id",
  "source",
  "observed_at",
];

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertInstant(value, field) {
  if (
    !Number.isSafeInteger(value) ||
    value < EARLIEST_INSTANT_MS ||
    value > LATEST_INSTANT_MS
  ) {
    throw new TypeError(`${field} must be an epoch-millisecond instant`);
  }
  return value;
}

function assertFraction(value, field) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be a fraction between 0 and 1`);
  }
  return value;
}

function emptyWindow(entry) {
  return {
    provider: entry.provider,
    plan: entry.plan,
    window_id: entry.window_id,
    window_minutes: entry.window_minutes,
    used_fraction: null,
    remaining_fraction: null,
    resets_at: null,
    observed_at: null,
    source: null,
    confidence: null,
    exhausted_until: null,
    last_canary_at: null,
  };
}

function isMetered(record) {
  if (typeof record.metered === "boolean") return record.metered;
  const entry = catalogWindow(record.provider, record.plan, record.window_id);
  return entry === null ? true : entry.metered;
}

function isStale(record, now, policy) {
  return (
    record.observed_at === null ||
    now - record.observed_at > policy.maxStalenessMs
  );
}

/**
 * §2.3 the alert state is derived, never stored as an input. It is a pure
 * function of the record, the injected clock and the policy thresholds, so a
 * stale record needs no sweeper and two readers always agree.
 */
export function deriveQuotaState(record, { now, policy }) {
  if (!isMetered(record)) {
    // §2.1 Ollama is unmetered: availability is proved by the attempt itself,
    // not by a quota reading, and it stays admissible through the same path.
    return "ok";
  }
  if (record.exhausted_until !== null) {
    if (now < record.exhausted_until) return "exhausted";
    if (
      record.observed_at === null ||
      record.observed_at <= record.exhausted_until
    ) {
      // The block ended. We know that much and nothing more, so the window
      // becomes unknown rather than ok (§2.3).
      return "unknown";
    }
  }
  if (isStale(record, now, policy)) return "unknown";
  if (
    record.resets_at !== null &&
    now >= record.resets_at &&
    record.observed_at <= record.resets_at
  ) {
    return "unknown";
  }
  if (record.remaining_fraction === null) return "unknown";

  const remaining = record.remaining_fraction;
  const raw =
    remaining <= policy.weeklyReserveFraction
      ? "critical"
      : remaining <= policy.warnThreshold
        ? "warn"
        : "ok";
  if (raw === "ok" && record.confidence === "heuristic") {
    // §2.4 rule 1: a heuristic source may only ever make the engine more
    // cautious. It can never authorise a spend, so it can never reach `ok`.
    return "unknown";
  }
  return raw;
}

/**
 * §2.6 when a window is unknown the engine may spend one real attempt on it
 * per canary interval. A reset zeroes the interval: we know the block ended,
 * and the next attempt is how we find out what replaced it.
 */
export function canaryAvailable(record, { now, policy }) {
  if (deriveQuotaState(record, { now, policy }) !== "unknown") return false;
  if (record.last_canary_at === null) return true;
  if (
    record.exhausted_until !== null &&
    record.last_canary_at < record.exhausted_until &&
    now >= record.exhausted_until
  ) {
    return true;
  }
  return now - record.last_canary_at >= policy.canaryIntervalMs;
}

function assertObservation(observation) {
  if (
    observation === null ||
    typeof observation !== "object" ||
    Array.isArray(observation)
  ) {
    throw new TypeError("quota observation must be an object");
  }
  for (const key of Reflect.ownKeys(observation)) {
    if (typeof key !== "string" || !OBSERVATION_FIELDS.has(key)) {
      throw new TypeError(
        `unsupported quota observation field: ${String(key)}`,
      );
    }
  }
  for (const field of REQUIRED_OBSERVATION_FIELDS) {
    if (!Object.hasOwn(observation, field)) {
      throw new TypeError(`quota observation is missing field: ${field}`);
    }
  }

  const confidence = QUOTA_SOURCES[observation.source];
  if (confidence === undefined) {
    throw new TypeError(`unknown quota source: ${String(observation.source)}`);
  }
  const entry = catalogWindow(
    observation.provider,
    observation.plan,
    observation.window_id,
  );
  if (entry === null) {
    throw new TypeError(
      `unknown quota window: ${windowKey(
        String(observation.provider),
        String(observation.plan),
        String(observation.window_id),
      )}`,
    );
  }

  assertInstant(observation.observed_at, "observed_at");
  for (const field of ["resets_at", "exhausted_until"]) {
    const value = observation[field] ?? null;
    if (value !== null) assertInstant(value, field);
  }

  let used = observation.used_fraction ?? null;
  let remaining = observation.remaining_fraction ?? null;
  if (used !== null) assertFraction(used, "used_fraction");
  if (remaining !== null) assertFraction(remaining, "remaining_fraction");
  if (used !== null && remaining !== null) {
    if (Math.abs(used + remaining - 1) > 1e-9) {
      throw new TypeError(
        "used_fraction and remaining_fraction must sum to 1",
      );
    }
  } else if (used !== null) {
    remaining = 1 - used;
  } else if (remaining !== null) {
    used = 1 - remaining;
  }

  return {
    entry,
    confidence,
    record: {
      provider: entry.provider,
      plan: entry.plan,
      window_id: entry.window_id,
      window_minutes: entry.window_minutes,
      used_fraction: used,
      remaining_fraction: remaining,
      resets_at: observation.resets_at ?? null,
      observed_at: observation.observed_at,
      source: observation.source,
      confidence,
      exhausted_until: observation.exhausted_until ?? null,
      last_canary_at: null,
    },
  };
}

/**
 * §2.8 monotonic merge. The asymmetry of §2.4 is enforced here and in
 * `deriveQuotaState`: a heuristic reading can lower a value or latch an
 * exhaustion, never raise a fresh value, and never clear a latch.
 */
function mergeObservation(stored, incoming, confidence, now, policy) {
  if (stored === null) return incoming;
  if (incoming.observed_at < stored.observed_at) return stored;

  const latchActive =
    stored.exhausted_until !== null && now < stored.exhausted_until;
  const storedIsFresh = !isStale(stored, now, policy);

  if (
    confidence === "heuristic" &&
    stored.confidence === "declarative" &&
    storedIsFresh
  ) {
    // §2.4 rule 3: a declarative reading outranks every heuristic source until
    // it goes stale. A heuristic exhaustion still latches, because rule 1 only
    // ever allows a heuristic to be more cautious.
    if (incoming.exhausted_until === null) return stored;
    return {
      ...stored,
      exhausted_until: Math.max(
        stored.exhausted_until ?? 0,
        incoming.exhausted_until,
      ),
    };
  }

  const merged = { ...incoming, last_canary_at: stored.last_canary_at };

  if (confidence === "heuristic" && storedIsFresh) {
    if (
      stored.remaining_fraction !== null &&
      (merged.remaining_fraction === null ||
        merged.remaining_fraction > stored.remaining_fraction)
    ) {
      merged.remaining_fraction = stored.remaining_fraction;
      merged.used_fraction = stored.used_fraction;
    }
  }

  if (latchActive) {
    // §2.8 only a later contractual success, or the clock, clears the latch.
    merged.exhausted_until =
      incoming.source === "success_observed"
        ? null
        : Math.max(stored.exhausted_until, incoming.exhausted_until ?? 0);
  }
  return merged;
}

export class QuotaStore {
  constructor(stateDirectory, options = {}) {
    this.stateDirectory = resolveExternalStateDirectory(stateDirectory, options);
    this.filePath = path.join(this.stateDirectory, "quotas.json");
    this.observationsPath = path.join(
      this.stateDirectory,
      "quota-observations.jsonl",
    );
    this.lockPath = path.join(this.stateDirectory, ".quotas.lock");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.policy = options.policy ?? resolveQuotaPolicy();
    this.lockRetryMs = options.lockRetryMs ?? 10;
    this.lockMaxAttempts = options.lockMaxAttempts ?? 50;
  }

  async observe(observation) {
    const { confidence, record } = assertObservation(observation);
    const key = windowKey(record.provider, record.plan, record.window_id);

    return this.#withLock(async () => {
      const state = await this.#readState();
      const now = this.now();
      const stored = Object.hasOwn(state.windows, key)
        ? state.windows[key]
        : null;
      const merged = mergeObservation(
        stored,
        record,
        confidence,
        now,
        this.policy,
      );
      state.windows[key] = merged;
      await this.#writeState(state);
      return this.#decorate(merged, now);
    });
  }

  /**
   * §2.8 a snapshot is a read: it never mutates state, so an operator command
   * can print it safely. `recordSnapshot` is the separate, best-effort write
   * that makes a snapshot resolvable later.
   */
  async snapshot(now = this.now()) {
    const state = await this.#readState();
    const windows = QUOTA_WINDOW_CATALOG.map((entry) => {
      const key = windowKey(entry.provider, entry.plan, entry.window_id);
      const stored = Object.hasOwn(state.windows, key)
        ? state.windows[key]
        : emptyWindow(entry);
      return this.#decorate({ ...stored, window_minutes: entry.window_minutes }, now, entry);
    });
    return {
      snapshot_id: sha256(canonicalJson(windows)),
      taken_at: now,
      windows,
    };
  }

  /**
   * Evidence, not authority (§2.8): the observation log is append-only and
   * deliberately not hash-chained, and a write failure must never stop a
   * routing decision the way a corrupt `receipts.jsonl` does.
   */
  async recordSnapshot(snapshot) {
    try {
      await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
      await appendFile(this.observationsPath, `${canonicalJson(snapshot)}\n`, {
        encoding: "utf8",
        flag: "a",
        mode: 0o600,
      });
      await chmod(this.observationsPath, 0o600);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * §2.6 at most one in-flight canary per (provider, window). Across
   * invocations that is enforced by this compare-and-set, for the same reason
   * `CompletionJournal.claimTokenAttempt` needs one.
   */
  async claimCanary(provider, windowId, options = {}) {
    const plan = options.plan ?? PROVIDER_PLANS[provider];
    const entry = catalogWindow(provider, plan, windowId);
    if (entry === null) {
      throw new TypeError(
        `unknown quota window: ${windowKey(
          String(provider),
          String(plan),
          String(windowId),
        )}`,
      );
    }
    const key = windowKey(entry.provider, entry.plan, entry.window_id);

    return this.#withLock(async () => {
      const state = await this.#readState();
      const now = options.now ?? this.now();
      const stored = Object.hasOwn(state.windows, key)
        ? state.windows[key]
        : emptyWindow(entry);
      if (
        !canaryAvailable(
          { ...stored, metered: entry.metered },
          { now, policy: this.policy },
        )
      ) {
        return false;
      }
      state.windows[key] = { ...stored, last_canary_at: now };
      await this.#writeState(state);
      return true;
    });
  }

  #decorate(record, now, entry = null) {
    const catalogEntry =
      entry ?? catalogWindow(record.provider, record.plan, record.window_id);
    const decorated = {
      ...record,
      metered: catalogEntry === null ? true : catalogEntry.metered,
    };
    return {
      ...decorated,
      state: deriveQuotaState(decorated, { now, policy: this.policy }),
      canary_available: canaryAvailable(decorated, { now, policy: this.policy }),
    };
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
        if (error?.code !== "EEXIST") {
          throw error;
        }
        if (attempt === this.lockMaxAttempts) {
          throw new Error("quota state lock is unavailable");
        }
        await this.sleep(this.lockRetryMs);
      }
    }

    if (!acquired) {
      throw new Error("quota state lock is unavailable");
    }

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
        state?.version !== QUOTA_STATE_VERSION ||
        state.windows === null ||
        typeof state.windows !== "object" ||
        Array.isArray(state.windows)
      ) {
        throw new Error("invalid quota state");
      }
      return state;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { version: QUOTA_STATE_VERSION, windows: Object.create(null) };
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
