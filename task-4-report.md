# Task 4 — Automatic Orchestrator

## TDD

- RED: added `runCommand("propose", environment, dependencies)` tests, then ran `node --test ops/antonin-poc/policy-mvp/test/run-once.test.mjs`. The five new tests failed because `propose` was absent from the CLI usage.
- RED: added acknowledgement-status coverage for the proposal client, then ran `node --test ops/antonin-poc/policy-mvp/test/proposal-client.test.mjs`. It failed because `createProposal()` discarded the HTTP `201`/`200` distinction.
- GREEN: added the single-page sequential scan, durable cursor commit after all acknowledgements, route-forecast omission when unsafe, and acknowledgement-preserving client return.

## Behaviour

- `node ops/antonin-poc/policy-mvp/run-once.mjs propose` requests one candidate page whose client-side limit is fixed at 200, posts deterministic candidates sequentially, and commits its cursor only after every post is acknowledged.
- `201` acknowledgements count as `created`; `200` idempotent acknowledgements count as `duplicates`; tasks yielding no candidates count as `skipped`.
- The command launches, claims, routes, or executes no task and calls no provider. Route forecasts are advisory local-only data.
- Logs contain only numeric task IDs and aggregate counts.

## Verification

- `node --test ops/antonin-poc/policy-mvp/test/run-once.test.mjs` — RED observed: 5 new failures, all due to unsupported `propose` command.
- `node --test ops/antonin-poc/policy-mvp/test/proposal-client.test.mjs` — RED observed: acknowledgement tests failed because `created` was not returned.
- `node --test ops/antonin-poc/policy-mvp/test/*.test.mjs` — PASS: 165 tests, 0 failures.
- `node --check ops/antonin-poc/policy-mvp/run-once.mjs && node --check ops/antonin-poc/policy-mvp/mc-client.mjs && node --check ops/antonin-poc/policy-mvp/test/run-once.test.mjs && node --check ops/antonin-poc/policy-mvp/test/proposal-client.test.mjs` — PASS.
- `pnpm exec eslint --no-ignore ops/antonin-poc/policy-mvp/run-once.mjs ops/antonin-poc/policy-mvp/mc-client.mjs ops/antonin-poc/policy-mvp/test/run-once.test.mjs ops/antonin-poc/policy-mvp/test/proposal-client.test.mjs` — PASS.
- `git diff --check` — PASS.

## Commit

`feat(policy): scan and publish task proposals`

## Doutes

None. The acknowledgement extension to `mc-client.mjs` was explicitly authorised because the API's real `201`/`200` contract is required for exact counters.
