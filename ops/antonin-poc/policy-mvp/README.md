# External policy adapter MVP

This one-shot adapter claims at most one Mission Control task, applies the v0 local-execution policy, and either sends the task back to its owner or runs a harmless text-only Ollama completion. Successful local work is always assigned to a distinct cloud reviewer and moved to `review`; the adapter never approves its own output.

## Safety boundary

- Mission Control and Ollama must use loopback HTTP URLs (`127.0.0.1` or `::1`). HTTPS and non-loopback hosts are rejected before any request.
- `ANTONIN_POLICY_STATE_DIR` must be an absolute directory outside this repository and outside both Mission Control runtime directories. The canonical path, descendants, and symlink aliases of `MISSION_CONTROL_DATA_DIR` and `MC_POC_STATE_DIR` are rejected. Do not point it at `/` or the repository either.
- The adapter only sends a text prompt to Ollama. It cannot execute shell commands, edit a repository, use Git/GitHub, deploy, merge, delete, or perform arbitrary network work.
- The local prompt explicitly forbids filesystem, network, Git, deployment, shell, and other external side effects.
- There is no cloud execution fallback. Policy rejection or an execution failure before completion starts moves the task to `awaiting_owner` when Mission Control is reachable. A partially confirmed completion remains pending for safe reconciliation instead of being reclassified.
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
node ops/antonin-poc/policy-mvp/run-once.mjs verify-ledger
node ops/antonin-poc/policy-mvp/run-once.mjs process
```

`status` prints resolved paths and non-secret configuration. `verify-ledger` checks every JSONL hash link and fails closed on corruption. `process` handles at most one task and returns a structured JSON summary; failures return a non-zero exit status with a bounded, redacted error.

## State and review flow

The external state directory contains:

- `leases.json`, a mode-`600` registry with monotonic fencing tokens;
- `completions.json`, a mode-`600` atomically replaced journal with deterministic completion and token-session IDs;
- `receipts.jsonl`, a mode-`600` append-only hash chain;
- short-lived lock directories while a state mutation is in progress.

For an allowed task, the adapter uses a stable completion ID derived from the task ID and the input/output hashes. That ID is independent of the current fencing token and is copied into `metadata.policy_mvp` with the hashes and policy version. Existing task metadata is preserved.

Remote calls never run while the global lease lock is held. Before each bounded Ollama or Mission Control call, the adapter renews the lease to a TTL strictly longer than the client timeout. The fenced completion guard is used only for short local journal and receipt mutations:

1. detect an existing deterministic token record, or atomically record `token_attempted` before posting it once;
2. detect this exact completed task update, or assign the reviewer, move to `review`, and confirm the status, reviewer, resolution, and completion metadata;
3. append the hash-only success receipt after both Mission Control mutations are confirmed;
4. mark the receipt phase confirmed and release the matching lease as a separate cleanup.

Before the task mutation is confirmed, the mode-`600` journal temporarily keeps the local model resolution needed for a process restart. It never stores the API key or raw task prompt, and clears the resolution as soon as Mission Control confirms the task phase. Completed receipts remain hash-only.

Mission Control exposes only the latest 100 token records and has no server-side idempotency key. The adapter therefore provides safe at-most-once token posting, not distributed exactly-once accounting: after an ambiguous or lost POST response it checks that visible window for the deterministic session. If the session is absent, it atomically records `token_ambiguous=true`, leaves the completion pending for manual reconciliation, and never posts that session again automatically. This can undercount a token record whose POST definitely failed, but it cannot double-post an ambiguous attempt. Inspect the mode-`600` journal and Mission Control records before resolving such an entry manually; do not clear `token_attempted` merely to force a retry.

Task updates are idempotent and are retried only until the exact resolution and `metadata.policy_mvp.completion_id` are observed. A later `process` invocation resumes the first unconfirmed journal phase without re-running Ollama or claiming another task. If its lease expired, the same owner reacquires the task with a new fencing token and atomically rebinds the pending receipt while keeping the completion ID and token session stable. If another owner currently holds the lease, the adapter performs no compensating Mission Control mutation. If the final receipt cannot be appended (for example because ledger verification fails), the confirmed Mission Control mutations stay in `review`; repair or restore the ledger, then run `process` again.

A stale owner exits without a receipt, token POST, task PUT, compensating `awaiting_owner`, or release attempt. Failure recovery renews before the guarded failure receipt and again immediately before its bounded `awaiting_owner` request; a takeover between those phases blocks the compensation and matching-token release. A release failure after a confirmed completion is reported as `cleanupWarning`; it never creates a failure receipt or moves the task to `awaiting_owner`.

The configured cloud reviewer performs the existing Mission Control review flow. The adapter does not call the reviewer or any cloud model itself.

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
