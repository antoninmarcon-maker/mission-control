# Antonin External Policy MVP Design

## Goal

Build the smallest durable external policy adapter that can claim a Mission Control task, choose a local-first route, hold a renewable fenced lease, execute a harmless Ollama task, persist an append-only receipt, and return the task to Mission Control for a distinct cloud review.

## Scope

The MVP lives entirely under `ops/antonin-poc/policy-mvp/`. It does not modify Mission Control application code, the Dash, the real Dash database, OpenClaw state, or any production repository. Runtime state is supplied through an explicit absolute `ANTONIN_POLICY_STATE_DIR` outside Git.

The MVP is a one-shot CLI, not a daemon. One invocation processes at most one queued task. This keeps concurrency, rollback, and audit behavior observable before a scheduler is added.

## Architecture

`policy-core.mjs` owns deterministic policy decisions and validation. It selects Ollama for low-risk mechanical work and requires explicit approval for other work. It never calls a provider.

`lease-store.mjs` owns a file-backed lease registry. Acquisition and renewal happen under an atomic directory lock. Every successful acquisition increments a monotonic fencing token. A stale owner cannot complete work after a newer token exists.

`receipt-ledger.mjs` appends canonical JSON records to a JSONL ledger. Each record contains the previous record hash and its own SHA-256 hash, creating a verifiable append-only hash chain. It must reject chain corruption.

`mc-client.mjs` is the only Mission Control REST boundary. It authenticates with an API key supplied through the environment, claims one task from the queue, updates task state, writes comments, and records token usage. It never logs the API key.

`ollama-client.mjs` is the only local-model boundary. It calls the configured OpenAI-compatible `/chat/completions` endpoint with a fixed timeout and returns normalized text and token usage.

`run-once.mjs` composes those units. It claims one task for `antonin-policy-engine`, evaluates policy, acquires a lease, executes Ollama when allowed, validates the current fencing token, appends a receipt, updates the task to `review`, and assigns the distinct configured cloud reviewer. Unsupported/high-risk work is moved to `awaiting_owner` with a policy explanation instead of being executed.

## CLI and configuration

Required environment variables:

- `ANTONIN_POLICY_STATE_DIR`: explicit absolute external state directory;
- `MC_URL`: must be `http://127.0.0.1:<port>`;
- `MC_API_KEY`: secret, required and never printed.

Optional environment variables:

- `ANTONIN_POLICY_AGENT`: default `antonin-policy-engine`;
- `ANTONIN_CLOUD_REVIEWER`: default `poc-aegis-cloud`;
- `LOCAL_LLM_ENDPOINT`: default `http://127.0.0.1:11434/v1`;
- `LOCAL_LLM_MODEL`: default `qwen2.5-coder:7b`;
- `ANTONIN_LEASE_TTL_MS`: default `120000`.

Commands:

```text
node ops/antonin-poc/policy-mvp/run-once.mjs process
node ops/antonin-poc/policy-mvp/run-once.mjs verify-ledger
node ops/antonin-poc/policy-mvp/run-once.mjs status
```

`status` prints paths and non-secret configuration only. `verify-ledger` verifies every hash link. `process` handles zero or one task.

## Policy v0

A task is eligible for automatic local execution only when all are true:

- priority is neither `critical` nor `high`;
- title plus description contains one of: `sort`, `format`, `rename`, `summarize`, `translate`, `simple`, `routine`, `mechanical`;
- title plus description contains none of: `deploy`, `production`, `migration`, `database`, `security`, `secret`, `payment`, `delete`, `merge`, `release`;
- metadata does not declare `tier` equal to `SOLIDE`.

Eligible tasks route to `ollama/<LOCAL_LLM_MODEL>` and require the distinct cloud reviewer. Every other task returns `awaiting_owner` without provider execution.

The local prompt requires a text-only response and forbids filesystem, network, Git, deployment, or external side effects. The MVP does not execute arbitrary shell commands or repo edits.

## Lease semantics

The lease key is the Mission Control task ID. A lease contains task ID, owner, fencing token, acquisition time, expiry, and task version if available.

- Acquisition succeeds if no lease exists, the existing lease is expired, or the same owner renews it.
- A different owner cannot acquire an unexpired lease.
- A takeover after expiry increments the fencing token.
- Completion requires `assertCurrent(taskId, owner, fencingToken)` immediately before receipt append and Mission Control update.
- Releasing removes only the matching owner/token lease.

This is a single-host MVP. The atomic directory lock makes local concurrent processes safe; it is not a distributed consensus system.

## Receipt semantics

Each receipt includes schema version, timestamp, task ID, task version, policy version, route, reviewer, lease ID, fencing token, input hash, output hash, token usage, outcome, previous hash, and record hash.

The ledger file is append-only during normal operation. `verify-ledger` recomputes hashes and fails closed on malformed JSON, missing links, or mismatches. It contains hashes and execution metadata, not raw prompts, results, API keys, or subscription credentials.

## Mission Control flow

1. Claim one task atomically through the existing queue API.
2. If policy rejects automatic work, set `awaiting_owner` and add the reason.
3. If accepted, acquire a fenced lease.
4. Execute Ollama with a harmless text-only prompt.
5. Assert the lease token is still current.
6. Append a receipt.
7. Persist token usage.
8. Update resolution and assign the distinct cloud reviewer.
9. Move the task to `review` for the existing Aegis flow.
10. Release the matching lease.

If Ollama or Mission Control fails, append a failure receipt when a lease exists, move the task to `awaiting_owner` when possible, release the lease, and exit non-zero. No cloud fallback occurs in MVP v0.

## Safety and rollback

- Only loopback Mission Control and Ollama URLs are accepted.
- State paths must be absolute and cannot be `/`, the repository root, or the Mission Control runtime directory.
- Secrets are accepted only through environment variables and never persisted.
- Runtime files are created with mode `600` where applicable.
- No Git, GitHub, `ship`, deploy, merge, delete, or arbitrary command execution exists in this MVP.
- Rollback is stopping invocations and moving the external policy state directory to a timestamped archive.

## Acceptance criteria

- Unit tests prove policy allow/deny behavior, loopback validation, lease exclusion/takeover/fencing, and receipt-chain tamper detection.
- Integration tests with local fake HTTP servers prove queue claim, Ollama execution, token post, reviewer assignment, review transition, rejection to `awaiting_owner`, and secret redaction.
- The existing POC launcher test remains green.
- Lint, typecheck, API parity, and the existing Mission Control suite remain green before completion.
- The implementation is committed and pushed only to the existing draft PR branch. It is not marked ready, merged, or deployed.
