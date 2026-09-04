# Antonin Control Plane POC Specification

## Objective

Evaluate `builderz-labs/mission-control` as Antonin's primary AI operations UI while keeping the existing Dash as policy engine, fallback, and quality control.

## Isolation and safety

- Pin the POC to upstream commit `5483a0e1eef15b467c167e95796791112cedbb7c`.
- Run Mission Control on `127.0.0.1:4318`; never bind the POC to a non-loopback interface.
- Refuse port `4317`, which belongs to the existing Dash.
- Store SQLite and runtime files in a new POC state directory outside the real Dash database.
- Keep credentials in a mode-`600` runtime file outside Git; never print or commit them.
- Make rollback recoverable by stopping the POC and moving its state to a timestamped archive.
- Do not deploy, merge, or touch production data.

## Runtime and interface checks

- Detect Claude Code and its subscription without exposing credentials.
- Detect the ChatGPT-authenticated Codex CLI without exposing credentials.
- Detect Ollama and its installed local models; configure its OpenAI-compatible local endpoint.
- Verify task CRUD/board state, Aegis approvals, session and token surfaces, memory and skills, GitHub behavior, REST/OpenAPI, and MCP.

## Policy-gap assessment

Measure Mission Control against the existing policy engine for:

- routing by task complexity and risk;
- local-first execution;
- quota and rate-limit detection;
- automatic fallback;
- mandatory cloud review after local execution;
- immutable leases and receipts;
- the `ship` worktree/branch/draft-PR workflow.

## Isolated scenarios

1. Mechanical local task executed with Ollama and reviewed by a cloud subscription runtime.
2. Suspended task/session resumed without losing task identity or evidence.
3. Worktree-to-draft-PR path through `ship`, with no merge or production deployment.

## Deliverables

- A reversible local launcher and automated safety tests.
- A factual capability/evidence report with go/no-go decision.
- A minimal integration plan that uses public REST/MCP/CLI boundaries and avoids a deep Mission Control fork.
- Preserve, but do not draft or publish, the future editorial idea about replacing a fully custom dashboard with an open-source control plane plus a specialized policy engine.
