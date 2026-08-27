# External policy adapter MVP

This one-shot adapter claims at most one Mission Control task, applies the v0 local-execution policy, and either sends the task back to its owner or runs a harmless text-only Ollama completion. Successful local work is always assigned to a distinct cloud reviewer and moved to `review`; the adapter never approves its own output.

## Safety boundary

- Mission Control and Ollama must use loopback HTTP URLs (`127.0.0.1` or `::1`). HTTPS and non-loopback hosts are rejected before any request.
- `ANTONIN_POLICY_STATE_DIR` must be an absolute directory outside this repository and outside the Mission Control runtime directory. Do not point it at `/`, the repository, or `MC_POC_STATE_DIR`.
- The adapter only sends a text prompt to Ollama. It cannot execute shell commands, edit a repository, use Git/GitHub, deploy, merge, delete, or perform arbitrary network work.
- The local prompt explicitly forbids filesystem, network, Git, deployment, shell, and other external side effects.
- There is no cloud execution fallback. Policy rejection or execution failure moves the task to `awaiting_owner` when Mission Control is reachable.
- Receipts contain SHA-256 input/output hashes and execution metadata, never raw task text, model output, API keys, or subscription credentials.
- One `process` invocation claims zero or one task and then exits. No daemon or scheduler is included.

## Configuration

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `ANTONIN_POLICY_STATE_DIR` | Absolute external directory for leases and the receipt ledger. |
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
- `receipts.jsonl`, a mode-`600` append-only hash chain;
- short-lived lock directories while a state mutation is in progress.

For an allowed task, receipt append, token accounting, reviewer assignment, and the transition to `review` run under the same fenced completion guard. The matching lease is released only after that guard exits. A stale owner cannot append a completion receipt, post tokens, or move the task to review.

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
