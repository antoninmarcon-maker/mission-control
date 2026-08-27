# External policy adapter MVP

This one-shot adapter claims at most one Mission Control task, applies the v0 local-execution policy, and either sends the task back to its owner or runs a harmless text-only Ollama completion. Successful local work is always assigned to a distinct cloud reviewer and moved to `review`; the adapter never approves its own output.

## Safety boundary

- Mission Control and Ollama must use loopback HTTP URLs (`127.0.0.1` or `::1`). HTTPS and non-loopback hosts are rejected before any request.
- `ANTONIN_POLICY_STATE_DIR` must be an absolute directory outside this repository and outside both Mission Control runtime directories. The canonical path, descendants, and symlink aliases of `MISSION_CONTROL_DATA_DIR` and `MC_POC_STATE_DIR` are rejected. Do not point it at `/` or the repository either.
- The adapter only sends a text prompt to Ollama. It cannot execute shell commands, edit a repository, use Git/GitHub, deploy, merge, delete, or perform arbitrary network work.
- The local prompt explicitly forbids filesystem, network, Git, deployment, shell, and other external side effects.
- There is no cloud execution fallback. The route ladder stops at the local Ollama rung: cloud execution needs a subprocess runner that does not exist and is gated by its own spec, so any cloud executor route is refused to the owner. Policy rejection or an execution failure before completion starts moves the task to `awaiting_owner` when Mission Control is reachable. A partially confirmed completion remains pending for safe reconciliation instead of being reclassified.
- Quota admission runs before execution and can defer a task. A deferral is not work: it writes no completion journal entry, no token record and no receipt, and it releases the lease.
- Receipts contain SHA-256 input/output hashes and execution metadata, never raw task text, model output, API keys, or subscription credentials.
- One `process` invocation claims zero or one task and then exits. No daemon or scheduler is included.

## Configuration

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `ANTONIN_POLICY_STATE_DIR` | Absolute external directory for leases, the completion journal, and the receipt ledger. |
| `MC_URL` | Loopback Mission Control origin, for example `http://127.0.0.1:4318`. |
| `MC_API_KEY` | Mission Control operator API key. It is sent as `x-api-key` and is never printed or persisted by the adapter. |

Optional environment variables:

| Variable | Default |
| --- | --- |
| `ANTONIN_POLICY_AGENT` | `antonin-policy-engine` |
| `ANTONIN_CLOUD_REVIEWER` | `poc-aegis-cloud` |
| `LOCAL_LLM_ENDPOINT` | `http://127.0.0.1:11434/v1` |
| `LOCAL_LLM_MODEL` | `qwen2.5-coder:7b` |
| `ANTONIN_LEASE_TTL_MS` | `120000` |
| `ANTONIN_REVIEWER_PROVIDER` | unset — the reviewer is an ordinary Mission Control agent and no window is tracked for it. Set it to `claude-code` or `codex` to enforce reviewer capacity. |
| `ANTONIN_QUOTA_WEEKLY_RESERVE` | `0.2` (placeholder, decision reserved to Antonin) |
| `ANTONIN_QUOTA_SAFETY_FACTOR` | `1.5` (placeholder) |
| `ANTONIN_QUOTA_ADMIT_REVIEWS` | `false` (placeholder) |
| `ANTONIN_QUOTA_TOKENS_PER_WINDOW_CLAUDE_CODE` | unset (placeholder: the window size is undeclared) |
| `ANTONIN_QUOTA_TOKENS_PER_WINDOW_CODEX` | unset (placeholder: the window size is undeclared) |
| `ANTONIN_MAX_DEFER_MS` | `21600000` (placeholder) |
| `ANTONIN_QUOTA_WARN_THRESHOLD` | `0.35` |
| `ANTONIN_QUOTA_MAX_STALENESS_MS` | `900000` |
| `ANTONIN_QUOTA_CANARY_INTERVAL_MS` | `900000` |

Set the secret without putting its value in source control or shell history:

```bash
export ANTONIN_POLICY_STATE_DIR=/absolute/external/path/antonin-policy-state
export MC_URL=http://127.0.0.1:4318
read -r -s MC_API_KEY
export MC_API_KEY
```

The reviewer must differ from both the policy agent and the local model identity. All configuration is validated before the queue request.

## Commands

Run these commands from the Mission Control repository root:

```bash
node ops/antonin-poc/policy-mvp/run-once.mjs status
node ops/antonin-poc/policy-mvp/run-once.mjs quota-status
node ops/antonin-poc/policy-mvp/run-once.mjs verify-ledger
node ops/antonin-poc/policy-mvp/run-once.mjs process
```

`status` prints resolved paths and non-secret configuration. `quota-status` prints the derived state of every quota window, the effective thresholds, and the decisions still reserved to Antonin; it reads state and never mutates it. `verify-ledger` checks every JSONL hash link and fails closed on corruption. `process` handles at most one task and returns a structured JSON summary; failures return a non-zero exit status with a bounded, redacted error.

`process` reports one of five outcomes: `no_task`, `awaiting_owner`, `review`, `deferred`, or `contended`. `contended` means another live invocation is committing — or has just committed — the same completion; this invocation posted nothing, mutated nothing, and released nothing, so it exits 0 and there is nothing to reconcile. `deferred` means nothing is wrong and the work is simply not runnable now; the task goes back to `assigned` for the policy agent with an operator-visible `deferred_until`, and the invocation exits 0.

## State and review flow

The external state directory contains:

- `leases.json`, a mode-`600` registry with monotonic fencing tokens;
- `completions.json`, a mode-`600` atomically replaced journal with deterministic completion and token-session IDs;
- `receipts.jsonl`, a mode-`600` append-only hash chain;
- `quotas.json`, a mode-`600` atomically replaced quota window registry;
- `quota-observations.jsonl`, a mode-`600` append-only log of the snapshots admission decisions were taken on. It is evidence, not authority: it is deliberately not hash-chained, and a failure to write it never blocks a decision. It grows by one line per `process` invocation and is safe to truncate.
- short-lived lock directories while a state mutation is in progress.

For an allowed task, the adapter uses a stable completion ID derived from the task ID and the input/output hashes. That ID is independent of the current fencing token and is copied into `metadata.policy_mvp` with the hashes and policy version. Existing task metadata is preserved.

Remote calls never run while the global lease lock is held. Before each bounded Ollama or Mission Control call, the adapter renews the lease to a TTL strictly longer than the client timeout. The fenced completion guard is used only for short local journal and receipt mutations:

1. detect an existing deterministic token record, or atomically record `token_attempted` before posting it once;
2. detect this exact completed task update, or assign the reviewer, move to `review`, and confirm the status, reviewer, resolution, and completion metadata;
3. append the hash-only success receipt after both Mission Control mutations are confirmed;
4. mark the receipt phase confirmed and release the matching lease as a separate cleanup.

Before the task mutation is confirmed, the mode-`600` journal temporarily keeps the local model resolution needed for a process restart. It never stores the API key or raw task prompt, and clears the resolution as soon as Mission Control confirms the task phase. Completed receipts remain hash-only.

Mission Control exposes only the latest 100 token records and has no server-side idempotency key. The adapter therefore provides safe at-most-once token posting, not distributed exactly-once accounting: after an ambiguous or lost POST response it checks that visible window for the deterministic session. If the session is absent, it atomically records `token_ambiguous=true`, leaves the completion pending for manual reconciliation, and never posts that session again automatically. This can undercount a token record whose POST definitely failed, but it cannot double-post an ambiguous attempt. Inspect the mode-`600` journal and Mission Control records before resolving such an entry manually; do not clear `token_attempted` merely to force a retry.

Only the invocation that atomically claimed the token attempt may record that ambiguity, because only it could have posted. An invocation that loses the claim to a concurrent live invocation yields immediately as `contended` instead of persisting an ambiguity it did not cause; a genuinely unaccounted attempt is still detected by the next invocation, which sees `token_attempted` with no visible session. An invocation whose completion turns out to be already confirmed by a concurrent one reports `contended` for the same reason, rather than reporting its lost race as an incident.

Task updates are idempotent and are retried only until the exact resolution and `metadata.policy_mvp.completion_id` are observed. A later `process` invocation resumes the first unconfirmed journal phase without re-running Ollama or claiming another task. That resume takes priority over the queue, so an entry left pending for manual reconciliation also holds back every later invocation: `process` keeps exiting non-zero on that entry and claims no new task until it is resolved. If its lease expired, the same owner reacquires the task with a new fencing token and atomically rebinds the pending receipt while keeping the completion ID and token session stable. If another owner currently holds the lease, the adapter performs no compensating Mission Control mutation. If the final receipt cannot be appended (for example because ledger verification fails), the confirmed Mission Control mutations stay in `review`; repair or restore the ledger, then run `process` again.

A stale owner exits without a receipt, token POST, task PUT, compensating `awaiting_owner`, or release attempt. Failure recovery renews before the guarded failure receipt and again immediately before its bounded `awaiting_owner` request; a takeover between those phases blocks the compensation and matching-token release. A release failure after a confirmed completion is reported as `cleanupWarning`; it never creates a failure receipt or moves the task to `awaiting_owner`.

The configured cloud reviewer performs the existing Mission Control review flow. The adapter does not call the reviewer or any cloud model itself.

## Quota admission

Quota is modelled per `(provider, plan, window)`, never per provider, because a 5 h block and a weekly block fail differently. A window has no meter: there is no contractual way to read remaining subscription quota, so the engine does not try to measure one. It records what it observes, and the reliability tier of the source decides what that observation may do. A heuristic source — an undocumented log format, a refusal sentence — can only ever make the engine more cautious: it can lower a fraction or latch an exhaustion, but it can never mark a window healthy and never authorise a spend. When a window is unknown the engine sends at most one real task to it per canary interval and reads the outcome; a success proves the window was open, a refusal latches the block until its reset.

Before executing, `process` checks that **both** the executor rung and a distinct reviewer route are admissible. Executor capacity alone is not enough: local work that can never be reviewed would sit in `review` for ever, which Mission Control would then display as progress. When the check fails the task is deferred rather than started.

Two consequences worth knowing before enabling `ANTONIN_REVIEWER_PROVIDER`:

- with no quota source configured, a tracked cloud window is permanently `unknown`, so the engine admits one task per `ANTONIN_QUOTA_CANARY_INTERVAL_MS` and defers the rest. That is the intended fail-closed behaviour, not a fault;
- leaving `ANTONIN_REVIEWER_PROVIDER` unset keeps the delivered behaviour: the reviewer is an ordinary Mission Control agent, this engine tracks no window for it, and no reviewer capacity is enforced. Which cloud model reviews what is still an open question outside this engine.

Mission Control's queue cannot filter on `deferred_until`, so a deferred task can be claimed again immediately. The engine re-evaluates admission and re-defers before any provider call, at the cost of one claim cycle. Backing that off belongs to a scheduler; `process` is still one task per invocation.

## Stop and rollback

There is no resident service to stop. Stop launching `process` (and disable any external scheduler if one was added later), wait for an active invocation to exit, then archive the complete state directory:

```bash
policy_state_archive="${ANTONIN_POLICY_STATE_DIR}.archive.$(date -u +%Y%m%dT%H%M%SZ)"
mv -- "$ANTONIN_POLICY_STATE_DIR" "$policy_state_archive"
```

This is recoverable: after confirming no invocation is running and the destination does not exist, move the archive back to the original absolute path. Do not delete or edit individual receipt lines as rollback; that breaks the audit chain.

## Tests

```bash
node --test ops/antonin-poc/policy-mvp/test/*.test.mjs
bash ops/antonin-poc/test-mc-poc.sh
```
