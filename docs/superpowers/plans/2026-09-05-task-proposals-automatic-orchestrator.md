# Automatic Orchestrator Task Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the external policy engine detect actionable follow-ups from Mission Control task outcomes, publish deduplicated proposals, and execute accepted tasks through its existing Claude, Codex, or local route policy.

**Architecture:** Add a durable updated-task scan with an external cursor and deterministic candidate extraction. Clear signals create proposals directly; successful tasks create proposals only from structured `next_actions` metadata. The accepted task returns to the existing policy queue, where routing is re-evaluated and the forecast and final route are both retained.

**Tech Stack:** Node.js ES modules, Mission Control REST API, external policy engine, file-backed durable state, Vitest/Node test runner

**Spec:** `docs/superpowers/specs/2026-09-05-orchestrator-task-proposals-design.md`

## Global Constraints

- Complete the foundation plan before this plan; the chat plan may run independently after the foundation.
- Proposal generation is read-only with respect to repositories and external systems.
- The automatic scan never accepts or executes a proposal.
- Server idempotency and a durable external cursor make retries safe.
- Final routing always re-evaluates current complexity, risk, quotas, and availability; the stored forecast is never binding.
- Existing lease, receipt, review, and `ship` policy remain authoritative.

---

### Task 1: Add a durable automatic-proposal candidate feed

**Files:**
- Modify: `src/app/api/tasks/route.ts`
- Test: `src/lib/__tests__/task-proposal-candidates.test.ts`

**Interfaces:**
- Consumes: workspace-scoped task listing.
- Produces: `GET /api/tasks?updated_since=<unix-seconds>&proposal_candidate=1`, ordered by `(updated_at, id)` with a stable cursor.

- [ ] **Step 1: Write failing candidate-feed tests**

Seed tasks on both sides of a timestamp and across two workspaces. Assert:

```ts
const body = await listCandidateTasks({ updatedSince: 1_788_560_000, workspace: 1 })
expect(body.tasks.map((task: { id: number }) => task.id)).toEqual([olderId, newerId])
expect(body.nextCursor).toEqual({ updatedAt: newerUpdatedAt, id: newerId })
expect(body.tasks.every((task: { workspace_id: number }) => task.workspace_id === 1)).toBe(true)
```

Candidate status is limited to `done`, `failed`, `awaiting_owner`, `review`, and `quality_review`. A cursor query using both `updated_since` and `after_id` must not repeat rows with the same timestamp.

- [ ] **Step 2: Run the test and observe the absent filter**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/task-proposal-candidates.test.ts
```

Expected: FAIL because task listing has no candidate cursor.

- [ ] **Step 3: Implement stable cursor filtering**

Use this predicate only when `proposal_candidate=1`:

```sql
AND t.status IN ('done','failed','awaiting_owner','review','quality_review')
AND (t.updated_at > ? OR (t.updated_at = ? AND t.id > ?))
ORDER BY t.updated_at ASC, t.id ASC
```

Validate `updated_since` as a non-negative safe integer, `after_id` as a non-negative safe integer, and cap the candidate feed at 200. Return `nextCursor` from the final row or echo the input cursor when empty.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/task-proposal-candidates.test.ts src/lib/__tests__/workspace-isolation-enforcement.test.ts
```

Expected: PASS, then commit:

```bash
git add src/app/api/tasks/route.ts src/lib/__tests__/task-proposal-candidates.test.ts
git commit -m "feat: expose task proposal candidate cursor"
```

### Task 2: Add deterministic proposal extraction and route forecasts

**Files:**
- Create: `ops/antonin-poc/policy-mvp/proposal-engine.mjs`
- Modify: `ops/antonin-poc/policy-mvp/policy-core.mjs`
- Test: `ops/antonin-poc/policy-mvp/test/proposal-engine.test.mjs`

**Interfaces:**
- Consumes: parsed Mission Control task rows and existing policy evaluation.
- Produces: `proposalCandidatesForTask(task)` and `forecastRouteForProposal(proposal, policyContext)`.

- [ ] **Step 1: Write failing extraction tests**

Assert these exact outcomes:

```js
assert.equal(proposalCandidatesForTask({ id: 7, status: 'failed', title: 'Import catalog', error_message: 'CSV parser rejected row 81' }).length, 1)
assert.equal(proposalCandidatesForTask({ id: 8, status: 'awaiting_owner', title: 'Deploy preview', error_message: 'Browser login required' })[0].risk, 'medium')
assert.equal(proposalCandidatesForTask({ id: 9, status: 'done', title: 'Audit auth', metadata: {} }).length, 0)
assert.equal(proposalCandidatesForTask({ id: 10, status: 'done', title: 'Audit auth', metadata: { next_actions: [{ title: 'Repair callback', objective: 'Preserve callbackUrl', context: 'Finding A3', risk: 'medium' }] } }).length, 1)
```

Add idempotency assertions using `event:<task-id>:<updated-at>:<normalized-action-hash>`. Review states yield a proposal only when metadata contains a rejection or required follow-up; ordinary review produces none.

- [ ] **Step 2: Run the test and verify the module is missing**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/proposal-engine.test.mjs
```

Expected: FAIL because `proposal-engine.mjs` does not exist.

- [ ] **Step 3: Implement bounded extraction**

Return zero to three candidates. Failure generates one diagnostic/recovery objective from title and bounded error text. `awaiting_owner` generates one blocker-resolution objective. Review rejection reads bounded `metadata.review_feedback` or `metadata.aegis_rejections`. Success reads only a validated `metadata.next_actions` array; it does not invent follow-ups from free-form output.

Normalize content to the foundation limits and reject entries without title, objective, context, or rationale.

- [ ] **Step 4: Implement policy-owned route forecasts**

Add a pure wrapper in `policy-core.mjs`:

```js
export function forecastProposalRoute(proposal, options = {}) {
  const task = {
    title: proposal.title,
    description: `${proposal.objective}\n${proposal.context}`,
    priority: proposal.risk === 'critical' ? 'critical' : proposal.risk,
    metadata: { proposal_forecast: true },
  }
  const decision = evaluateTask(task, options)
  if (decision.status !== 'execute_local' || !decision.route) return null
  const parsed = parseRoute(decision.route)
  if (!parsed) return null
  const runtime = parsed.provider === 'ollama'
    ? 'local'
    : parsed.provider === 'codex'
      ? 'codex'
      : parsed.provider === 'claude-code'
        ? 'claude'
        : null
  if (!runtime) return null
  return {
    runtime,
    model: parsed.detail,
    reason: decision.reasonCode,
  }
}
```

This deliberately reflects the current `evaluateTask()` contract (`status`, `route`, `reasonCode`). Map only to `local`, `codex`, or `claude`; if the policy cannot produce a safe forecast, omit `routeForecast` instead of guessing. The post-acceptance route planner remains the only authority that may climb from local to Claude or Codex.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/proposal-engine.test.mjs ops/antonin-poc/policy-mvp/test/core.test.mjs
```

Expected: PASS, then commit:

```bash
git add ops/antonin-poc/policy-mvp/proposal-engine.mjs ops/antonin-poc/policy-mvp/policy-core.mjs ops/antonin-poc/policy-mvp/test/proposal-engine.test.mjs
git commit -m "feat(policy): derive automatic task proposals"
```

### Task 3: Add Mission Control proposal methods and a durable scan cursor

**Files:**
- Modify: `ops/antonin-poc/policy-mvp/mc-client.mjs`
- Create: `ops/antonin-poc/policy-mvp/proposal-cursor-store.mjs`
- Test: `ops/antonin-poc/policy-mvp/test/proposal-client.test.mjs`
- Test: `ops/antonin-poc/policy-mvp/test/proposal-cursor-store.test.mjs`

**Interfaces:**
- Consumes: candidate feed and proposal ingestion API.
- Produces: `missionControl.listProposalCandidates(cursor)`, `missionControl.createProposal(input)`, and atomic `ProposalCursorStore.read()/commit(cursor)`.

- [ ] **Step 1: Write failing client and cursor tests**

Assert the client requests the candidate query with encoded cursor fields and posts the exact proposal body. Simulate timeout after a successful POST and prove retry returns the server's existing idempotent proposal.

For the cursor store, assert a write uses a temporary file plus atomic rename, files are mode `600`, malformed JSON fails closed, and a cursor cannot move backward.

- [ ] **Step 2: Run the tests**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/proposal-client.test.mjs ops/antonin-poc/policy-mvp/test/proposal-cursor-store.test.mjs
```

Expected: FAIL because the methods and store are absent.

- [ ] **Step 3: Implement the client methods**

`listProposalCandidates({ updatedAt, id })` calls `/api/tasks?proposal_candidate=1&updated_since=...&after_id=...&limit=200` and validates `{ tasks, nextCursor }`. `createProposal(input)` posts to `/api/task-proposals` and requires a response containing numeric `proposal.id` and non-empty `proposal.revision`.

- [ ] **Step 4: Implement the cursor store**

Persist this exact shape under the external policy state directory:

```json
{ "schema_version": 1, "updated_at": 1788560000, "id": 42 }
```

Use the existing state-directory safety rules. Commit the cursor only after every candidate in the page was evaluated and every emitted proposal received an idempotent server acknowledgement.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/proposal-client.test.mjs ops/antonin-poc/policy-mvp/test/proposal-cursor-store.test.mjs
```

Expected: PASS, then commit:

```bash
git add ops/antonin-poc/policy-mvp/mc-client.mjs ops/antonin-poc/policy-mvp/proposal-cursor-store.mjs ops/antonin-poc/policy-mvp/test/proposal-client.test.mjs ops/antonin-poc/policy-mvp/test/proposal-cursor-store.test.mjs
git commit -m "feat(policy): persist automatic proposal scans"
```

### Task 4: Add the orchestrator proposal command

**Files:**
- Modify: `ops/antonin-poc/policy-mvp/run-once.mjs`
- Modify: `ops/antonin-poc/policy-mvp/README.md`
- Test: `ops/antonin-poc/policy-mvp/test/run-once.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `runCommand('propose')` that scans one page, emits zero or more proposals, and returns counts plus the committed cursor.

- [ ] **Step 1: Write failing orchestration tests**

Use fake dependencies to prove:

```js
assert.deepEqual(await runCommand('propose', env, deps), {
  outcome: 'proposals_scanned',
  scanned: 4,
  created: 2,
  duplicates: 1,
  skipped: 1,
  cursor: { updatedAt: 1788560000, id: 44 },
})
```

Add failure assertions: a rejected proposal POST leaves the old cursor; a retry reposts the same idempotency key; an empty page returns zero counts; three candidates from one task are the maximum.

- [ ] **Step 2: Run the failing tests**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/run-once.test.mjs
```

Expected: FAIL because command `propose` is unsupported.

- [ ] **Step 3: Implement the bounded scan command**

Compose the cursor store, Mission Control client, candidate extractor, and route forecaster. Process tasks sequentially so cursor semantics remain obvious. Log task IDs and counts, never raw context, prompts, API keys, or provider credentials.

Add the documented command:

```bash
node ops/antonin-poc/policy-mvp/run-once.mjs propose
```

Document that a scheduler may call it repeatedly; one invocation scans at most 200 task changes and launches nothing.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/run-once.test.mjs ops/antonin-poc/policy-mvp/test/proposal-engine.test.mjs
```

Expected: PASS, then commit:

```bash
git add ops/antonin-poc/policy-mvp/run-once.mjs ops/antonin-poc/policy-mvp/README.md ops/antonin-poc/policy-mvp/test/run-once.test.mjs
git commit -m "feat(policy): scan and publish task proposals"
```

### Task 5: Link accepted proposals to final routing and receipts

**Files:**
- Modify: `ops/antonin-poc/policy-mvp/run-once.mjs`
- Modify: `ops/antonin-poc/policy-mvp/receipt-ledger.mjs`
- Modify: `ops/antonin-poc/policy-mvp/mc-client.mjs`
- Test: `ops/antonin-poc/policy-mvp/test/run-once.test.mjs`
- Test: `ops/antonin-poc/policy-mvp/test/core.test.mjs`

**Interfaces:**
- Consumes: existing accepted task metadata at `task.metadata.proposal` and the normal `processOne()` route policy.
- Produces: final task metadata and receipt fields `proposal_id`, `route_forecast`, and `final_route`.

- [ ] **Step 1: Write failing forecast-versus-final tests**

Seed an accepted proposal forecasting local execution, then make current quota/risk policy select Codex. Assert the task completes through the Codex fake runner and retains:

```json
{
  "proposal": {
    "id": 12,
    "route_forecast": { "runtime": "local", "model": "qwen2.5-coder:7b", "reason": "low-risk" },
    "final_route": { "runtime": "codex", "model": "gpt-5.6-sol", "reason": "local-quota-unavailable" }
  }
}
```

Assert the receipt contains proposal ID plus hashes and route metadata, not raw proposal context.

- [ ] **Step 2: Run the test and verify missing final-route linkage**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/run-once.test.mjs ops/antonin-poc/policy-mvp/test/core.test.mjs
```

Expected: FAIL because final routing is not linked to the proposal.

- [ ] **Step 3: Persist the route decision without changing policy**

After `planRoute()` and before provider execution, merge `final_route` into the existing proposal metadata. Add `proposal_id`, `route_forecast`, and `final_route` to the receipt input. Keep all existing lease fencing, fallback, token reconciliation, and distinct-review behavior unchanged.

- [ ] **Step 4: Run policy tests and commit**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/run-once.test.mjs ops/antonin-poc/policy-mvp/test/core.test.mjs
```

Expected: PASS, then commit:

```bash
git add ops/antonin-poc/policy-mvp/run-once.mjs ops/antonin-poc/policy-mvp/receipt-ledger.mjs ops/antonin-poc/policy-mvp/mc-client.mjs ops/antonin-poc/policy-mvp/test/run-once.test.mjs ops/antonin-poc/policy-mvp/test/core.test.mjs
git commit -m "feat(policy): audit proposal routing decisions"
```

### Task 6: Verify the complete orchestrator flow

**Files:**
- Create: `ops/antonin-poc/policy-mvp/test/proposal-flow.test.mjs`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: all three plans.
- Produces: an integration proof from automatic signal through human acceptance to policy-routed execution and receipt.

- [ ] **Step 1: Build the loopback integration test**

Use temporary Mission Control state and fake local/Claude/Codex runners. Seed a failed task, run `propose`, accept the created proposal as a human operator, run `process`, and assert:

```text
one failed source task
one accepted proposal
one linked assigned task
one selected provider execution
one review transition
one receipt linked by proposal ID
zero duplicate proposals or tasks after retrying every mutation
```

- [ ] **Step 2: Run focused integration and full quality checks**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/proposal-flow.test.mjs
pnpm lint
pnpm typecheck
pnpm test
pnpm api:parity
pnpm build
```

Expected: every command exits 0.

- [ ] **Step 3: Document and commit the completed flow**

Add an Unreleased note describing chat and automatic proposal sources, one-click human acceptance, and policy-owned routing across local, Codex, and Claude.

```bash
git add ops/antonin-poc/policy-mvp/test/proposal-flow.test.mjs CHANGELOG.md
git commit -m "test: verify orchestrator task proposal flow"
git push
```

Expected: draft PR #6 contains the full reviewable feature and remains unmerged.
