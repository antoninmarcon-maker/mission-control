# Antonin Mission Control POC

This wrapper runs Mission Control as a local-only, isolated POC. It does not alter Mission Control's application code or the existing Dash.

## Safety boundary

- Mission Control binds through its development server to `127.0.0.1:4318`.
- Port `4317` is explicitly refused because it belongs to the existing Dash.
- SQLite, tokens, logs, memory, and the synthetic OpenClaw state all live below the explicit `MC_POC_STATE_DIR`.
- The runtime secret file is outside Git, has mode `600`, and secret values are never printed by the launcher.
- No provider API key is created. Claude Code and Codex can use their existing local subscription logins; Ollama uses `http://127.0.0.1:11434/v1`.
- `rollback` stops the process and moves the complete state directory to a timestamped archive. It does not delete the SQLite database.

## Run

```bash
export MC_POC_STATE_DIR=/Users/antoninmarcon/Documents/Codex/2026-08-27/mission-control-poc/work/runtime

ops/antonin-poc/mc-poc.sh init
ops/antonin-poc/mc-poc.sh start
ops/antonin-poc/mc-poc.sh status
ops/antonin-poc/mc-poc.sh config
```

Open `http://127.0.0.1:4318`. The initial admin identity is seeded from the external runtime file.

## Stop or roll back

```bash
ops/antonin-poc/mc-poc.sh stop
ops/antonin-poc/mc-poc.sh rollback
```

`stop` preserves the active state. `rollback` archives it next to the configured state directory, making restoration a simple directory move after confirming Mission Control is stopped.

## Tests

```bash
bash ops/antonin-poc/test-mc-poc.sh
```

The tests exercise the `4317` guard, loopback-only guard, dedicated SQLite path, secret-file permissions, redacted output, stopped status, and recoverable rollback.

## External policy adapter

The optional one-shot local policy adapter is documented in [policy-mvp/README.md](policy-mvp/README.md). It uses a separate external state directory, runs at most one harmless text task through loopback Ollama, and always returns successful output to Mission Control for distinct review. Its completion journal provides crash recovery and at-most-once token posting; an ambiguous token response that is no longer visible in Mission Control's 100-record window stops for manual reconciliation instead of risking a duplicate POST.
