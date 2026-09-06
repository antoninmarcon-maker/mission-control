# Task Proposals Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workspace-scoped proposal inbox whose cards can be edited, dismissed, or atomically accepted into one runnable Mission Control task.

**Architecture:** Store proposals in a dedicated SQLite table and expose a typed REST lifecycle. Acceptance is a human-only, revision-guarded transaction that creates one task assigned back to the orchestrator. A focused proposal rail above the task board provides the one-click fast path and receives workspace-scoped SSE updates.

**Tech Stack:** Next.js App Router, TypeScript, Zod, better-sqlite3, Zustand, next-intl, Vitest, Testing Library

**Spec:** `docs/superpowers/specs/2026-09-05-orchestrator-task-proposals-design.md`

## Global Constraints

- Mission Control persists proposals and human decisions; the external orchestrator owns routing and execution.
- No proposal becomes a task without an authenticated human operator action.
- Acceptance authorizes task creation and orchestration, not merge, deployment, deletion, purchase, or another protected action.
- One `(workspace_id, idempotency_key)` creates at most one proposal, and one proposal creates at most one task.
- The existing uncommitted clarification implementation is preserved and committed as a separate reviewable checkpoint before proposal work.
- Stage named files only; never use `git add -A` in this worktree.

---

### Task 1: Preserve the existing clarification gate

**Files:**
- Modify: `src/app/api/tasks/[id]/route.ts`
- Modify: `src/app/api/tasks/route.ts`
- Modify: `src/components/panels/task-board-panel.tsx`
- Modify: `src/lib/task-dispatch.ts`
- Create: `src/app/api/tasks/[id]/clarification/route.ts`
- Create: `src/components/panels/task-clarification.tsx`
- Create: `src/lib/task-clarification.ts`
- Test: `src/components/panels/task-clarification.test.tsx`
- Test: `src/lib/__tests__/task-clarification-route.test.ts`
- Test: `src/lib/__tests__/task-clarification.test.ts`
- Test: `src/lib/__tests__/task-dispatch-reconciliation.test.ts`

**Interfaces:**
- Consumes: existing task metadata, task update routes, and dispatcher prompt building.
- Produces: `Clarification`, `questionSetSchema`, `answerSetSchema`, `clarificationPrompt(metadata)`, and `CLARIFICATION_READY_SQL` as an independently tested human-decision gate.

- [ ] **Step 1: Verify the existing clarification implementation**

Run:

```bash
pnpm test -- src/lib/__tests__/task-clarification.test.ts src/lib/__tests__/task-clarification-route.test.ts src/components/panels/task-clarification.test.tsx src/lib/__tests__/task-dispatch-reconciliation.test.ts
```

Expected: the repository Vitest run completes with all tests passing. This exact baseline passed on 2026-09-05 with 186 files and 1,590 tests.

- [ ] **Step 2: Verify static types before checkpointing**

Run:

```bash
pnpm typecheck
```

Expected: exit code 0 and no TypeScript diagnostic.

- [ ] **Step 3: Commit only the clarification files**

```bash
git add 'src/app/api/tasks/[id]/route.ts' src/app/api/tasks/route.ts src/components/panels/task-board-panel.tsx src/lib/task-dispatch.ts 'src/app/api/tasks/[id]/clarification/route.ts' src/components/panels/task-clarification.tsx src/lib/task-clarification.ts src/components/panels/task-clarification.test.tsx src/lib/__tests__/task-clarification-route.test.ts src/lib/__tests__/task-clarification.test.ts src/lib/__tests__/task-dispatch-reconciliation.test.ts
git diff --cached --check
git commit -m "feat: require human task clarification before dispatch"
```

Expected: only the listed clarification files enter the commit; the design and plan commits remain separate.

### Task 2: Add the proposal domain model and migration

**Files:**
- Create: `src/lib/task-proposals.ts`
- Modify: `src/lib/migrations.ts`
- Test: `src/lib/__tests__/task-proposals.test.ts`

**Interfaces:**
- Consumes: Zod and better-sqlite3 migration conventions.
- Produces: `TaskProposal`, `TaskProposalInput`, `taskProposalInputSchema`, `taskProposalEditSchema`, `taskProposalDecisionSchema`, `mapTaskProposalRow(row)`, and `expirePendingTaskProposals(db, workspaceId, now)`.

- [ ] **Step 1: Write failing schema and lifecycle tests**

Create tests that import the not-yet-created module and assert:

```ts
const valid = taskProposalInputSchema.parse({
  sourceType: 'chat',
  sourceRef: 'conversation:42',
  idempotencyKey: 'chat:42:fix-login',
  title: 'Repair the login redirect',
  objective: 'Return users to the requested page after authentication.',
  context: 'The completed auth audit found that callbackUrl is discarded.',
  rationale: 'This is the only unresolved finding from the audit.',
  risk: 'medium',
  routeForecast: { runtime: 'codex', model: 'gpt-5.6-sol', reason: 'Repository change with tests.' },
  projectId: 7,
})
expect(valid.title).toBe('Repair the login redirect')
expect(taskProposalInputSchema.safeParse({ ...valid, title: '' }).success).toBe(false)
expect(taskProposalInputSchema.safeParse({ ...valid, risk: 'urgent' }).success).toBe(false)
```

Add a migration test that runs `runMigrations()` twice against a temporary database, inspects `PRAGMA table_info(task_proposals)`, and verifies the unique index rejects a duplicate `(workspace_id, idempotency_key)`.

Add lifecycle tests proving `expirePendingTaskProposals` changes only pending rows whose `expires_at <= now`, is workspace-scoped, returns the expired proposal IDs for event emission, and is idempotent on a second call.

- [ ] **Step 2: Run the tests and verify the missing implementation**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/task-proposals.test.ts
```

Expected: FAIL because `@/lib/task-proposals` and migration `056_task_proposals` do not exist.

- [ ] **Step 3: Implement the proposal contracts**

Create the Zod contract with these exact limits:

```ts
export const taskProposalInputSchema = z.object({
  sourceType: z.enum(['chat', 'event']),
  sourceRef: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(240),
  title: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(2000),
  context: z.string().trim().min(1).max(8000),
  rationale: z.string().trim().min(1).max(2000),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  routeForecast: z.object({
    runtime: z.enum(['local', 'codex', 'claude']),
    model: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().min(1).max(500),
  }).optional(),
  projectId: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  expiresAt: z.number().int().positive().optional(),
})

export const taskProposalEditSchema = taskProposalInputSchema
  .pick({ title: true, objective: true, context: true })
  .partial()
  .extend({ revision: z.string().uuid(), action: z.enum(['edit', 'dismiss']), dismissalReason: z.string().trim().max(1000).optional() })

export const taskProposalDecisionSchema = z.object({ revision: z.string().uuid() })
```

`mapTaskProposalRow` must parse `route_forecast` and `metadata` into objects and expose camelCase fields without accepting malformed JSON as executable data.

`expirePendingTaskProposals` performs one workspace-scoped update transaction, assigns a new revision to each expired row, and returns the parsed rows that actually transitioned. Acceptance must call this helper before checking proposal state so an expired proposal can never be launched.

- [ ] **Step 4: Add migration `056_task_proposals`**

Append one migration that creates the table and indexes:

```sql
CREATE TABLE task_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  project_id INTEGER,
  source_type TEXT NOT NULL CHECK(source_type IN ('chat','event')),
  source_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  context TEXT NOT NULL,
  rationale TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('low','medium','high','critical')),
  route_forecast TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','dismissed','expired')),
  revision TEXT NOT NULL,
  orchestrator_agent TEXT NOT NULL,
  created_by TEXT NOT NULL,
  accepted_by TEXT,
  accepted_at INTEGER,
  dismissed_by TEXT,
  dismissed_at INTEGER,
  dismissal_reason TEXT,
  task_id INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(workspace_id, idempotency_key),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL
);
CREATE INDEX idx_task_proposals_workspace_status ON task_proposals(workspace_id, status, created_at DESC);
CREATE INDEX idx_task_proposals_source ON task_proposals(workspace_id, source_type, source_ref);
```

- [ ] **Step 5: Run the focused tests**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/task-proposals.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the domain model**

```bash
git add src/lib/task-proposals.ts src/lib/migrations.ts src/lib/__tests__/task-proposals.test.ts
git commit -m "feat: add task proposal persistence"
```

### Task 3: Add proposal ingestion, listing, editing, and acceptance APIs

**Files:**
- Create: `src/app/api/task-proposals/route.ts`
- Create: `src/app/api/task-proposals/[id]/route.ts`
- Create: `src/app/api/task-proposals/[id]/accept/route.ts`
- Modify: `src/lib/event-bus.ts`
- Modify: `src/app/api/index/route.ts`
- Modify: `openapi.json`
- Test: `src/lib/__tests__/task-proposals-route.test.ts`

**Interfaces:**
- Consumes: Task 2 schemas, `requireRole`, `requireWorkspaceId`, `mutationLimiter`, tasks/project schema, `audit_log`, and `eventBus`.
- Produces: idempotent proposal ingestion; filtered listing and summary metrics; revision-guarded edit/dismiss; human-only `accept` returning `{ proposal, task }`.

- [ ] **Step 1: Write failing route tests**

Cover these observable responses with isolated temporary databases and authenticated requests:

```ts
expect((await createProposal(input, agentAuth)).status).toBe(201)
expect((await createProposal(input, agentAuth)).status).toBe(200)
expect((await listProposals('status=pending', viewerAuth)).json()).toMatchObject({ total: 1 })
expect((await acceptProposal(id, revision, agentAuth)).status).toBe(403)
expect((await acceptProposal(id, 'stale-revision', humanAuth)).status).toBe(409)
const accepted = await acceptProposal(id, revision, humanAuth)
expect(accepted.status).toBe(200)
expect((await accepted.json()).task.assigned_to).toBe('antonin-policy-engine')
expect((await acceptProposal(id, revision, humanAuth)).status).toBe(200)
expect(taskCountForProposal(id)).toBe(1)
```

Also prove workspace A cannot list, edit, dismiss, or accept workspace B's proposal. Seed an already expired row and assert listing transitions it to `expired`, emits `proposal.expired`, and acceptance returns 409 without creating a task. Request `summary=1` and assert created/accepted/dismissed/expired counts, duplicate-suppressed count, average decision latency, and forecast-to-final-route-change count are workspace-scoped.

- [ ] **Step 2: Run tests and confirm missing routes**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/task-proposals-route.test.ts
```

Expected: FAIL because the route modules do not exist.

- [ ] **Step 3: Implement list and idempotent ingestion**

`POST /api/task-proposals` must derive `orchestrator_agent` from the authenticated agent identity. Human-created proposals may use the configured coordinator only when it is non-empty; otherwise return 409. Insert with `randomUUID()` revision and handle the unique-key collision by returning the existing scoped row. Record the collision as `proposal.duplicate_suppressed` in the workspace-scoped `audit_log` without copying proposal context into the audit detail.

`GET /api/task-proposals` accepts `status`, `source_type`, `source_ref`, `project_id`, `limit`, `offset`, and `summary`; it always begins with `WHERE workspace_id = ?` and caps `limit` at 200. Before reading, expire due pending rows through `expirePendingTaskProposals` and broadcast one `proposal.expired` event per returned row.

When `summary=1`, also return workspace-scoped observability values: lifecycle counts, duplicate-suppressed audit count, average seconds from creation to acceptance/dismissal/expiry, and the count of accepted tasks whose `metadata.proposal.final_route.runtime` differs from the stored forecast runtime. Use SQL aggregation and SQLite JSON functions; malformed task metadata contributes to no route-change count.

- [ ] **Step 4: Implement edit and dismissal**

Use an immediate transaction and the compare-and-swap predicate:

```sql
UPDATE task_proposals
SET title = ?, objective = ?, context = ?, revision = ?, updated_at = unixepoch()
WHERE id = ? AND workspace_id = ? AND status = 'pending' AND revision = ?
```

Dismissal sets `status`, actor, timestamp, reason, and a new revision. A zero-row update returns 409 after distinguishing not-found from stale/non-pending state.

- [ ] **Step 5: Implement atomic human acceptance**

Reject agent identities using the same human check as the clarification route. In one `db.transaction(...).immediate()` callback:

```ts
const description = [proposal.objective, '', '## Context', proposal.context, '', '## Why now', proposal.rationale].join('\n')
const taskMetadata = {
  proposal: {
    id: proposal.id,
    source_type: proposal.source_type,
    source_ref: proposal.source_ref,
    accepted_by: actor,
    route_forecast: safeJson(proposal.route_forecast),
  },
}
```

Insert the task with `status = 'assigned'`, `assigned_to = proposal.orchestrator_agent`, the proposal project, risk-mapped priority (`critical → critical`, `high → high`, `medium → medium`, `low → low`), and `created_by = actor`. Then update the pending proposal with `task_id`, acceptance fields, and `status = 'accepted'`. On a retry of an accepted proposal, return the linked task.

- [ ] **Step 6: Register events and API contracts**

Add `proposal.created`, `proposal.updated`, `proposal.dismissed`, `proposal.accepted`, and `proposal.expired` to `EventType`. Broadcast only workspace-scoped parsed rows. For every lifecycle transition, insert a compact workspace-scoped `audit_log` record containing proposal ID, source type, actor, revision, and linked task ID when present—never full context or credentials. Add all four endpoints to the API index and OpenAPI with operator/viewer roles and 200/201/400/403/404/409 responses.

- [ ] **Step 7: Run route and parity tests**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/task-proposals-route.test.ts src/lib/__tests__/api-contract-parity.test.ts src/lib/__tests__/event-workspace-isolation.test.ts
pnpm api:parity
```

Expected: all commands pass.

- [ ] **Step 8: Commit the API**

```bash
git add src/app/api/task-proposals src/lib/event-bus.ts src/app/api/index/route.ts openapi.json src/lib/__tests__/task-proposals-route.test.ts
git commit -m "feat: add task proposal lifecycle API"
```

### Task 4: Add the one-click proposal rail

**Files:**
- Create: `src/components/task-proposals/proposal-card.tsx`
- Create: `src/components/task-proposals/proposal-rail.tsx`
- Modify: `src/components/panels/task-board-panel.tsx`
- Modify: `src/lib/use-server-events.ts`
- Modify: `src/store/index.ts`
- Modify: `messages/en.json`
- Modify: `messages/fr.json`
- Modify: `messages/ar.json`
- Modify: `messages/de.json`
- Modify: `messages/es.json`
- Modify: `messages/ja.json`
- Modify: `messages/ko.json`
- Modify: `messages/pt.json`
- Modify: `messages/ru.json`
- Modify: `messages/zh.json`
- Modify: `messages/zh-tw.json`
- Test: `src/components/task-proposals/proposal-card.test.tsx`
- Test: `src/components/task-proposals/proposal-rail.test.tsx`

**Interfaces:**
- Consumes: Task 3 REST responses and SSE events.
- Produces: `ProposalCard`, `ProposalRail`, and Zustand proposal state with `setProposals`, `addProposal`, `updateProposal`, and `removeProposal`.

- [ ] **Step 1: Write failing card tests**

Render one pending proposal and verify:

```tsx
expect(screen.getByRole('heading', { name: 'Repair the login redirect' })).toBeVisible()
expect(screen.getByText('Return users to the requested page after authentication.')).toBeVisible()
expect(screen.getByText(/Codex/)).toBeVisible()
await user.click(screen.getByRole('button', { name: 'Validate and launch' }))
expect(accept).toHaveBeenCalledWith({ id: 12, revision: proposal.revision })
```

Add tests for optional edit, dismissal, disabled loading state, accepted task link, 409 reload callback, keyboard focus, and a narrow mobile container.

- [ ] **Step 2: Run tests and verify missing components**

Run:

```bash
pnpm exec vitest run src/components/task-proposals/proposal-card.test.tsx src/components/task-proposals/proposal-rail.test.tsx
```

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement focused components**

Keep the fast path visible on the collapsed card. `ProposalCard` receives:

```ts
type ProposalCardProps = {
  proposal: TaskProposal
  compact?: boolean
  onAccept: (proposal: TaskProposal) => Promise<void>
  onEdit: (proposal: TaskProposal, patch: ProposalEdit) => Promise<void>
  onDismiss: (proposal: TaskProposal, reason?: string) => Promise<void>
}
```

Show title, objective, rationale, age, source, risk badge, and route forecast. Put context and editing behind an accessible disclosure. Never present the forecast as guaranteed routing.

`ProposalRail` fetches `/api/task-proposals?status=pending&limit=20`, renders a horizontally scrollable section above the Kanban, and replaces an accepted card with a task link from the acceptance response.

- [ ] **Step 4: Add store and SSE updates**

Add `proposals: TaskProposal[]` and the four mutation methods to the Zustand store. Dispatch proposal events in `useServerEvents`; `proposal.accepted`, `proposal.dismissed`, and `proposal.expired` remove the pending card, while `proposal.created` and `proposal.updated` upsert it.

- [ ] **Step 5: Add exact translation keys**

Add this key shape to all locale files, using native translations in French and English and the English text as an explicit fallback in the other locale files until localization review:

```json
"taskProposals": {
  "title": "Proposals",
  "empty": "No pending proposals",
  "validateLaunch": "Validate and launch",
  "modify": "Modify",
  "dismiss": "Dismiss",
  "context": "Context",
  "whyNow": "Why now",
  "forecast": "Expected route",
  "forecastDisclaimer": "The orchestrator rechecks the route at launch.",
  "accepted": "Task launched",
  "stale": "This proposal changed. The latest version has been loaded.",
  "failed": "The proposal could not be updated. Try again."
}
```

French uses `Propositions`, `Aucune proposition en attente`, `Valider et lancer`, `Modifier`, `Refuser`, `Contexte`, `Pourquoi maintenant`, `Exécuteur pressenti`, `L’orchestrateur revérifie l’exécuteur au lancement.`, `Tâche lancée`, `Cette proposition a changé. La dernière version a été chargée.`, and `La proposition n’a pas pu être mise à jour. Réessayez.`

- [ ] **Step 6: Run component, type, and lint checks**

Run:

```bash
pnpm exec vitest run src/components/task-proposals/proposal-card.test.tsx src/components/task-proposals/proposal-rail.test.tsx
pnpm typecheck
pnpm lint
```

Expected: all commands pass.

- [ ] **Step 7: Commit the UI**

```bash
git add src/components/task-proposals src/components/panels/task-board-panel.tsx src/lib/use-server-events.ts src/store/index.ts messages/*.json
git commit -m "feat: add one-click task proposal inbox"
```

### Task 5: Verify the foundation as a standalone deliverable

**Files:**
- Modify: `CHANGELOG.md`
- Test: `src/lib/__tests__/task-proposals-route.test.ts`
- Test: `src/components/task-proposals/proposal-rail.test.tsx`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: a manually ingestible proposal inbox that can launch exactly one orchestrator-owned task.

- [ ] **Step 1: Add the release note**

Under Unreleased, state that Mission Control now stores orchestrator proposals separately from tasks and provides human-only one-click acceptance.

- [ ] **Step 2: Run the repository quality gate**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm api:parity
pnpm build
```

Expected: every command exits 0.

- [ ] **Step 3: Commit the verified foundation**

```bash
git add CHANGELOG.md
git commit -m "docs: document task proposal inbox"
git push
```

Expected: draft PR #6 contains the complete foundation while remaining unmerged.
