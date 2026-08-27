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
