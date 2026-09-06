# Orchestrator-Managed Task Proposals

Date: 2026-09-05

## Decision

Add a proposal inbox to Mission Control. The external orchestrator generates proposals from both the embedded chat and automatic runtime signals. Mission Control presents the proposals, records the human decision, and atomically turns an accepted proposal into a runnable task. The orchestrator remains the sole authority for choosing Claude, Codex, or a local LLM and for starting execution.

The fast path is one action: **Validate and launch**. Editing is optional, not required before launch.

## Goals

- Let an operator launch a useful follow-up without filling in the existing task form.
- Show enough information to make a quick decision: title, objective, relevant context, reason for the proposal, risk, and likely execution route.
- Support two proposal sources through one contract:
  - explicit suggestions extracted from the embedded chat;
  - automatic suggestions derived from task, run, review, failure, and blocking events.
- Preserve a human approval boundary before any proposal becomes executable work.
- Keep provider selection, quota policy, fallback, leases, review policy, receipts, and `ship` authority in the external orchestrator.
- Keep an auditable link between the proposal, the approval, the resulting task, and its execution receipt.

## Non-goals

- Mission Control does not implement a second model router.
- A proposal is not silently inserted into the task backlog.
- Mission Control does not launch a proposal without a human action.
- The first version does not attempt general autonomous planning across every stored document or repository.
- The first version does not require a conversational clarification wizard before launch. Operators may edit a proposal when needed.

## Existing Context

Mission Control already owns task state, comments, events, authentication, and operator-facing surfaces. The Antonin control-plane POC established that the external policy engine must continue to own complexity, risk, quota, local-first, fallback, review, lease, receipt, and `ship` decisions.

The current uncommitted `feat/task-clarification` work adds a human-only clarification gate and prevents dispatch while clarification is pending. It is useful as an authorization and concurrency reference, but its current model asks someone to author questions manually. Task proposals require a distinct object and lifecycle so rejected or expired ideas do not pollute the Kanban.

## Product Experience

### Proposal inbox

The Tasks surface gains a compact **Proposals** section above the Kanban. Pending proposals appear as horizontally scannable cards. The same card can appear inline in the embedded chat when chat is the source.

Each card shows:

- a short title;
- the objective in one or two sentences;
- the minimum context needed to understand the request;
- why the orchestrator proposes it now;
- source and freshness;
- risk level;
- the currently expected route, such as Local, Codex, or Claude, with a short reason.

The route is explicitly a forecast. The orchestrator may choose a different executor at launch if complexity, risk, quotas, or availability changed. Mission Control records both the forecast and the final routing decision.

### Actions

- **Validate and launch**: atomically accepts the proposal, creates the task, emits the launch event, and closes the card.
- **Modify**: opens an optional compact editor for title, objective, and context. Saving creates a new proposal revision; it does not launch work.
- **Dismiss**: archives the proposal. A reason is optional in the UI and retained when supplied.

The primary action remains available without opening a form. A successful action replaces the card with a link to the created task and a visible launch state.

## Architecture

### Ownership boundary

Mission Control owns:

- proposal persistence and workspace scoping;
- proposal cards and embedded-chat presentation;
- operator authentication and authorization;
- the atomic accept-to-task transition;
- events, audit fields, and links between proposals and tasks.

The external orchestrator owns:

- deciding whether a possible follow-up deserves a proposal;
- generating and validating the proposal content;
- deduplication keys and source evidence;
- the displayed route forecast;
- the final execution route after approval;
- provider fallback, leases, receipts, review policy, and `ship` operations.

Model providers are adapters behind the orchestrator. Mission Control never branches on Claude, Codex, or local-model business rules in the proposal flow.

### Unified producer contract

Both sources publish the same `TaskProposalInput` contract:

```ts
type TaskProposalInput = {
  sourceType: 'chat' | 'event'
  sourceRef: string
  idempotencyKey: string
  title: string
  objective: string
  context: string
  rationale: string
  risk: 'low' | 'medium' | 'high' | 'critical'
  routeForecast?: {
    runtime: 'local' | 'codex' | 'claude'
    model?: string
    reason: string
  }
  projectId?: number
  metadata?: Record<string, unknown>
  expiresAt?: number
}
```

Chat extraction runs only after a user asks for suggestions or when the assistant presents an explicit next action. Automatic extraction consumes bounded events initially: task completion, task failure, `awaiting_owner`, and review rejection. Each producer supplies a stable idempotency key derived from its source and proposed action.

### Persistence

Create a dedicated `task_proposals` table rather than storing proposals as tasks or opaque task metadata. Required fields are:

- identity and scope: `id`, `workspace_id`, `project_id`;
- content: `title`, `objective`, `context`, `rationale`, `risk`;
- provenance: `source_type`, `source_ref`, `created_by`, `idempotency_key`;
- routing forecast: structured JSON with runtime, optional model, and reason;
- lifecycle: `status` (`pending`, `accepted`, `dismissed`, `expired`), `revision`, timestamps, optional expiry;
- outcome: `accepted_by`, `accepted_at`, `task_id`, optional dismissal reason;
- extensibility: validated metadata JSON.

Enforce uniqueness on `(workspace_id, idempotency_key)`. Keep proposal content immutable per revision; an edit increments the revision and preserves provenance.

### API

Add workspace-scoped endpoints with existing role enforcement:

- `GET /api/task-proposals`: list proposals by status, source, and project;
- `POST /api/task-proposals`: ingest an orchestrator proposal idempotently;
- `PUT /api/task-proposals/[id]`: edit or dismiss a pending proposal with a revision guard;
- `POST /api/task-proposals/[id]/accept`: accept and launch with a revision guard.

The accept endpoint runs one immediate database transaction:

1. verify the proposal is pending, current, unexpired, and visible to the workspace;
2. verify the caller is a human operator;
3. create one task containing the approved objective and context;
4. attach the proposal ID, source, approval identity, and route forecast to task metadata;
5. mark the proposal accepted and store the task ID;
6. commit, then emit proposal and task events.

Retries return the already-created task instead of creating a duplicate. The resulting task enters the state consumed by the external orchestrator. Mission Control does not select the final provider in this transaction.

### Orchestrator flow

For chat proposals:

1. Receive the bounded conversation context and explicit request or suggested next action.
2. Generate zero to three concrete proposals.
3. Reject vague, duplicate, or non-actionable output before ingestion.
4. Post accepted proposal candidates to Mission Control.

For automatic proposals:

1. Subscribe to Mission Control events or poll from the last durable cursor.
2. Evaluate only the bounded event types in the first release.
3. Fetch the minimum linked task, run, review, and project context.
4. Generate zero to three proposals, deduplicate, and ingest them.

After human acceptance:

1. Observe the created runnable task.
2. Re-evaluate complexity, risk, quotas, runtime availability, and policy.
3. Select Claude, Codex, or the local LLM.
4. Acquire the existing lease and execute through the selected adapter.
5. Persist the final route and receipt and continue through the existing review flow.

## Safety and Authorization

- Agents and orchestrator identities may create proposals but cannot accept them.
- Only an authenticated human operator can accept a proposal.
- High- and critical-risk proposals use the same visible card but remain subject to the orchestrator's stronger approval and `ship` policies after task creation.
- Accepting a proposal authorizes creation and immediate orchestration of that task. It does not authorize production deployment, merge, deletion, purchase, or other separately protected actions.
- Proposal content is treated as untrusted input and validated for length, JSON shape, workspace scope, and safe rendering.
- Source references are identifiers or internal links, not executable instructions.

## Failure Handling

- If proposal ingestion is retried, the idempotency key returns the existing proposal.
- If a card is stale, the API returns a revision conflict and the UI reloads the latest version without losing a local edit.
- If acceptance races with dismissal, expiry, or another acceptance, exactly one transition wins.
- If task creation fails, the proposal remains pending because acceptance is transactional.
- If the task is created but orchestration is unavailable, the task remains visible in an actionable waiting state with the routing reason; it is not recreated.
- If the route forecast differs from the final route, both are retained for audit rather than rewriting history.
- Expired proposals are hidden from the default view but remain queryable for audit.

## Events and Observability

Emit structured events for `proposal.created`, `proposal.updated`, `proposal.dismissed`, `proposal.accepted`, and `proposal.expired`. The acceptance event includes proposal ID, task ID, approving user, revision, and source but no secret provider credentials or full private transcripts.

The UI shows proposal age, source, acceptance state, resulting task, final executor when known, and failure or waiting reason. Metrics cover proposals created, accepted, dismissed, expired, duplicate-suppressed, time to decision, and forecast-to-final-route changes.

## Delivery Sequence

1. Add proposal schema, validation, persistence, API, events, and transactional acceptance.
2. Add proposal cards to the Tasks surface with validate, modify, dismiss, loading, conflict, empty, and failure states.
3. Connect embedded-chat proposals through the unified ingestion contract.
4. Connect automatic proposals for completion, failure, `awaiting_owner`, and review rejection events.
5. Connect accepted tasks to the external orchestrator and record forecast versus final route.
6. Add observability, expiry handling, and end-to-end verification.

The existing clarification work should be preserved during implementation. Reuse its human-only authorization and optimistic-concurrency ideas, but do not force proposal records into its task-metadata schema.

## Verification

Unit tests must cover:

- proposal schema validation and content limits;
- idempotency and workspace isolation;
- revision conflicts and legal lifecycle transitions;
- human-only acceptance;
- route-forecast serialization without provider-policy branching;
- orchestrator deduplication for chat and event sources.

Integration tests must prove:

- both sources create the same proposal representation;
- one acceptance creates exactly one linked task;
- failed transactional acceptance leaves the proposal pending;
- simultaneous accepts cannot create duplicate tasks;
- accepted tasks reach the external orchestrator;
- orchestrator unavailability leaves one recoverable task;
- final route and receipt are linked back to the proposal.

UI tests must cover:

- the one-click fast path;
- optional editing and dismissal;
- stale revision recovery;
- loading, empty, error, expired, and accepted states;
- keyboard operation, focus behavior, accessible names, and mobile layout.

Before completion, run the repository's lint, typecheck, unit, API parity, and relevant browser tests. The draft PR must remain unmerged until the complete flow is reviewable.
