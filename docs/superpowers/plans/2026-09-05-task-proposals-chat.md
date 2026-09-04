# Chat-Sourced Task Proposals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the embedded chat orchestrator publish task proposals that appear both inline with the source conversation and in the shared proposal inbox.

**Architecture:** Expose proposal ingestion through Mission Control's MCP/CLI surface so Claude, Codex, or another coordinator can submit the same REST contract without UI coupling. Chat rendering joins proposals by stable conversation/message source references and reuses the foundation card rather than inventing a second lifecycle.

**Tech Stack:** Node.js MCP server, Mission Control REST API, Next.js/React chat components, TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-09-05-orchestrator-task-proposals-design.md`

## Global Constraints

- Complete `2026-09-05-task-proposals-foundation.md` first.
- The chat route does not call a model solely to create proposal records.
- The coordinator decides whether the conversation yields zero to three concrete proposals and submits them through the unified API.
- Agent identities may create proposals but may not accept them.
- Inline and inbox cards must operate on the same proposal ID and revision.

---

### Task 1: Expose proposal tools to orchestrators

**Files:**
- Modify: `scripts/mc-mcp-server.cjs`
- Modify: `scripts/mc-cli.cjs`
- Modify: `SKILL.md`
- Test: `src/lib/__tests__/task-proposals-mcp.test.ts`

**Interfaces:**
- Consumes: `POST /api/task-proposals` and `GET /api/task-proposals` from the foundation.
- Produces: MCP tools `task_proposals_create` and `task_proposals_list`; CLI commands `proposals create` and `proposals list`.

- [ ] **Step 1: Write failing MCP contract tests**

Start the MCP server against a fake loopback Mission Control endpoint, send `tools/list`, and assert the two tool definitions. Invoke `task_proposals_create` with:

```json
{
  "sourceType": "chat",
  "sourceRef": "conversation:abc:message:17",
  "idempotencyKey": "chat:abc:17:repair-login",
  "title": "Repair the login redirect",
  "objective": "Preserve callbackUrl through authentication.",
  "context": "The audit result in message 17 identified the dropped parameter.",
  "rationale": "This is the remaining actionable finding.",
  "risk": "medium",
  "routeForecast": { "runtime": "codex", "reason": "Repository change with tests." }
}
```

Assert the fake server receives the exact JSON once and the MCP response returns the proposal ID and revision.

- [ ] **Step 2: Run the focused test**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/task-proposals-mcp.test.ts
```

Expected: FAIL because the proposal tools are absent.

- [ ] **Step 3: Implement MCP and CLI commands**

Add JSON schemas matching `TaskProposalInput`. Both commands must delegate to the REST endpoint and print/return the server response without reinterpreting routing. Redact API keys in errors using the server's existing redaction helper.

The CLI forms are:

```bash
pnpm mc proposals list --status pending --source-type chat --json
pnpm mc proposals create --json-file /absolute/path/to/proposal.json
```

Reject a relative `--json-file`, files larger than 64 KiB, malformed JSON, and unknown fields before the network call.

- [ ] **Step 4: Document the orchestrator contract**

Add the proposal endpoints and MCP tools to `SKILL.md`. State these invariants verbatim:

```text
Create zero to three proposals only when each describes a concrete follow-up.
Use sourceType=chat and a sourceRef containing the conversation and message IDs.
Do not accept your own proposal. A human operator must use Validate and launch.
The displayed route is a forecast; the external policy engine re-routes after approval.
```

- [ ] **Step 5: Run tests and commit**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/task-proposals-mcp.test.ts
pnpm typecheck
```

Expected: PASS, then commit:

```bash
git add scripts/mc-mcp-server.cjs scripts/mc-cli.cjs SKILL.md src/lib/__tests__/task-proposals-mcp.test.ts
git commit -m "feat: expose task proposals to orchestrators"
```

### Task 2: Render chat proposals inline

**Files:**
- Create: `src/components/chat/chat-proposals.tsx`
- Modify: `src/components/chat/message-list.tsx`
- Modify: `src/components/task-proposals/proposal-card.tsx`
- Test: `src/components/chat/chat-proposals.test.tsx`

**Interfaces:**
- Consumes: `ProposalCard` and `GET /api/task-proposals?source_type=chat&source_ref=...`.
- Produces: `ChatProposals({ conversationId, messageId })`, using compact cards linked to the shared lifecycle.

- [ ] **Step 1: Write failing inline-card tests**

Assert that a proposal whose `sourceRef` is `conversation:abc:message:17` renders directly after message 17, while a proposal for message 18 does not. Clicking `Validate and launch` must call the foundation accept endpoint and update both the inline card and the store-backed inbox state.

- [ ] **Step 2: Run the test and confirm the component is missing**

Run:

```bash
pnpm exec vitest run src/components/chat/chat-proposals.test.tsx
```

Expected: FAIL because `ChatProposals` does not exist.

- [ ] **Step 3: Implement source-reference matching and rendering**

Use one parser instead of substring matching:

```ts
export function chatProposalSource(conversationId: string, messageId: number): string {
  return `conversation:${encodeURIComponent(conversationId)}:message:${messageId}`
}
```

After each assistant/coordinator message, render `<ChatProposals compact conversationId={...} messageId={...} />`. Read proposals from the Zustand store first; fetch the filtered endpoint when the conversation opens or a `proposal.created` SSE event arrives.

- [ ] **Step 4: Verify focus and shared state**

Add assertions that the chat transcript keeps reading order, acceptance moves focus to the resulting task link, and dismissing inline removes the inbox copy because both use the same store item.

- [ ] **Step 5: Run checks and commit**

Run:

```bash
pnpm exec vitest run src/components/chat/chat-proposals.test.tsx src/components/task-proposals/proposal-card.test.tsx
pnpm typecheck
pnpm lint
```

Expected: all pass, then commit:

```bash
git add src/components/chat/chat-proposals.tsx src/components/chat/message-list.tsx src/components/task-proposals/proposal-card.tsx src/components/chat/chat-proposals.test.tsx
git commit -m "feat: show orchestrator proposals in chat"
```

### Task 3: Verify the chat-source slice end to end

**Files:**
- Create: `e2e/task-proposals-chat.spec.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1–2 and the foundation.
- Produces: a browser-tested flow from coordinator proposal to one-click task launch.

- [ ] **Step 1: Write the browser test**

Seed an operator, coordinator agent, conversation, message, and chat proposal. Open `/chat`, select the seeded conversation, validate the inline card, and assert `/tasks` contains exactly one linked assigned task and no pending copy.

- [ ] **Step 2: Run the browser test**

Run:

```bash
pnpm exec playwright test e2e/task-proposals-chat.spec.ts
```

Expected: PASS in Chromium at desktop and mobile project widths configured by the repository.

- [ ] **Step 3: Document and commit the chat slice**

Add an Unreleased note stating that embedded-chat coordinators can publish proposals through REST, MCP, or CLI and that the same card appears inline and in Tasks.

```bash
git add e2e/task-proposals-chat.spec.ts CHANGELOG.md
git commit -m "test: cover chat task proposal launch"
git push
```

Expected: draft PR #6 remains open and includes a usable chat-source flow.
