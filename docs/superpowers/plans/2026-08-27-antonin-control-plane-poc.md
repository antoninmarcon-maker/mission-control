# Antonin Control Plane POC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run and evaluate an isolated, reversible Mission Control POC as Antonin's primary AI control-plane UI without changing the existing Dash or production systems.

**Architecture:** Keep upstream Mission Control unchanged and add a thin operational wrapper under `ops/antonin-poc`. The wrapper injects loopback-only, dedicated-port, dedicated-SQLite configuration from an external state directory. Capability and scenario tests use Mission Control's existing REST, MCP, CLI, scheduler, and runtime adapters; the specialized Dash remains an external policy layer.

**Tech Stack:** Bash, Node.js 22, pnpm, Next.js 16, SQLite/better-sqlite3, curl/jq, Mission Control REST/OpenAPI/MCP, Ollama, Claude Code CLI, Codex CLI, GitHub CLI, ship.

**Spec:** `docs/superpowers/specs/2026-08-27-antonin-control-plane-poc.md`

## Global Constraints

- Upstream baseline is commit `5483a0e1eef15b467c167e95796791112cedbb7c`.
- Mission Control binds to `127.0.0.1:4318`; port `4317` is forbidden.
- SQLite/runtime state is new and external to the Dash database.
- Secrets remain outside Git, mode `600`, and are never printed.
- Rollback archives state rather than deleting it.
- No production deployment, merge, or modification of NutriSecure/love-experience.
- The final GitHub artifact is a draft PR only.

---

### Task 1: Reversible POC launcher

**Files:**
- Create: `ops/antonin-poc/test-mc-poc.sh`
- Create: `ops/antonin-poc/mc-poc.sh`
- Create: `ops/antonin-poc/README.md`

**Interfaces:**
- Consumes: `MC_POC_STATE_DIR`, optional `MC_POC_PORT`, repository root resolved from the script location.
- Produces: `mc-poc.sh init|start|status|stop|rollback|config`; external `runtime.env`, `data/`, PID, and log files.

- [ ] **Step 1: Write the failing launcher safety tests**

```bash
# Assertions cover: port 4317 refusal, loopback-only host, mode-600 env,
# dedicated data path, no secret output, status when stopped, recoverable rollback.
bash ops/antonin-poc/test-mc-poc.sh
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `bash ops/antonin-poc/test-mc-poc.sh`
Expected: FAIL because `ops/antonin-poc/mc-poc.sh` does not exist.

- [ ] **Step 3: Implement the minimal launcher**

```bash
MC_POC_STATE_DIR=/absolute/poc/state ops/antonin-poc/mc-poc.sh init
MC_POC_STATE_DIR=/absolute/poc/state ops/antonin-poc/mc-poc.sh start
MC_POC_STATE_DIR=/absolute/poc/state ops/antonin-poc/mc-poc.sh status
MC_POC_STATE_DIR=/absolute/poc/state ops/antonin-poc/mc-poc.sh stop
MC_POC_STATE_DIR=/absolute/poc/state ops/antonin-poc/mc-poc.sh rollback
```

- [ ] **Step 4: Run tests and confirm GREEN**

Run: `bash ops/antonin-poc/test-mc-poc.sh`
Expected: PASS with no credential values in output.

- [ ] **Step 5: Document startup, state location, rollback, and safety boundary**

Run: `rg -n "4317|4318|127.0.0.1|rollback|SQLite|secret" ops/antonin-poc/README.md`
Expected: every operational boundary is documented.

### Task 2: Install and start the isolated instance

**Files:**
- Create outside Git: `/Users/antoninmarcon/Documents/Codex/2026-08-27/mission-control-poc/work/runtime/runtime.env`
- Create outside Git: `/Users/antoninmarcon/Documents/Codex/2026-08-27/mission-control-poc/work/runtime/data/mission-control.db`

**Interfaces:**
- Consumes: launcher from Task 1, local Claude/Codex/Ollama installations.
- Produces: authenticated Mission Control at `http://127.0.0.1:4318` and local log/PID evidence.

- [ ] **Step 1: Initialize state and verify permission/isolation guards**

Run: `MC_POC_STATE_DIR=/Users/antoninmarcon/Documents/Codex/2026-08-27/mission-control-poc/work/runtime ops/antonin-poc/mc-poc.sh init`
Expected: env mode `600`; data path under that exact state directory; no file under the Dash worktree/data path.

- [ ] **Step 2: Start Mission Control and wait for health**

Run: `MC_POC_STATE_DIR=/Users/antoninmarcon/Documents/Codex/2026-08-27/mission-control-poc/work/runtime ops/antonin-poc/mc-poc.sh start`
Expected: `/api/status` or `/api/health` responds on port `4318`; port `4317` still has the original listener.

- [ ] **Step 3: Verify runtime and subscription detection without outputting credentials**

Run authenticated GETs for `/api/agent-runtimes`, `/api/integrations`, `/api/claude/sessions`, `/api/sessions`, and `/api/tokens`.
Expected: Claude and Codex binaries detected; ChatGPT/Claude subscription flags reported when locally discoverable; Ollama installed/reachable; no credential value returned.

### Task 3: Control-plane surface smoke tests

**Files:**
- Create outside Git: `/Users/antoninmarcon/Documents/Codex/2026-08-27/mission-control-poc/work/evidence/*.json`

**Interfaces:**
- Consumes: Mission Control API key from the external runtime env.
- Produces: redacted JSON evidence for task board, approvals, sessions/tokens, memory/skills, GitHub, REST, and MCP.

- [ ] **Step 1: Verify REST/OpenAPI and status endpoints**

Run authenticated requests to `/api/status`, `/api/index`, `/api/docs`, and compare `pnpm api:parity`.
Expected: HTTP success for described interfaces and parity command exit `0`.

- [ ] **Step 2: Verify task board and approval state transitions**

Create an isolated task, move it through assigned/in_progress/review, create a quality review record, and confirm the task/review APIs reflect the transition.
Expected: task IDs remain stable and the board states are persisted in the POC SQLite only.

- [ ] **Step 3: Verify sessions, tokens, memory, and skills**

Trigger local session/skill synchronization, write one POC memory file under the isolated memory root, and POST one synthetic token record.
Expected: each item is queryable through its REST surface and contains no unrelated host data beyond explicitly detected CLI session metadata.

- [ ] **Step 4: Verify GitHub boundary**

Call GitHub status/read endpoints without injecting a token, then verify the authenticated `gh` CLI independently.
Expected: Mission Control reports the missing-token boundary cleanly; no token appears in logs/evidence; `gh` proves external GitHub access for `ship`.

- [ ] **Step 5: Verify MCP server**

Start `scripts/mc-mcp-server.cjs` with `MC_URL` and `MC_API_KEY`, send MCP initialize and tools/list JSON-RPC messages, and inspect the tool inventory.
Expected: initialize succeeds and task/session/memory/token/skill tools are present.

### Task 4: Three isolated scenarios

**Files:**
- Create outside Git: `/Users/antoninmarcon/Documents/Codex/2026-08-27/mission-control-poc/work/evidence/scenario-*.json`

**Interfaces:**
- Consumes: scheduler trigger API, local Ollama endpoint, Claude/Codex subscription CLI, Mission Control task/session APIs, ship.
- Produces: evidence for local execution + cloud review, task/session resume, and draft PR workflow.

- [ ] **Step 1: Run a mechanical local task**

Create an agent whose `dispatchModel` is `ollama/qwen2.5-coder:7b`, assign a harmless text transformation task scoped to the POC work directory, and trigger scheduler task `task_dispatch`.
Expected: task reaches `review`; evidence identifies the local model and contains the harmless result.

- [ ] **Step 2: Run cloud Aegis review**

Configure the Aegis agent for an available subscription-backed Claude or Codex model and trigger scheduler task `aegis_review`.
Expected: a quality review row is recorded and the task reaches `done` or returns an evidence-backed rejection; no provider API key is required.

- [ ] **Step 3: Resume a suspended task/session**

Create/identify an isolated CLI session, submit one prompt, suspend the task in `awaiting_owner`, restore it to `assigned`/`in_progress`, and use the continue/resume interface.
Expected: stable task/session identity and a second transcript/result tied to the same logical work item.

- [ ] **Step 4: Exercise ship through a draft PR**

Run the launcher tests, commit the isolated POC files, configure an Antonin-owned fork if upstream is not writable, and run `ship push -m "chore: add isolated Antonin control-plane POC"`.
Expected: draft PR URL exists; no merge, ready transition, or production deployment occurs.

### Task 5: Decision and minimal integration plan

**Files:**
- Create: `ops/antonin-poc/ASSESSMENT.md`
- Create outside Git/user-facing: `/Users/antoninmarcon/Documents/Codex/2026-08-27/mission-control-poc/outputs/mission-control-poc-decision.md`

**Interfaces:**
- Consumes: graph report, source inspection, smoke evidence, scenario evidence, GitHub draft PR/check status.
- Produces: factual go/no-go, gap matrix, minimal integration architecture, rollback instructions.

- [ ] **Step 1: Record evidence and limitations**

Include exact commit, port, data path class, test commands/results, API/MCP/runtime observations, and any failed scenario with root cause.

- [ ] **Step 2: Classify policy gaps**

For routing/risk, local-first, quotas, fallback, cloud review, leases/receipts, and ship, mark `native`, `partial`, or `external engine required` with source/evidence.

- [ ] **Step 3: Decide go/no-go and propose the minimal boundary**

The preferred boundary is an external policy adapter using Mission Control REST/MCP/webhooks plus immutable receipt storage; upstream source changes are allowed only when no stable extension point exists.

- [ ] **Step 4: Run final verification**

Run: `bash ops/antonin-poc/test-mc-poc.sh && pnpm lint && pnpm typecheck && pnpm api:parity`
Expected: all commands exit `0`; any upstream baseline warning is recorded explicitly.
