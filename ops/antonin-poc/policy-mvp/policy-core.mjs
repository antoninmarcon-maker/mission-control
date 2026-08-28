import {
  CLOUD_PROVIDERS,
  catalogWindowsForProvider,
  parseRoute,
  planKey,
} from "./quota-config.mjs";

export const POLICY_VERSION = "antonin-policy-v0";

const ALLOW_TERMS = [
  "sort",
  "format",
  "rename",
  "summarize",
  "translate",
  "simple",
  "routine",
  "mechanical",
];

const DENY_TERMS = [
  "deploy",
  "deployment",
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

function containsVocabularyTerm(text, terms) {
  return terms.some((term) =>
    new RegExp(`(?:^|[^a-z0-9])${term}(?:$|[^a-z0-9])`, "i").test(text),
  );
}

function awaitingOwner(reasonCode) {
  return {
    policyVersion: POLICY_VERSION,
    status: "awaiting_owner",
    route: null,
    reviewer: null,
    reasonCode,
  };
}

export function evaluateTask(task, options = {}) {
  const localModel = options.localModel ?? "qwen2.5-coder:7b";
  const reviewer = options.reviewer ?? "poc-aegis-cloud";
  const route = `ollama/${localModel}`;
  const priority = String(task?.priority ?? "").toLowerCase();
  const tier = String(task?.metadata?.tier ?? "").toUpperCase();
  const text = `${String(task?.title ?? "")} ${String(task?.description ?? "")}`;

  if (priority === "high" || priority === "critical") {
    return awaitingOwner("priority_requires_owner");
  }
  if (tier === "SOLIDE") {
    return awaitingOwner("solide_requires_owner");
  }
  if (containsVocabularyTerm(text, DENY_TERMS)) {
    return awaitingOwner("sensitive_keyword_requires_owner");
  }
  if (!containsVocabularyTerm(text, ALLOW_TERMS)) {
    return awaitingOwner("non_mechanical_requires_owner");
  }

  const normalizedReviewer = String(reviewer).trim().toLowerCase();
  const normalizedModel = String(localModel).trim().toLowerCase();
  if (
    normalizedReviewer === "" ||
    normalizedReviewer === route.toLowerCase() ||
    normalizedReviewer === normalizedModel
  ) {
    return awaitingOwner("reviewer_must_be_distinct");
  }

  return {
    policyVersion: POLICY_VERSION,
    status: "execute_local",
    route,
    reviewer,
    reasonCode: "eligible_mechanical_task",
  };
}

// ---------------------------------------------------------------------------
// §3 failure taxonomy
// ---------------------------------------------------------------------------

export const FAILURE_KINDS = Object.freeze([
  "policy_reject",
  "local_daemon_unreachable",
  "local_model_error",
  "local_transient",
  "local_output_invalid",
  "cloud_quota_exhausted",
  "cloud_auth_missing",
  "cloud_transient",
  "control_plane_ambiguous",
  "lease_lost",
  "unknown",
]);

const FAILURE_KIND_SET = new Set(FAILURE_KINDS);

/**
 * §4.2 the completion boundary. `control_plane_ambiguous` and `lease_lost`
 * happen *after* a completion exists; re-routing them would double-execute and
 * duplicate token accounting that is at-most-once by design. `unknown` fails
 * closed because an unclassified error has side effects we cannot bound.
 */
const FALLBACK_ELIGIBLE_KINDS = new Set([
  "local_daemon_unreachable",
  "local_model_error",
  "local_transient",
  "local_output_invalid",
  "cloud_quota_exhausted",
  "cloud_auth_missing",
  "cloud_transient",
]);

const BOUNDARY_KINDS = new Set(["control_plane_ambiguous", "lease_lost"]);

const TIMEOUT_PATTERN = /\baborted\b|\btimeout\b|\btimed out\b/i;

export function isFallbackEligible(kind) {
  return FALLBACK_ELIGIBLE_KINDS.has(kind);
}

/**
 * Maps an error raised by the existing clients onto §3. Recognition uses what
 * the code actually produces today; a future cloud runner declares its own
 * kind through `error.failureKind`, per the contract of §7.
 */
export function classifyFailure(error, context = {}) {
  if (context.policyRejected === true) return "policy_reject";

  const name = String(error?.name ?? "");
  const message = String(error?.message ?? "");

  // The boundary kinds are recognised first and can never be overridden by a
  // runner-declared kind: nothing may turn them into a fallback.
  if (
    name === "CompletionContendedError" ||
    /lease is not current for task/.test(message)
  ) {
    return "lease_lost";
  }
  if (name === "MissionControlRequestError" && error?.ambiguous === true) {
    return "control_plane_ambiguous";
  }

  const declared = error?.failureKind;
  if (
    typeof declared === "string" &&
    FAILURE_KIND_SET.has(declared) &&
    !BOUNDARY_KINDS.has(declared)
  ) {
    return declared;
  }

  if (
    message === "Ollama returned an invalid chat completion" ||
    message === "Ollama response exceeds the task resolution limit"
  ) {
    return "local_output_invalid";
  }

  const status = /^Ollama request failed \((\d{3})\)/.exec(message);
  if (status !== null) {
    const code = Number(status[1]);
    if (code >= 500) return "local_transient";
    if (code >= 400) return "local_model_error";
    return "unknown";
  }
  if (message.startsWith("Ollama request failed: ")) {
    // No HTTP status: either the daemon never answered, or our own timeout
    // fired. They are different rungs of the matrix, so they are separated.
    return TIMEOUT_PATTERN.test(message)
      ? "local_transient"
      : "local_daemon_unreachable";
  }

  if (CLOUD_PROVIDERS.includes(context.provider)) {
    const httpStatus = error?.status;
    if (httpStatus === 429) return "cloud_quota_exhausted";
    if (httpStatus === 401 || httpStatus === 403) return "cloud_auth_missing";
    if (Number.isInteger(httpStatus) && httpStatus >= 500) {
      return "cloud_transient";
    }
    if (TIMEOUT_PATTERN.test(message)) return "cloud_transient";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// §2.7 / §4.4 / §4.5 admission control
// ---------------------------------------------------------------------------

/** Nearest-rank p90 over observed route costs. `null` when there is no history. */
export function percentile90(values) {
  const samples = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (samples.length === 0) return null;
  const rank = Math.ceil(0.9 * samples.length);
  return samples[Math.min(samples.length, Math.max(1, rank)) - 1];
}

function refusal(decision, reasonCode) {
  return { decision, reasonCode, deferredUntil: null, canaryClaims: [] };
}

function snapshotWindow(snapshot, entry) {
  const found = (snapshot?.windows ?? []).find(
    (candidate) =>
      candidate.provider === entry.provider &&
      candidate.plan === entry.plan &&
      candidate.window_id === entry.window_id,
  );
  if (found !== undefined) return found;
  // A window the snapshot does not describe is unknown with no canary: fail
  // closed rather than assume capacity nobody observed.
  return {
    ...entry,
    remaining_fraction: null,
    resets_at: null,
    exhausted_until: null,
    state: "unknown",
    canary_available: false,
  };
}

function admitProviderWindows({
  provider,
  usage,
  costTokens,
  snapshot,
  policy,
  now,
}) {
  const entries = catalogWindowsForProvider(provider);
  if (entries.length === 0) {
    // §7 leaves reviewer routing open, so a route whose provider this engine
    // does not track carries no window to evaluate.
    return { blocked: null, reasonCode: `${usage}_route_untracked`, claims: [] };
  }

  const claims = [];
  for (const entry of entries) {
    if (!entry.metered) continue;
    const window = snapshotWindow(snapshot, entry);
    const blocked = (reasonCode, resetInstant) => ({
      blocked: { reasonCode, resetInstant },
      claims,
    });

    if (window.state === "exhausted") {
      return blocked(
        `${usage}_window_exhausted`,
        window.exhausted_until ?? window.resets_at,
      );
    }
    if (window.state === "critical") {
      // §2.3 below the reserve there is no cloud dispatch of any kind.
      return blocked(`${usage}_window_critical`, window.resets_at);
    }
    if (window.state === "warn") {
      // §2.3 the warn band keeps capacity for reviews and refuses new
      // executions: draining the review queue beats starting more work.
      if (usage === "execution") {
        return blocked("execution_refused_in_warn_band", window.resets_at);
      }
      continue;
    }
    if (window.state === "unknown") {
      // §2.6 we do not measure, we attempt: one real task per interval.
      if (window.canary_available !== true) {
        return blocked(`${usage}_window_unknown_canary_spent`, null);
      }
      claims.push({
        provider: entry.provider,
        plan: entry.plan,
        window_id: entry.window_id,
      });
      continue;
    }

    // §4.5 the 5 h window is protected by "do not start a job whose expected
    // cost exceeds what is left", not by a percentage.
    const gated = usage === "execution" || policy.admissionAppliesToReviews;
    if (entry.window_id !== "session_5h" || !gated) continue;

    const budget = policy.tokensPerWindow[planKey(entry.provider, entry.plan)];
    if (budget === null || costTokens === null) {
      // The inequality has two unevaluable cases and neither one blocks:
      // §5.3 `tokens_per_window` is undeclared, and §2.7 has no cost history
      // for this route. Requiring either would contradict §2.6 — the whole
      // design exists because remaining quota cannot be metered — so the
      // window governs by its state alone: `ok` admits, `warn` refuses
      // executions, `critical`/`exhausted` block, and `unknown` costs a
      // canary. The refusal circuit breaker of §2.8 remains the backstop.
      continue;
    }
    if (
      window.remaining_fraction * budget <
      costTokens * policy.sessionSafetyFactor
    ) {
      return blocked(`${usage}_session_window_too_small`, window.resets_at);
    }
  }
  return { blocked: null, reasonCode: `${usage}_admitted`, claims };
}

/**
 * §4.4 admission needs a reviewer, not just an executor: executor capacity
 * alone never admits a task, because local work that can never be reviewed
 * parks in `review` for ever. §4.3 keeps `sensitive` work with Antonin at
 * every cell, whatever the quota state.
 *
 * Pure: it reads the snapshot it is given and performs no I/O. Claiming the
 * canaries it asks for is the caller's job, because that claim is a
 * compare-and-set on persistent state.
 */
export function admitAttempt({
  riskClass,
  executorRoute,
  reviewerRoute,
  snapshot,
  executorCostTokens = null,
  reviewerCostTokens = null,
  policy,
  now,
}) {
  if (riskClass !== "mechanical") {
    return refusal(
      "awaiting_owner",
      riskClass === "sensitive" ? "sensitive_requires_owner" : "unknown_risk_class",
    );
  }

  const executor = parseRoute(executorRoute);
  if (
    executor === null ||
    catalogWindowsForProvider(executor.provider).length === 0
  ) {
    // An executor this engine has no window for cannot be admitted: only the
    // reviewer may sit on an untracked route (§7).
    return refusal("awaiting_owner", "unknown_executor_route");
  }
  const reviewer = parseRoute(reviewerRoute);
  if (reviewer === null) {
    return refusal("awaiting_owner", "unknown_reviewer_route");
  }
  if (executor.provider === reviewer.provider) {
    // §4.4 one provider must never grade its own work.
    return refusal("awaiting_owner", "reviewer_must_be_distinct");
  }
  if (CLOUD_PROVIDERS.includes(executor.provider) && !policy.cloudSubprocessAllowed) {
    // §5.11 and §7: the ladder stops at the Ollama rungs until the subprocess
    // gate is passed. Waiting cannot fix this, so it goes to the owner.
    return refusal("awaiting_owner", "cloud_subprocess_not_allowed");
  }

  const deferral = (reasonCode, resetInstant) => {
    const target =
      Number.isSafeInteger(resetInstant) && resetInstant > now
        ? resetInstant
        : now + policy.canaryIntervalMs;
    if (target - now > policy.maxDeferMs) {
      return refusal("awaiting_owner", `${reasonCode}_beyond_max_defer`);
    }
    return {
      decision: "defer",
      reasonCode,
      deferredUntil: target,
      canaryClaims: [],
    };
  };

  const canaryClaims = [];
  for (const [provider, usage, costTokens] of [
    [executor.provider, "execution", executorCostTokens],
    [reviewer.provider, "review", reviewerCostTokens],
  ]) {
    const outcome = admitProviderWindows({
      provider,
      usage,
      costTokens,
      snapshot,
      policy,
      now,
    });
    if (outcome.blocked !== null) {
      return deferral(outcome.blocked.reasonCode, outcome.blocked.resetInstant);
    }
    canaryClaims.push(...outcome.claims);
  }

  return {
    decision: "execute",
    reasonCode: "admitted",
    deferredUntil: null,
    canaryClaims,
  };
}

export function validateLoopbackHttpUrl(value, name = "URL") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${name} must be a valid URL`);
  }

  if (url.protocol !== "http:") {
    throw new TypeError(`${name} must use http:`);
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new TypeError(`${name} must use a loopback host`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`${name} must not contain credentials`);
  }

  return url;
}
