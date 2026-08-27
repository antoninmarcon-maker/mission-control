# Antonin External Policy MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested one-shot external policy adapter that safely routes a mechanical Mission Control task to local Ollama and returns it for a distinct cloud review with fenced lease and hash-chained receipt evidence.

**Architecture:** Keep Mission Control core unchanged. Add small ESM modules under `ops/antonin-poc/policy-mvp/` for deterministic policy, file-backed fenced leases, hash-chained receipts, REST/Ollama clients, and one CLI composition root. All mutable state remains outside Git under an explicit absolute directory.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, built-in `fetch`, built-in `crypto`, filesystem primitives, Mission Control REST, Ollama OpenAI-compatible API.

**Spec:** `docs/superpowers/specs/2026-08-27-antonin-policy-mvp-design.md`

## Global Constraints

- Do not modify Mission Control application code or the Dash.
- Accept Mission Control only at a loopback `http://127.0.0.1:<port>` URL.
- Accept Ollama only at a loopback HTTP endpoint.
- Require an explicit absolute `ANTONIN_POLICY_STATE_DIR` outside Git and outside the Mission Control POC runtime.
- Never print or persist `MC_API_KEY` or subscription credentials.
- Process at most one task per invocation.
- Execute only low-risk text transformations; move all other tasks to `awaiting_owner`.
- Require a distinct cloud reviewer before `done`.
- Do not implement shell execution, Git, GitHub, `ship`, merge, deployment, deletion, or cloud fallback.
- Use TDD: every production behavior must first be observed failing in a focused test.
- Keep the PR draft; never run `ship ready`, merge, or deploy.

---

### Task 1: Policy, fenced lease, and receipt ledger core

**Files:**
- Create: `ops/antonin-poc/policy-mvp/policy-core.mjs`
- Create: `ops/antonin-poc/policy-mvp/lease-store.mjs`
- Create: `ops/antonin-poc/policy-mvp/receipt-ledger.mjs`
- Create: `ops/antonin-poc/policy-mvp/test/core.test.mjs`

**Interfaces:**
- Consumes: plain task objects, absolute external state path, owner string, clock injection for tests.
- Produces: `evaluateTask(task, options)`, `validateLoopbackHttpUrl(value, name)`, `LeaseStore`, and `ReceiptLedger`.

- [ ] **Step 1: Write failing policy tests**

Test that a medium-priority `Simple local sort` routes to `ollama/qwen2.5-coder:7b` with reviewer `poc-aegis-cloud`; high/critical, SOLIDE, deployment, database, security, secret, delete, merge, release, and non-mechanical tasks return `awaiting_owner`. Test that reviewer and route cannot resolve to the same identity.

- [ ] **Step 2: Verify policy tests fail for missing modules**

Run: `node --test ops/antonin-poc/policy-mvp/test/core.test.mjs`
Expected: FAIL because the core modules do not exist.

- [ ] **Step 3: Implement minimal policy and loopback URL validation**

Implement `POLICY_VERSION = "antonin-policy-v0"`, the exact allow/deny vocabulary from the spec, stable reason codes, and rejection of non-loopback or HTTPS URLs.

- [ ] **Step 4: Write and fail lease tests**

Test first acquisition token 1, same-owner renewal, different-owner exclusion, expired takeover token 2, stale-token completion rejection, matching release, and mode-600 state file.

- [ ] **Step 5: Implement the minimal `LeaseStore`**

Use `mkdir` as an atomic lock, bounded retry with injected clock/sleep, atomic temp-file rename, monotonic fencing tokens, `acquire`, `renew`, `assertCurrent`, and `release`.

- [ ] **Step 6: Write and fail receipt tests**

Test genesis append, second-record previous-hash link, successful verification, tamper detection, malformed-line rejection, and absence of raw `input`, `output`, or API-key fields.

- [ ] **Step 7: Implement the minimal `ReceiptLedger`**

Canonicalize recursively sorted object keys, compute SHA-256 over the record without `record_hash`, append one compact JSON line under the same atomic lock discipline, and verify the entire chain.

- [ ] **Step 8: Run focused tests and commit**

Run: `node --test ops/antonin-poc/policy-mvp/test/core.test.mjs`
Expected: all core tests PASS.

Commit: `feat: add external policy lease and receipt core`

### Task 2: REST/Ollama clients and one-shot orchestration

**Files:**
- Create: `ops/antonin-poc/policy-mvp/mc-client.mjs`
- Create: `ops/antonin-poc/policy-mvp/ollama-client.mjs`
- Create: `ops/antonin-poc/policy-mvp/run-once.mjs`
- Create: `ops/antonin-poc/policy-mvp/test/run-once.test.mjs`
- Create: `ops/antonin-poc/policy-mvp/README.md`
- Modify: `ops/antonin-poc/README.md`

**Interfaces:**
- Consumes: Task 1 exports, `MC_URL`, `MC_API_KEY`, `ANTONIN_POLICY_STATE_DIR`, optional reviewer/model/endpoint/TTL variables.
- Produces: `MissionControlClient`, `OllamaClient`, `processOne(config, deps)`, and CLI commands `process|status|verify-ledger`.

- [ ] **Step 1: Inspect the existing queue/task/comment/token route contracts**

Read `src/app/api/tasks/queue/route.ts`, task update routes, comments routes, and token routes. Record exact request/response fields in the implementer report before writing client tests.

- [ ] **Step 2: Write failing client contract tests**

Use a local fake HTTP server. Assert `x-api-key` is sent but never included in thrown errors, queue claim returns `null` on 204, JSON errors are bounded/redacted, task update/comment/token calls use the exact existing route schema, and non-loopback URLs are rejected.

- [ ] **Step 3: Implement minimal REST and Ollama clients**

Use built-in `fetch`, `AbortSignal.timeout`, exact route schemas, response-size/error truncation, and normalized `{ text, inputTokens, outputTokens }` from Ollama.

- [ ] **Step 4: Write failing orchestration tests**

Test: no queued task exits cleanly; rejected policy moves the claimed task to `awaiting_owner` without Ollama; allowed task acquires lease, calls Ollama, appends receipt, posts tokens, assigns the configured distinct reviewer, moves to `review`, and releases the lease; Ollama failure records failure and attempts `awaiting_owner`; a replaced fencing token blocks completion.

- [ ] **Step 5: Implement `processOne` and CLI parsing**

Compose dependencies without hidden globals. Validate all configuration before network calls. Hash task input and model output, never store raw text in the receipt, and return structured non-secret summaries for CLI rendering.

- [ ] **Step 6: Document safe operation and rollback**

Document environment variables, exact commands, the one-task limit, external state layout, review behavior, no cloud fallback, no repo execution, and archive-based rollback. Add a link from `ops/antonin-poc/README.md`.

- [ ] **Step 7: Run focused and regression tests**

Run:

```bash
node --test ops/antonin-poc/policy-mvp/test/*.test.mjs
bash ops/antonin-poc/test-mc-poc.sh
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm api:parity
git diff --check
```

Expected: all commands exit 0 and no secret appears in output.

- [ ] **Step 8: Commit and push to the existing draft PR**

Commit: `feat: add external policy adapter MVP`

Use `ship push -m` only if uncommitted changes remain. Confirm PR #1 stays draft. Do not run `ship ready`, merge, or deploy.
