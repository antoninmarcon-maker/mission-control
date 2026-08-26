# Mission Control as Antonin's AI Control Plane — POC Assessment

Date: 2026-08-27  
Upstream: `builderz-labs/mission-control`  
Version: `2.3.0`  
Pinned commit: `5483a0e1eef15b467c167e95796791112cedbb7c`

## Decision

**Conditional GO** for Mission Control as the primary UI/control plane.

**NO-GO** for replacing Antonin's existing policy engine with Mission Control's native dispatcher. The Dash should remain the routing, risk, fallback, quality-policy, and `ship` authority behind a thin REST/MCP adapter.

This split avoids a deep fork: Mission Control owns operator experience and control-plane state; Antonin's engine owns execution policy and emits task updates, reviews, token records, and immutable evidence through stable interfaces.

## Isolation evidence

- Worktree: `chore/antonin-control-plane-poc`, created through `ship` from the pinned upstream commit.
- Listener: `127.0.0.1:4318` only.
- Port `4317` is hard-refused by the launcher.
- SQLite: external POC state under `work/runtime/data/mission-control.db`.
- Memory, tokens, logs, and synthetic OpenClaw state are under the same external POC state root.
- Runtime credentials are external to Git, mode `600`, and never printed.
- Rollback stops the POC and moves the complete state directory to a timestamped archive.
- No production deployment or merge was run; no NutriSecure or love-experience repository was modified.

The original Dash listener was present on `127.0.0.1:4317` during initial inventory. It was no longer listening when the POC started; this POC did not signal, restart, modify, or access it.

## Verified native surfaces

| Surface | Evidence | Result |
|---|---|---|
| Task board and review gate | Task `1` persisted through `review → done`; Aegis approval row recorded | Pass |
| Claude Code | Binary `2.1.241` detected; dispatch, session resume, cwd, tool policy, budget cap, structured output declared | Pass |
| Codex / ChatGPT | Codex CLI `0.149.0-alpha.4.3` detected; ChatGPT subscription reported as redacted file-backed auth | Pass |
| Ollama | Local daemon connected; `qwen3:14b`, `qwen2.5-coder:14b`, `qwen2.5-coder:7b` detected externally | Pass |
| Sessions | 13 Claude Code and 87 Codex session metadata records detected read-only | Pass |
| Tokens | Synthetic and real local execution usage persisted in JSON/SQLite; local cost recorded as `0` | Pass |
| Memory | Isolated `poc/control-plane.md` created and read through REST | Pass |
| Skills | 42 local skills detected across user Agents/Codex roots | Pass |
| REST/OpenAPI | `/api/index`, `/api/docs`, `/docs`; 262 route operations vs 253 OpenAPI operations with 12 declared ignores | Pass; parity gate green |
| MCP | Server initialized as `mission-control@2.3.0`; 49 tools; tasks, sessions, memory, tokens, and skills present | Pass |
| GitHub | Mission Control returned a clean `GITHUB_TOKEN not configured`; external `gh` is authenticated via keyring | Partial |
| Exec approvals | Endpoint responds but gateway-backed approvals are empty without OpenClaw | Partial |

## Scenario results

### 1. Mechanical local task + cloud review

- Task `2`: simple alphabetical sort.
- Policy engine called `ollama/qwen2.5-coder:7b` through the local OpenAI-compatible endpoint.
- Result: `apple,moon,zebra`.
- Usage: 50 input + 7 output tokens, cost `0`.
- Task moved to `review`; policy changed reviewer assignment to a Codex-backed agent.
- Mission Control log proves `Dispatching task via Codex CLI`, model `gpt-5.5`.
- Aegis verdict: approved; notes: `Correct alphabetical order and comma-separated output.`
- Final task state: `done`.

Result: **Pass through the intended external-policy boundary.**

### 2. Suspended task resume

- Task `3` moved `in_progress → awaiting_owner → assigned`.
- Queue polling atomically reclaimed it as `in_progress`.
- Task ID `3`, resolution `checkpoint-before-suspension`, and metadata checkpoint `phase-1-complete` were preserved.

Result: **Pass for task-level resume.** Claude's adapter declares session resume support; Codex's adapter explicitly declares no session-resume support, so existing host sessions were not mutated for this POC.

### 3. Draft PR via ship

The isolated launcher, tests, spec, plan, and assessment are intended to be committed and pushed through `ship push` to an Antonin-owned fork. The PR must remain draft; no `ship ready`, merge, or deployment is authorized.

## Policy gap matrix

| Policy capability | Mission Control 2.3.0 | Required ownership |
|---|---|---|
| Complexity routing | **Partial.** Keyword, priority, description-length, and estimated-hours heuristic selects Haiku/Sonnet/Opus. No explicit risk model or learned routing rules. | Dash policy engine |
| Local-first | **External required.** Native defaults are cloud-oriented. Additionally, `classifyDirectModel()` strips the `ollama/` or `local/` prefix from `agent.config.dispatchModel` before `pickProvider()`, so the configured local provider is misclassified. | Dash policy engine; optional upstream bug report/fix |
| Quota detection | **Partial observability.** Subscription plans are detected and Codex session parsing sees `rate_limits.limit_name`, but dispatch does not consume remaining quota/reset windows. | Dash quota monitor and router |
| Automatic fallback | **Partial auth fallback only.** Claude CLI/API and OpenAI API/Codex choice exists based on availability; execution failures do not trigger policy-driven cross-provider fallback. Claude runtime sessions explicitly fail closed without fallback. | Dash policy engine |
| Cloud review after local | **Partial.** Aegis is native, but direct review inherits the completed task's agent config, so executor and reviewer are not independently routed. The POC succeeded by external reassignment before review. | Dash policy engine + Mission Control Aegis |
| Leases | **Missing.** Task claim is atomic and stale tasks can be requeued, but there is no renewable owner/expiry lease or fencing token. | External lease service/table |
| Immutable receipts | **Partial.** MCP audit rows can receive Ed25519 tamper-evident signatures, but signing failure is non-fatal and runtime manifests declare no diff/test/artifact/browser receipts. | External append-only receipt ledger; optionally anchor hashes back into Mission Control |
| `ship` workflow | **External required.** GitHub issue/task sync exists, but worktree, branch convention, secret scan, draft PR, tier SOLIDE, checks, and merge authority remain outside Mission Control. | `ship` remains authoritative |

## Minimal integration architecture

1. Keep Mission Control upstream-first and pinned to reviewed releases.
2. Register a single `antonin-policy-engine` identity through REST/MCP.
3. Let Mission Control own tasks, comments, operator approvals, sessions/tokens display, memory/skills browsing, and notifications.
4. Let the Dash policy engine poll or receive task events, then acquire an external renewable lease before execution.
5. Route locally first according to complexity/risk/quota policy; invoke Claude/Codex only when policy requires it.
6. Post status, model, token use, result, and review request back through REST/MCP.
7. Require a distinct cloud-review policy before moving local work to `done`.
8. Store immutable execution receipts externally: task/version, lease/fencing token, model/runtime, input/output hashes, Git diff hash, test command/result, artifact references, reviewer verdict, and `ship` PR URL.
9. Use Mission Control webhooks/SSE for wakeups and UI freshness, not as the source of execution authority.
10. Keep `ship` outside Mission Control. Surface its draft PR/check state back into task metadata/comments.

## Upstream changes worth proposing

These are small, reviewable contributions rather than fork-only patches:

1. Preserve `local/`, `ollama/`, `lmstudio/`, and `litellm/` prefixes when resolving `dispatchModel`.
2. Add a separate `reviewModel`/`reviewAgent` policy so Aegis does not inherit executor routing.
3. Expose structured quota windows and reset times from Claude/Codex sessions.
4. Add an optional receipt-ingestion API with immutable versioning and signature verification.
5. Add a generic external-policy webhook before dispatch, returning route/reviewer/lease metadata.

## Editorial note preserved

Keep the idea for next week: explain Antonin's choice to stop building a complete AI dashboard from scratch and instead adopt an open-source control plane completed by a specialized policy engine. No post, draft, or publication was produced during this POC.
