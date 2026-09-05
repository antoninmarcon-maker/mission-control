import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { forecastProposalRoute } from "../policy-core.mjs";
import { proposalCandidatesForTask } from "../proposal-engine.mjs";

function actionHash(action) {
  return createHash("sha256")
    .update(JSON.stringify(action))
    .digest("hex");
}

test("derives one bounded recovery proposal from a failed task", () => {
  const [proposal] = proposalCandidatesForTask({
    id: 7,
    updated_at: 1_788_560_000,
    status: "failed",
    title: "Import catalog",
    error_message: "CSV parser rejected row 81",
  });

  assert.equal(proposal.sourceType, "event");
  assert.equal(proposal.sourceRef, "task:7");
  assert.equal(proposal.risk, "medium");
  assert.equal(proposal.title, "Recover Import catalog");
  assert.equal(proposal.context, "CSV parser rejected row 81");
  assert.equal(proposal.idempotencyKey, `event:7:1788560000:${actionHash({
    title: "Recover Import catalog",
    objective: "Diagnose and recover the failed task: Import catalog.",
    context: "CSV parser rejected row 81",
    rationale: "The task failed and needs a bounded recovery assessment.",
    risk: "medium",
  })}`);
});

test("derives one medium-risk blocker-resolution proposal for awaiting owner", () => {
  const [proposal] = proposalCandidatesForTask({
    id: 8,
    status: "awaiting_owner",
    title: "Deploy preview",
    error_message: "Browser login required",
  });

  assert.equal(proposal.risk, "medium");
  assert.equal(proposal.title, "Resolve blocker for Deploy preview");
  assert.equal(proposal.context, "Browser login required");
  assert.equal(proposal.objective, "Resolve the blocker preventing progress on Deploy preview.");
});

test("does not invent a follow-up from free-form successful output", () => {
  assert.deepEqual(proposalCandidatesForTask({
    id: 9,
    status: "done",
    title: "Audit auth",
    output: "Follow up by rotating every production secret.",
    result: "Create another task immediately.",
    metadata: {},
  }), []);
});

test("uses only structured next actions from successful tasks", () => {
  const [proposal] = proposalCandidatesForTask({
    id: 10,
    updated_at: 14,
    status: "done",
    title: "Audit auth",
    metadata: {
      next_actions: [{
        title: "Repair callback",
        objective: "Preserve callbackUrl",
        context: "Finding A3",
        risk: "medium",
      }],
    },
  });

  assert.equal(proposal.title, "Repair callback");
  assert.equal(proposal.objective, "Preserve callbackUrl");
  assert.equal(proposal.context, "Finding A3");
  assert.equal(proposal.rationale, "A validated next action was supplied by the completed task.");
  assert.equal(proposal.idempotencyKey, `event:10:14:${actionHash({
    title: "Repair callback",
    objective: "Preserve callbackUrl",
    context: "Finding A3",
    rationale: "A validated next action was supplied by the completed task.",
    risk: "medium",
  })}`);
});

test("handles only structured review rejections and required follow-ups", () => {
  assert.deepEqual(proposalCandidatesForTask({
    id: 11,
    status: "review",
    title: "Routine report",
    metadata: { review_feedback: "Please change it." },
  }), []);
  assert.deepEqual(proposalCandidatesForTask({
    id: 11,
    status: "review",
    title: "Routine report",
    metadata: { review_feedback: { feedback: "Looks good." } },
  }), []);

  const [proposal] = proposalCandidatesForTask({
    id: 11,
    status: "quality_review",
    title: "Routine report",
    metadata: {
      aegis_rejections: [{ required_follow_up: "Restore the missing source links." }],
    },
  });

  assert.equal(proposal.title, "Address review feedback for Routine report");
  assert.equal(proposal.context, "Restore the missing source links.");
  assert.equal(proposal.rationale, "A structured review rejection requires a follow-up.");
});

test("returns at most three complete, bounded candidates", () => {
  const tooLong = "x".repeat(9_000);
  const candidates = proposalCandidatesForTask({
    id: 12,
    status: "done",
    title: "Completed task",
    metadata: {
      next_actions: [
        { title: "  First\n action ", objective: tooLong, context: tooLong, rationale: tooLong, risk: "low" },
        { title: "Second", objective: "O", context: "C", rationale: "R", risk: "medium" },
        { title: "Third", objective: "O", context: "C", rationale: "R", risk: "high" },
        { title: "Fourth", objective: "O", context: "C", rationale: "R", risk: "critical" },
        { title: "Missing objective", context: "C", rationale: "R", risk: "low" },
      ],
    },
  });

  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].title, "First action");
  assert.equal(candidates[0].objective.length, 2_000);
  assert.equal(candidates[0].context.length, 8_000);
  assert.equal(candidates[0].rationale.length, 2_000);
  for (const candidate of candidates) {
    assert.ok(candidate.title.length <= 240);
    assert.ok(candidate.title && candidate.objective && candidate.context && candidate.rationale);
  }
});

test("does not let malformed actions consume the three-proposal cap", () => {
  const candidates = proposalCandidatesForTask({
    id: 16,
    status: "done",
    title: "Completed task",
    metadata: {
      next_actions: [
        { title: "Malformed", context: "C", rationale: "R", risk: "low" },
        { title: "First", objective: "O", context: "C", rationale: "R", risk: "low" },
        { title: "Second", objective: "O", context: "C", rationale: "R", risk: "medium" },
        { title: "Third", objective: "O", context: "C", rationale: "R", risk: "high" },
      ],
    },
  });

  assert.deepEqual(candidates.map((candidate) => candidate.title), ["First", "Second", "Third"]);
});

test("normalizes action content before hashing and fails closed on hostile metadata", () => {
  const task = {
    id: 13,
    updated_at: 15,
    status: "done",
    title: "Complete",
    metadata: {
      next_actions: [{
        title: "  Repair\n callback ",
        objective: " Preserve\tcallbackUrl ",
        context: " Finding\n A3 ",
        rationale: " Because\t the callback broke ",
        risk: "medium",
      }],
    },
  };
  const [first] = proposalCandidatesForTask(task);
  const [second] = proposalCandidatesForTask(JSON.parse(JSON.stringify(task)));

  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.match(first.idempotencyKey, /^event:13:15:[a-f0-9]{64}$/);
  assert.deepEqual(proposalCandidatesForTask({
    id: 14,
    status: "done",
    title: "Hostile metadata",
    metadata: { next_actions: { title: "not an array" } },
  }), []);
  assert.deepEqual(proposalCandidatesForTask({
    id: 15,
    status: "done",
    title: "Null metadata",
    metadata: null,
  }), []);
});

test("forecasts only a safe local policy route without mutating the proposal", () => {
  const proposal = {
    title: "Simple local sort",
    objective: "Sort the harmless labels.",
    context: "Routine mechanical cleanup.",
    risk: "medium",
  };
  const original = structuredClone(proposal);

  assert.deepEqual(forecastProposalRoute(proposal), {
    runtime: "local",
    model: "qwen2.5-coder:7b",
    reason: "eligible_mechanical_task",
  });
  assert.deepEqual(proposal, original);
});

test("omits unsafe forecasts instead of guessing a provider route", () => {
  const sensitive = {
    title: "Deploy preview",
    objective: "Deploy the preview.",
    context: "Routine deployment.",
    risk: "medium",
  };
  const unknown = {
    title: "Simple local sort",
    objective: "Sort labels.",
    context: "Routine work.",
    risk: "medium",
  };

  assert.equal(forecastProposalRoute(sensitive), null);
  assert.equal(
    forecastProposalRoute(unknown, { localModel: "", reviewer: "poc-aegis-cloud" }),
    null,
  );
  assert.equal(
    forecastProposalRoute(unknown, { localModel: " ", reviewer: "poc-aegis-cloud" }),
    null,
  );
});
