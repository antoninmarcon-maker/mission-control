import { createHash } from "node:crypto";

const MAX_CANDIDATES = 3;
const MAX_TITLE_LENGTH = 240;
const MAX_OBJECTIVE_LENGTH = 2_000;
const MAX_CONTEXT_LENGTH = 8_000;
const MAX_RATIONALE_LENGTH = 2_000;
const MAX_EVENT_DETAIL_LENGTH = 2_000;
const RISKS = new Set(["low", "medium", "high", "critical"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value, maximumLength) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\0/g, "").replace(/\s+/g, " ").trim();
  if (normalized === "") return null;
  return normalized.slice(0, maximumLength);
}

function eventIdentity(task) {
  if (!Number.isSafeInteger(task?.id) || task.id <= 0) return null;
  const updatedAt = task.updated_at ?? task.updatedAt ?? 0;
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) return null;
  return { taskId: task.id, updatedAt };
}

function actionHash(action) {
  return createHash("sha256")
    .update(JSON.stringify(action))
    .digest("hex");
}

function proposalFromAction(identity, task, action) {
  const title = normalizeText(action.title, MAX_TITLE_LENGTH);
  const objective = normalizeText(action.objective, MAX_OBJECTIVE_LENGTH);
  const context = normalizeText(action.context, MAX_CONTEXT_LENGTH);
  const rationale = normalizeText(action.rationale, MAX_RATIONALE_LENGTH);
  const risk = typeof action.risk === "string" ? action.risk.toLowerCase() : null;
  if (!title || !objective || !context || !rationale || !RISKS.has(risk)) {
    return null;
  }

  const normalizedAction = { title, objective, context, rationale, risk };
  const proposal = {
    sourceType: "event",
    sourceRef: `task:${identity.taskId}`,
    idempotencyKey: `event:${identity.taskId}:${identity.updatedAt}:${actionHash(normalizedAction)}`,
    ...normalizedAction,
  };
  if (Number.isSafeInteger(task?.project_id) && task.project_id > 0) {
    proposal.projectId = task.project_id;
  }
  return proposal;
}

function taskTitle(task) {
  return normalizeText(task?.title, MAX_TITLE_LENGTH);
}

function eventDetail(task, fallback) {
  return (
    normalizeText(task?.error_message, MAX_EVENT_DETAIL_LENGTH) ?? fallback
  );
}

function reviewDetails(metadata) {
  const details = [];
  const collect = (value, allowReason = false) => {
    if (!isRecord(value)) return;
    const detail =
      normalizeText(value.required_follow_up, MAX_EVENT_DETAIL_LENGTH) ??
      normalizeText(value.requiredFollowUp, MAX_EVENT_DETAIL_LENGTH) ??
      normalizeText(value.rejection, MAX_EVENT_DETAIL_LENGTH) ??
      (value.status === "rejected"
        ? normalizeText(value.feedback, MAX_EVENT_DETAIL_LENGTH)
        : null) ??
      (allowReason ? normalizeText(value.reason, MAX_EVENT_DETAIL_LENGTH) : null);
    if (detail) details.push(detail);
  };

  const feedback = metadata.review_feedback;
  if (Array.isArray(feedback)) feedback.forEach(collect);
  else collect(feedback);

  if (Array.isArray(metadata.aegis_rejections)) {
    metadata.aegis_rejections.forEach((rejection) => collect(rejection, true));
  }
  return [...new Set(details)].slice(0, MAX_CANDIDATES);
}

function structuredNextActions(metadata) {
  if (!Array.isArray(metadata.next_actions)) return [];
  const actions = [];
  for (const action of metadata.next_actions) {
    if (!isRecord(action)) continue;
    const title = normalizeText(action.title, MAX_TITLE_LENGTH);
    const objective = normalizeText(action.objective, MAX_OBJECTIVE_LENGTH);
    const context = normalizeText(action.context, MAX_CONTEXT_LENGTH);
    const rationale =
      normalizeText(action.rationale, MAX_RATIONALE_LENGTH) ??
      "A validated next action was supplied by the completed task.";
    const risk = typeof action.risk === "string" ? action.risk.toLowerCase() : null;
    if (!title || !objective || !context || !RISKS.has(risk)) continue;
    actions.push({ title, objective, context, rationale, risk });
    if (actions.length === MAX_CANDIDATES) break;
  }
  return actions;
}

/**
 * Derive up to three deterministic proposal candidates from one terminal task
 * state. The function is intentionally pure: only bounded, structured task
 * fields participate, so free-form completion output cannot create work.
 */
export function proposalCandidatesForTask(task) {
  try {
    const identity = eventIdentity(task);
    const title = taskTitle(task);
    if (!identity || !title) return [];
    const metadata = isRecord(task?.metadata) ? task.metadata : {};
    let actions = [];

    if (task.status === "failed") {
      actions = [{
        title: `Recover ${title}`,
        objective: `Diagnose and recover the failed task: ${title}.`,
        context: eventDetail(task, "Failure details were not recorded."),
        rationale: "The task failed and needs a bounded recovery assessment.",
        risk: "medium",
      }];
    } else if (task.status === "awaiting_owner") {
      actions = [{
        title: `Resolve blocker for ${title}`,
        objective: `Resolve the blocker preventing progress on ${title}.`,
        context: eventDetail(task, "The task is awaiting owner input."),
        rationale: "The task is blocked pending owner input or a bounded hand-off.",
        risk: "medium",
      }];
    } else if (task.status === "review" || task.status === "quality_review") {
      actions = reviewDetails(metadata).map((detail) => ({
        title: `Address review feedback for ${title}`,
        objective: `Resolve the review feedback for ${title}.`,
        context: detail,
        rationale: "A structured review rejection requires a follow-up.",
        risk: "medium",
      }));
    } else if (task.status === "done") {
      actions = structuredNextActions(metadata);
    } else {
      return [];
    }

    return actions
      .filter((action) => action !== null)
      .map((action) => proposalFromAction(identity, task, action))
      .filter((proposal) => proposal !== null)
      .slice(0, MAX_CANDIDATES);
  } catch {
    // Task metadata is untrusted input. A malformed value must not abort a
    // cursor scan or turn arbitrary data into a proposal.
    return [];
  }
}
