/**
 * Quota and fallback configuration for the external policy adapter.
 *
 * Pure module by construction: no imports, no I/O, no side effects. Both the
 * pure decision code in `policy-core.mjs` and the state code in
 * `quota-store.mjs` depend on it, so nothing here may reach the filesystem or
 * the network.
 *
 * Reference:
 * docs/superpowers/specs/2026-08-28-policy-quotas-fallback-design.md
 */

// ===========================================================================
// DÉCISIONS ANTONIN — prises et en attente
// ---------------------------------------------------------------------------
// Spec §5 reserves these values to Antonin and says explicitly that the
// parenthesised figures are proposals to react to, "not a default to adopt
// silently". Two of them were answered on 2026-08-28 and are recorded here
// with Antonin's verbatim answer; the rest stay *loud placeholders* so the
// slice can run and be reviewed. `run-once.mjs quota-status` prints both
// tables so the pending decisions stay visible from the operator side.
//
// Reserved decisions still missing from this table, because no code path
// consumes them: §5.4 (fail-open vs fail-closed on unknown cloud quota — the
// design's fail-closed + canary proposal is implemented), §5.6 daily cloud
// spend ceiling, §5.7 reviewer capacity behaviour, §5.8 paid API-key rung,
// §5.9 off-hours window.
// ===========================================================================
const OWNER_DECISION_CATALOG = Object.freeze([
  Object.freeze({
    id: "weekly_reserve_fraction",
    spec: "§5.1",
    status: "DÉCIDÉ PAR ANTONIN",
    decided_at: "2026-08-28",
    answer: "20 % (Recommandé)",
    value: 0.2,
    proposal: 0.25,
    effect:
      "share of every weekly window the fleet must never touch; below it a window is critical and no cloud dispatch happens",
  }),
  Object.freeze({
    id: "cloud_subprocess_allowed",
    spec: "§5.11",
    status: "DÉCIDÉ PAR ANTONIN",
    decided_at: "2026-08-28",
    answer: "Autoriser (Recommandé)",
    value: true,
    proposal: false,
    effect:
      "whether a cloud runner may spawn a subprocess at all; true makes rungs 4-5 of the §4.1 ladder reachable through the §7 runner contract. The environment may switch it off (ANTONIN_CLOUD_SUBPROCESS=false) but never on: an override can only narrow the ladder.",
  }),
  Object.freeze({
    id: "session_safety_factor",
    spec: "§5.2",
    status: "DÉCISION ANTONIN EN ATTENTE",
    value: 1.5,
    proposal: 1.5,
    effect:
      "multiplier applied to the p90 route cost in the 5 h admission inequality",
  }),
  Object.freeze({
    id: "admission_applies_to_reviews",
    spec: "§5.2",
    status: "DÉCISION ANTONIN EN ATTENTE",
    value: false,
    proposal: null,
    effect:
      "whether the 5 h cost inequality also gates reviews; reviewer alert states are enforced either way",
  }),
  Object.freeze({
    id: "tokens_per_window",
    spec: "§5.3",
    status: "DÉCISION ANTONIN EN ATTENTE",
    value: null,
    proposal: null,
    effect:
      "constant converting a remaining fraction into a token budget; null means the window size is undeclared, so the 5 h inequality cannot be evaluated and the canary rule governs. Only /usage can source it.",
  }),
  Object.freeze({
    id: "max_defer_ms",
    spec: "§5.5",
    status: "DÉCISION ANTONIN EN ATTENTE",
    value: 21_600_000,
    proposal: 21_600_000,
    effect:
      "longest deferral; a reset further away than this becomes awaiting_owner instead of a deferral",
  }),
  Object.freeze({
    id: "max_attempts",
    spec: "§5.5",
    status: "DÉCISION ANTONIN EN ATTENTE",
    value: 3,
    proposal: 3,
    effect:
      "attempts a single task may consume across the §4.1 ladder before it goes to the owner; the counter is the length of metadata.policy_mvp.attempt_log, so it survives process exit",
  }),
  Object.freeze({
    id: "operator_time_zone",
    spec: "§5.10",
    status: "DÉCISION ANTONIN EN ATTENTE",
    value: "Europe/Paris",
    proposal: "Europe/Paris",
    effect:
      "timezone used to resolve a refusal's local wall-clock reset time (`resets 7:30pm`) into an instant, including across DST transitions",
  }),
]);

export const OWNER_DECISIONS_TAKEN = Object.freeze(
  OWNER_DECISION_CATALOG.filter((entry) => entry.status === "DÉCIDÉ PAR ANTONIN"),
);

export const OWNER_DECISION_PLACEHOLDERS = Object.freeze(
  OWNER_DECISION_CATALOG.filter(
    (entry) => entry.status === "DÉCISION ANTONIN EN ATTENTE",
  ),
);

/**
 * Engine tunables. These are *not* reserved to Antonin by §5; they are
 * ordinary defaults that the spec leaves to the implementation, and they are
 * environment-overridable.
 */
export const ENGINE_TUNABLE_DEFAULTS = Object.freeze({
  // §2.3 warning band. Must stay above the weekly reserve.
  warnThreshold: 0.35,
  // §2.5 freshness. A reading older than this is not information any more.
  maxStalenessMs: 900_000,
  // §2.6 at most one canary attempt per (provider, window) per interval.
  canaryIntervalMs: 900_000,
});

/** §2.1 the unit is a window, never a provider. */
export const QUOTA_WINDOW_CATALOG = Object.freeze([
  Object.freeze({
    provider: "ollama",
    plan: "local",
    window_id: "none",
    window_minutes: null,
    metered: false,
  }),
  Object.freeze({
    provider: "claude-code",
    plan: "max",
    window_id: "weekly",
    window_minutes: 10_080,
    metered: true,
  }),
  Object.freeze({
    provider: "claude-code",
    plan: "max",
    window_id: "session_5h",
    window_minutes: 300,
    metered: true,
  }),
  Object.freeze({
    provider: "codex",
    plan: "pro",
    window_id: "weekly",
    window_minutes: 10_080,
    metered: true,
  }),
  Object.freeze({
    provider: "codex",
    plan: "pro",
    window_id: "session_5h",
    window_minutes: 300,
    metered: true,
  }),
]);

export const PROVIDER_PLANS = Object.freeze({
  ollama: "local",
  "claude-code": "max",
  codex: "pro",
});

export const CLOUD_PROVIDERS = Object.freeze(["claude-code", "codex"]);

/**
 * §4.1 rungs 1-3: the models actually installed on this machine, in the order
 * the ladder climbs them. Rung 1 is always the configured `LOCAL_LLM_MODEL`;
 * these are the fallbacks tried after it.
 */
export const DEFAULT_LOCAL_LADDER_MODELS = Object.freeze([
  "qwen2.5-coder:7b",
  "qwen2.5-coder:14b",
  "qwen3:14b",
]);

/**
 * §7 the cloud runner contract. Rungs 4-5 are CLI subscriptions, not HTTP
 * endpoints, so each provider names an argv-only invocation. The prompt is
 * never an argument: it goes to the child's stdin, so no task text can reach
 * the process table.
 *
 * These argv defaults follow `claude --help` on this machine; the Codex CLI is
 * not installed here, so its argv is a documented default that an operator can
 * correct through the environment without touching this file. A missing binary
 * is a `cloud_auth_missing` failure, which drops that provider for the run.
 *
 * `--bare` is deliberately absent from the Claude argv: it forces
 * `ANTHROPIC_API_KEY` authentication, which would turn a subscription rung
 * into metered API spend — the paid route §5.8 does not authorise.
 */
export const CLOUD_RUNNER_DEFAULTS = Object.freeze({
  "claude-code": Object.freeze({
    command: "claude",
    args: Object.freeze([
      "--print",
      "--output-format",
      "json",
      "--no-session-persistence",
      "--permission-mode",
      "manual",
      "--disallowed-tools",
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
    ]),
  }),
  codex: Object.freeze({
    command: "codex",
    args: Object.freeze(["exec", "--sandbox", "read-only", "-"]),
  }),
});

/**
 * §2.4 source reliability. The tier is a property of the source, never of the
 * observation, so a caller cannot promote a guess to a contractual reading.
 */
export const QUOTA_SOURCES = Object.freeze({
  refusal_observed: "contractual",
  success_observed: "contractual",
  ollama_probe: "contractual",
  mc_token_usage: "contractual",
  receipt_history: "contractual",
  codex_rollout_rate_limits: "heuristic",
  claude_refusal_string: "heuristic",
  claude_transcript_usage: "heuristic",
  usage_modeles_sh: "heuristic",
  operator_declaration: "declarative",
});

export function windowKey(provider, plan, windowId) {
  return `${provider}:${plan}:${windowId}`;
}

export function planKey(provider, plan) {
  return `${provider}:${plan}`;
}

export function catalogWindow(provider, plan, windowId) {
  return (
    QUOTA_WINDOW_CATALOG.find(
      (entry) =>
        entry.provider === provider &&
        entry.plan === plan &&
        entry.window_id === windowId,
    ) ?? null
  );
}

export function catalogWindowsForProvider(provider) {
  return QUOTA_WINDOW_CATALOG.filter((entry) => entry.provider === provider);
}

/**
 * Route identifiers are `<provider>/<detail>`: `ollama/qwen2.5-coder:7b` for a
 * local rung, `codex/pro` for a cloud rung, `external/<agent>` for a reviewer
 * whose provider mapping is still open (§7 leaves reviewer routing out of
 * scope).
 */
export function parseRoute(route) {
  if (typeof route !== "string") return null;
  const separator = route.indexOf("/");
  if (separator <= 0 || separator === route.length - 1) return null;
  return {
    provider: route.slice(0, separator),
    detail: route.slice(separator + 1),
  };
}

function requireFraction(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${name} must be a fraction between 0 and 1`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function requirePositiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
  return value;
}

function requireBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function requireTimeZone(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be an IANA time zone`);
  }
  try {
    // The only contractual validation available: the runtime either knows the
    // zone or throws. A typo must fail at configuration time, not while a
    // refusal is being resolved into a latch.
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new TypeError(`${name} must be an IANA time zone`);
  }
  return value;
}

function ownerDecisionValue(id) {
  const entry = OWNER_DECISION_CATALOG.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new TypeError(`unknown owner decision: ${id}`);
  }
  return entry.value;
}

function requireNullableTokenBudget(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be null or a positive integer`);
  }
  return value;
}

function resolveTokensPerWindow(overrides) {
  const declared = ownerDecisionValue("tokens_per_window");
  const resolved = {};
  for (const provider of CLOUD_PROVIDERS) {
    const key = planKey(provider, PROVIDER_PLANS[provider]);
    resolved[key] = requireNullableTokenBudget(
      overrides?.[key] ?? declared,
      `tokensPerWindow["${key}"]`,
    );
  }
  if (overrides !== undefined && overrides !== null) {
    for (const key of Object.keys(overrides)) {
      if (!Object.hasOwn(resolved, key)) {
        throw new TypeError(`unknown tokensPerWindow key: ${key}`);
      }
    }
  }
  return Object.freeze(resolved);
}

/**
 * Resolves the effective quota policy. Every field is validated here so an
 * operator typo fails closed at configuration time rather than silently
 * widening a budget.
 */
export function resolveQuotaPolicy(overrides = {}) {
  if (
    overrides === null ||
    typeof overrides !== "object" ||
    Array.isArray(overrides)
  ) {
    throw new TypeError("quota policy overrides must be an object");
  }

  const policy = {
    warnThreshold: requireFraction(
      overrides.warnThreshold ?? ENGINE_TUNABLE_DEFAULTS.warnThreshold,
      "warnThreshold",
    ),
    weeklyReserveFraction: requireFraction(
      overrides.weeklyReserveFraction ??
        ownerDecisionValue("weekly_reserve_fraction"),
      "weeklyReserveFraction",
    ),
    sessionSafetyFactor: requirePositiveNumber(
      overrides.sessionSafetyFactor ?? ownerDecisionValue("session_safety_factor"),
      "sessionSafetyFactor",
    ),
    admissionAppliesToReviews: requireBoolean(
      overrides.admissionAppliesToReviews ??
        ownerDecisionValue("admission_applies_to_reviews"),
      "admissionAppliesToReviews",
    ),
    tokensPerWindow: resolveTokensPerWindow(overrides.tokensPerWindow),
    // §5.11 is answered, so the gate is open in code. An override may only
    // close it again: a conjunction can narrow the ladder, never widen it.
    cloudSubprocessAllowed:
      ownerDecisionValue("cloud_subprocess_allowed") &&
      requireBoolean(
        overrides.cloudSubprocessAllowed ?? true,
        "cloudSubprocessAllowed",
      ),
    maxDeferMs: requirePositiveInteger(
      overrides.maxDeferMs ?? ownerDecisionValue("max_defer_ms"),
      "maxDeferMs",
    ),
    maxAttempts: requirePositiveInteger(
      overrides.maxAttempts ?? ownerDecisionValue("max_attempts"),
      "maxAttempts",
    ),
    operatorTimeZone: requireTimeZone(
      overrides.operatorTimeZone ?? ownerDecisionValue("operator_time_zone"),
      "operatorTimeZone",
    ),
    maxStalenessMs: requirePositiveInteger(
      overrides.maxStalenessMs ?? ENGINE_TUNABLE_DEFAULTS.maxStalenessMs,
      "maxStalenessMs",
    ),
    canaryIntervalMs: requirePositiveInteger(
      overrides.canaryIntervalMs ?? ENGINE_TUNABLE_DEFAULTS.canaryIntervalMs,
      "canaryIntervalMs",
    ),
  };

  if (policy.warnThreshold <= policy.weeklyReserveFraction) {
    throw new TypeError(
      "warnThreshold must be greater than weeklyReserveFraction",
    );
  }
  return Object.freeze(policy);
}
