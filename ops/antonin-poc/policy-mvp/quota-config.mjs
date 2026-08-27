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
// DÉCISION ANTONIN EN ATTENTE
// ---------------------------------------------------------------------------
// Spec §5 reserves these values to Antonin and says explicitly that the
// parenthesised figures are proposals to react to, "not a default to adopt
// silently". They are adopted here as *loud placeholders* so the first slice
// can run and be reviewed; every one of them is wrong until Antonin says
// otherwise, and `run-once.mjs quota-status` prints this table so the pending
// decisions stay visible from the operator side.
//
// Reserved decisions still missing from this table, because no code path in
// this slice consumes them: §5.4 (fail-open vs fail-closed on unknown cloud
// quota — the design's fail-closed + canary proposal is implemented),
// §5.5 ANTONIN_MAX_ATTEMPTS, §5.6 daily cloud spend ceiling, §5.7 reviewer
// capacity behaviour, §5.8 paid API-key rung, §5.9 off-hours window,
// §5.10 operator timezone authority.
// ===========================================================================
export const OWNER_DECISION_PLACEHOLDERS = Object.freeze([
  Object.freeze({
    id: "weekly_reserve_fraction",
    spec: "§5.1",
    status: "DÉCISION ANTONIN EN ATTENTE",
    value: 0.2,
    proposal: 0.25,
    effect:
      "share of every weekly window the fleet must never touch; below it a window is critical and no cloud dispatch happens",
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
    id: "cloud_subprocess_allowed",
    spec: "§5.11",
    status: "DÉCISION ANTONIN EN ATTENTE",
    value: false,
    proposal: false,
    effect:
      "whether a cloud runner may spawn a subprocess at all; false keeps the ladder stopped at the Ollama rungs, so any cloud route is refused to the owner. Deliberately not environment-overridable: rungs 4-5 need the §7 gate and a runner that does not exist yet.",
  }),
]);

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

function placeholderValue(id) {
  const entry = OWNER_DECISION_PLACEHOLDERS.find(
    (candidate) => candidate.id === id,
  );
  if (entry === undefined) {
    throw new TypeError(`unknown owner decision placeholder: ${id}`);
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
  const declared = placeholderValue("tokens_per_window");
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
        placeholderValue("weekly_reserve_fraction"),
      "weeklyReserveFraction",
    ),
    sessionSafetyFactor: requirePositiveNumber(
      overrides.sessionSafetyFactor ?? placeholderValue("session_safety_factor"),
      "sessionSafetyFactor",
    ),
    admissionAppliesToReviews: requireBoolean(
      overrides.admissionAppliesToReviews ??
        placeholderValue("admission_applies_to_reviews"),
      "admissionAppliesToReviews",
    ),
    tokensPerWindow: resolveTokensPerWindow(overrides.tokensPerWindow),
    // Deliberately not overridable: §5.11 plus §7 gate the cloud runner.
    cloudSubprocessAllowed: placeholderValue("cloud_subprocess_allowed"),
    maxDeferMs: requirePositiveInteger(
      overrides.maxDeferMs ?? placeholderValue("max_defer_ms"),
      "maxDeferMs",
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
