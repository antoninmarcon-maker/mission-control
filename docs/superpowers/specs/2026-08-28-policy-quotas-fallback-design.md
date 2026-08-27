# Antonin Policy Engine — Quota and Fallback Design

Design only. No implementation, no runtime, no Mission Control process, no repository
outside this file is touched by this document.

## Goal

Give `antonin-policy-engine` a quota model and a fallback policy so that it can decide
*where* to run a task and *what to do when that fails*, without ever double-executing
work, losing audit evidence, exceeding a budget Antonin did not authorise, or
self-approving its own output.

This extends the MVP specified in
`docs/superpowers/specs/2026-08-27-antonin-policy-mvp-design.md` and implemented in
`ops/antonin-poc/policy-mvp/`. It does not replace it. Every existing invariant of that
MVP — one-shot CLI, external state directory, loopback-only endpoints, fenced leases,
hash-chained receipts, at-most-once token accounting, distinct cloud reviewer — remains
in force and constrains this design.

Division of responsibility is unchanged from the handoff (§13): **Mission Control
displays, the engine decides.** Quota state is pushed to Mission Control as read-only
operator-visible metadata. Mission Control is never read back as the authority on quota,
routing, or budget.

## 1. What exists today, measured

Facts checked on this machine on 2026-08-27, not assumed. They are the reason this
design exists and the reason it is shaped the way it is.

**Mission Control has observability, not a quota signal.** `parseCodexSessionFile` in
`src/lib/codex-sessions.ts` reads `payload.rate_limits` but consumes only
`limits.limit_name`, and only as a fallback for the model name
(`if (!model && limitName) model = limitName`). In the Codex rollout files actually
present under `~/.codex/sessions/`, `limit_name` is `null`. That branch therefore
extracts nothing at all. The structured numbers sitting one level away are dropped.

**The Codex rollout file does carry a structured quota object.** Observed shape, verbatim
field names:

```json
{
  "limit_id": "codex",
  "limit_name": null,
  "primary": { "used_percent": 100.0, "window_minutes": 10080, "resets_at": 1788272042 },
  "secondary": null,
  "credits": { "has_credits": true, "unlimited": false, "balance": "367.6282670000" },
  "individual_limit": null,
  "spend_control_reached": null,
  "plan_type": "pro",
  "rate_limit_reached_type": null
}
```

`window_minutes: 10080` is seven days. `resets_at` is epoch **seconds**, not
milliseconds (1788272042 decodes to 2026-09-01T14:14:02Z; read as milliseconds it would
decode to 1970). `secondary` is the shorter window and is frequently `null`. None of
this is a documented contract; it is an internal log format that can change without
notice.

**The Claude Code quota signal is a sentence, not a number.** When the rolling window is
exhausted, the transcript under `~/.claude/projects/**/*.jsonl` contains an assistant
message whose only content is:

```text
You've hit your session limit · resets 7:30pm (Europe/Paris)
```

There is no remaining count, no window identifier, no date — only a local wall-clock
time. Resolving it to an instant requires the operator timezone and a
rollover-to-tomorrow rule. The same string is what kills agents in flight.

**Local tooling is explicitly non-authoritative.** `~/Documents/ops/bin/usage-modeles.sh`
computes weighted relative units from local transcripts (input ×1, cache read ×0.1,
cache write ×2, output ×5) and says so in its own header: those are burn-rate units,
"PAS des crédits d'abonnement : seul /usage dans l'app fait foi."

**Our own accounting cannot serve as a meter.** `src/app/api/tokens/route.ts` returns at
most 100 rows to a list request (`usage: filteredData.slice(0, 100)`), which is already
why `MissionControlClient.findTokenRecord` provides at-most-once, not exactly-once,
accounting (see `.superpowers/sdd/2026-08-27-antonin-policy-mvp/progress.md`, Task 2
rulings). Mission Control token rows also only ever contain what this engine wrote — they
say nothing about what Antonin's own interactive sessions consumed.

Conclusion that drives the whole design: **there is no contractual way to read remaining
quota, and there will not be one.** Any design that waits for a reliable meter is
blocked forever. The design below therefore stops trying to meter and treats quota as a
circuit breaker driven by refusals.

## 2. Quota data model

### 2.1 The unit: a window, not a provider

Quota is modelled per `(provider, plan, window_id)`, never per provider. Claude Code has
two simultaneous windows — weekly and a rolling 5 h — and they fail differently: a 5 h
block costs hours and kills work in flight, a weekly block costs days and can end
Antonin's week. Collapsing them into one number destroys the only distinction that
matters when deciding whether to spend.

| provider | plan | window_id | window_minutes | notes |
| --- | --- | --- | --- | --- |
| `ollama` | `local` | `none` | — | unmetered; constrained by machine load, not quota |
| `claude-code` | `max` | `weekly` | 10080 | scarce, slow to recover |
| `claude-code` | `max` | `session_5h` | 300 | recovers fast, kills in-flight work |
| `codex` | `pro` | `weekly` | 10080 | observed `primary` window |
| `codex` | `pro` | `session_5h` | 300 | observed `secondary` when non-null |

`ollama` is present in the model on purpose: it must be *admissible* through the same
code path, with `state: "ok"` and an availability probe instead of a quota reading, so
the ladder has no special case.

### 2.2 The record

One `QuotaWindow` per key, persisted in the external state directory:

```json
{
  "provider": "codex",
  "plan": "pro",
  "window_id": "weekly",
  "window_minutes": 10080,
  "used_fraction": 1.0,
  "remaining_fraction": 0.0,
  "resets_at": 1788272042000,
  "observed_at": 1787000000000,
  "source": "codex_rollout_rate_limits",
  "confidence": "heuristic",
  "exhausted_until": 1788272042000,
  "state": "exhausted"
}
```

Rules on the record:

- all instants are epoch **milliseconds, UTC**, normalised at parse time — the seconds/
  milliseconds and local-wall-clock traps of §1 are handled once, at the boundary;
- `used_fraction` / `remaining_fraction` are `null` when unknown. `null` is not `0` and
  is not `1`; the difference is load-bearing;
- `state` is derived, never stored as an input. It is a pure function of
  `(remaining_fraction, confidence, staleness, exhausted_until, thresholds, now)`;
- `exhausted_until` is a **latch**. Only the clock clears it.

### 2.3 Alert states

| state | condition | effect on routing |
| --- | --- | --- |
| `ok` | fresh, `remaining_fraction > warn_threshold` | admissible |
| `warn` | fresh, `reserve < remaining_fraction <= warn_threshold` | reviews admissible, new cloud executions refused |
| `critical` | fresh, `remaining_fraction <= reserve` | no cloud dispatch of any kind |
| `exhausted` | `now < exhausted_until` | provider removed from the ladder until reset |
| `unknown` | no observation, or staleness > max, or `remaining_fraction === null` | canary rule (§2.6) |

The `warn` band deliberately keeps cloud capacity for **reviews** while refusing new
cloud **executions**. A review unblocks work that already exists and is cheap; an
execution creates more unreviewed work and is expensive. When capacity is scarce,
draining the review queue is strictly more valuable than starting new work.

On reset (`now >= exhausted_until`, or `now >= resets_at`), the window does not become
`ok`. It becomes `unknown` with the canary interval reset to zero. We know the block
ended; we do not know the new value, and pretending otherwise reintroduces the guess
this design exists to remove.

### 2.4 Sources and their reliability

Three tiers, and the tier is stored on every record as `confidence`.

| source id | provider | yields | tier | why |
| --- | --- | --- | --- | --- |
| `refusal_observed` | claude-code, codex | exhaustion + a reset hint | **contractual** | the provider refused *this* call; the fact of refusal is self-evident and cannot be misparsed |
| `success_observed` | any | "not exhausted at T" | **contractual** | the call went through |
| `ollama_probe` | ollama | daemon reachable, model present | **contractual** | local loopback HTTP, our own machine |
| `mc_token_usage` | any | our own consumption | **contractual but partial** | `/api/tokens?action=list` caps at 100 rows and only sees our writes |
| `receipt_history` | any | observed cost per route | **contractual** | our own hash-chained ledger, `token_usage` field |
| `codex_rollout_rate_limits` | codex | `used_percent`, `window_minutes`, `resets_at` | **heuristic** | structured and typed, but an undocumented internal log format |
| `claude_refusal_string` | claude-code | reset wall-clock time | **heuristic** | free text, local time, no date, no window id |
| `claude_transcript_usage` | claude-code | tokens consumed | **heuristic** | a burn rate, never a remaining balance |
| `usage_modeles_sh` | claude-code | weighted relative units | **heuristic** | the script itself says only `/usage` is authoritative |
| `operator_declaration` | any | a value Antonin read in `/usage` | **declarative** | authoritative at its timestamp, decays like any other reading |

Admission rules that follow from the tiers:

1. a **heuristic** source may only ever make the engine *more* cautious. It can move a
   window to `warn`, `critical` or `exhausted`; it can never move a window to `ok`, and
   it can never justify spending;
2. a **contractual** source may move a window in both directions;
3. a **declarative** source may move a window in both directions, and outranks every
   heuristic source until it goes stale.

That asymmetry is the whole safety argument. A log format that changes silently can then
only cost us conservatism, never an overrun.

### 2.5 Freshness

Every record carries `observed_at`. `staleness = now - observed_at`. Beyond
`ANTONIN_QUOTA_MAX_STALENESS_MS` the record degrades to `unknown` regardless of its
value; a two-day-old "80 % remaining" is not information. Staleness is evaluated at
snapshot time against the injected clock, never at write time, so a stale record needs
no sweeper.

### 2.6 Measuring an unmeasurable quota: the canary rule

This answers the handoff's open question (§18): *how do we measure ChatGPT/Claude quotas
without depending on non-contractual log formats?*

**We do not measure. We attempt, and we read the refusal.**

When a cloud window is `unknown`, the engine may send **one** attempt to that
`(provider, window)` per `ANTONIN_QUOTA_CANARY_INTERVAL_MS`. That attempt is not a
synthetic ping — it is the real task, the work we wanted to do anyway. Two outcomes,
both informative and neither wasteful:

- it succeeds: real work got done, and a `success_observed` record proves the window was
  open at that instant;
- it is refused: a `refusal_observed` record latches `exhausted_until` from the parsed
  reset, at a cost far below the work it replaces. Note the caveat: on Claude Code the
  refusal arrives as an assistant message in the normal response path, so it is *cheap*
  rather than provably free. Treat "a refusal consumes nothing" as unverified, and cap
  canary frequency accordingly.

Log parsing keeps exactly one job: **skipping providers we already know are blocked**,
which is cheap and saves a pointless round trip. It is never allowed to authorise a
spend. The canary is what authorises.

Concurrency limit: at most one in-flight canary per `(provider, window)`. The engine is a
one-shot CLI processing one task per invocation, so this is naturally satisfied within an
invocation; across invocations it is enforced by the canary timestamp in the quota store.

### 2.7 Cost estimation, from evidence we already have

Admission needs an expected cost. It already exists: `receipts.jsonl` records
`token_usage: {input, output}` on every receipt, keyed by `route`. The estimator is the
p90 of the last N success receipts for that route, converted to a fraction of the target
window by a per-provider `tokens_per_window` constant that Antonin sets (§5). No new data
source, no new file, no new privacy surface.

With no history for a route, expected cost is `unknown` and the route is admissible only
under the canary rule — which is exactly right: the first run on a new route *is* the
measurement.

### 2.8 Storage: `quota-store.mjs`

A new module in `ops/antonin-poc/policy-mvp/`, mirroring `lease-store.mjs` exactly rather
than inventing a second style:

- resolves its directory with the existing
  `resolveExternalStateDirectory(stateDirectory, options)` — same repository, runtime and
  symlink guards, no new path policy;
- `quotas.json`, mode `600`, atomic temp-file + `rename` (the `LeaseStore#writeState`
  pattern), guarded by an atomic `mkdir` lock directory `.quotas.lock`;
- `quota-observations.jsonl`, mode `600`, append-only history of snapshots so a receipt's
  `quota_snapshot_hash` is resolvable later. It is evidence, not authority: it is *not*
  hash-chained, and corrupting it must never block execution the way a corrupt
  `receipts.jsonl` does.

Interface:

```text
class QuotaStore {
  observe(observation)            // monotonic merge, returns the stored window
  snapshot(now)                   // { snapshot_id, taken_at, windows: [...] }
  claimCanary(provider, windowId) // atomic compare-and-set, returns boolean
}
```

`observe` is monotonic: an observation whose `observed_at` is older than the stored one
for the same key is discarded, and an `exhausted` latch is never overwritten by anything
except a later `success_observed` or the clock. `snapshot_id` is
`sha256(canonicalJson(windows))`, reusing the receipt ledger's canonicalisation
discipline.

`claimCanary` is a compare-and-set under the same lock, for the same reason
`CompletionJournal.claimTokenAttempt` is: two concurrent invocations must not both decide
they are the canary.

### 2.9 Reading the sources safely

The passive scanners read files that contain everything Antonin does. Constraints:

- read-only, `O_RDONLY`, no writes, no truncation, no mutation of any session — handoff
  guard-rail 8;
- paths restricted to `~/.codex/sessions` and `~/.claude/projects`, resolved through
  `realpath` and rejected if they escape those roots;
- bounded scan: the newest 20 files by mtime, stop at the first parsed record, byte cap
  per file. There are already 275 rollout files on this machine; an unbounded scan turns
  a routing decision into a disk sweep. Mission Control already applies the same
  discipline — `scanCodexSessions(limit = DEFAULT_FILE_SCAN_LIMIT)` caps at 120 files —
  so this is a borrowed convention, not a new one, and a much tighter cap is affordable
  here because the engine needs one record, not an inventory;
- only the numeric fields listed in §2.2 are extracted. Raw lines, prompts, project
  paths, session ids and model output are never persisted into `quotas.json` — which also
  keeps the quota metadata pushed to Mission Control free of session identifiers.

## 3. Failure taxonomy

The matrix is only as good as its input axis, so failure kinds are defined by what the
*existing code* can actually distinguish, not by an idealised taxonomy.

| kind | how it is recognised today | fallback-eligible |
| --- | --- | --- |
| `policy_reject` | `evaluateTask` returns `status !== "execute_local"` | no — owner |
| `local_daemon_unreachable` | `OllamaClient.complete` throws `Ollama request failed: …` with no HTTP status | yes, but **skips every Ollama rung** |
| `local_model_error` | `Ollama request failed (4xx): …` | yes, next local rung |
| `local_transient` | `Ollama request failed (5xx)`, or `AbortSignal.timeout` at `OllamaClient.timeoutMs` | yes, one same-rung retry then next |
| `local_output_invalid` | `Ollama returned an invalid chat completion`, or `Ollama response exceeds the task resolution limit` in `run-once.mjs` | yes, one rung, then owner |
| `cloud_quota_exhausted` | refusal string, HTTP 429, or `used_percent >= 100` | yes, other provider or defer |
| `cloud_auth_missing` | no subscription detected for that runtime | yes, provider dropped for the run |
| `cloud_transient` | 5xx or timeout from a cloud runner | yes, one retry then other provider |
| `control_plane_ambiguous` | `MissionControlRequestError` with `ambiguous === true` | **no** |
| `lease_lost` | `isStaleLeaseError(error)`, or `CompletionContendedError` | **no** |
| `unknown` | anything unclassified | **no** — fail closed |

`unknown` failing closed is deliberate. An unclassified error is by definition an error
whose side effects we cannot bound; retrying it on another provider is how a design like
this silently double-executes.

## 4. Fallback matrix

### 4.1 The route ladder

```text
rung 1  ollama/qwen2.5-coder:7b     local, primary
rung 2  ollama/qwen2.5-coder:14b    local, larger
rung 3  ollama/qwen3:14b            local, general
rung 4  claude-code (max)           subscription
rung 5  codex (chatgpt pro)         subscription
rung 6  defer  → awaiting_owner     stop
```

Rungs 1–3 are the models actually installed (handoff §7). Rungs 4–5 are ordered per
attempt, not fixed: the engine prefers the cloud provider whose **scarcer window** has
more headroom, and applies §4.4.

### 4.2 The completion boundary — the rule that makes this safe

**Fallback applies to the execution attempt only. It never applies once a completion
exists.**

In `run-once.mjs` the completion journal entry is created by `completionEntry(...)` and
`CompletionJournal.begin(...)` *after* `ollama.complete(prompt)` has returned. Everything
before that point produced no output, no token record, no task mutation and no receipt —
it is safely retryable. Everything after that point is governed by `reconcileCompletion`
and must reach exactly one of `review`, pending reconciliation, or `contended`.

Two consequences, both non-negotiable:

- `control_plane_ambiguous` and `lease_lost` are not fallback-eligible. They occur after
  the boundary and their existing handling — reconciliation, `TokenReconciliationRequired`,
  `contendedResult` — already encodes rulings that took four review rounds to get right
  (`progress.md`, Task 2). Re-routing there would double-execute and duplicate token
  accounting that is at-most-once by design;
- `CompletionJournal.begin` already refuses a second pending entry for the same
  `(task_id, fencing_token)` unless the first is `receipt_confirmed`. That refusal is the
  backstop: even a buggy future fallback cannot open a second completion for one lease.

### 4.3 The matrix

Risk classes come from `evaluateTask`: `mechanical` (the v0 allow-list, `tier !== SOLIDE`,
priority not `high`/`critical`) and `sensitive` (everything else). There is no third
class today and this design does not invent one.

**Fallback never upgrades a task's risk class.** The cloud is a fallback for mechanical
work, not an escalation path for sensitive work. A `sensitive` task goes to Antonin at
every cell of the matrix, whatever the quota state.

| risk | failure kind | quota state of the next rung | decision | route |
| --- | --- | --- | --- | --- |
| sensitive | any | any | `awaiting_owner` | none |
| mechanical | `policy_reject` | any | `awaiting_owner` | none |
| mechanical | `local_daemon_unreachable` | cloud `ok` | `execute_cloud` | best cloud rung |
| mechanical | `local_daemon_unreachable` | cloud `warn`/`critical`/`exhausted` | `defer` | none |
| mechanical | `local_daemon_unreachable` | cloud `unknown`, canary available | `execute_cloud` (canary) | best cloud rung |
| mechanical | `local_daemon_unreachable` | cloud `unknown`, canary spent | `defer` | none |
| mechanical | `local_model_error` | next local rung available | `execute_local` | rung n+1 |
| mechanical | `local_model_error` | no local rung left, cloud `ok` | `execute_cloud` | best cloud rung |
| mechanical | `local_model_error` | no local rung left, cloud not `ok` | `defer` | none |
| mechanical | `local_transient` | same rung, attempt 1 | `execute_local` (retry) | same rung |
| mechanical | `local_transient` | same rung, attempt ≥ 2 | as `local_model_error` | — |
| mechanical | `local_output_invalid` | next local rung, attempt 1 | `execute_local` | rung n+1 |
| mechanical | `local_output_invalid` | attempt ≥ 2 | `awaiting_owner` | none |
| mechanical | `cloud_quota_exhausted` | other cloud `ok` | `execute_cloud` | other provider |
| mechanical | `cloud_quota_exhausted` | other cloud not `ok`, earliest reset ≤ max defer | `defer` | none |
| mechanical | `cloud_quota_exhausted` | earliest reset > max defer | `awaiting_owner` | none |
| mechanical | `cloud_auth_missing` | other cloud `ok` | `execute_cloud` | other provider |
| mechanical | `cloud_auth_missing` | other cloud not `ok` | `awaiting_owner` | none |
| mechanical | `cloud_transient` | same provider, attempt 1 | `execute_cloud` (retry) | same provider |
| mechanical | `cloud_transient` | attempt ≥ 2 | as `cloud_quota_exhausted` | — |
| any | `control_plane_ambiguous` | any | reconcile (existing path) | unchanged |
| any | `lease_lost` | any | `contended` (existing path) | unchanged |
| any | `unknown` | any | `awaiting_owner` + failure receipt | none |
| any | attempts ≥ `ANTONIN_MAX_ATTEMPTS` | any | `awaiting_owner` | none |

`local_output_invalid` is capped at one extra rung on purpose: repeated refusal to
produce a well-formed short answer is usually evidence the task was not mechanical, and
the honest response to that is Antonin, not a bigger model.

### 4.4 Admission requires a reviewer, not just an executor

Handoff §13 principle 7: local work requires a distinct cloud review before `done`. It
follows that **executor capacity alone is not sufficient to admit a task**. Before any
execution the engine checks:

1. the executor rung is admissible (state, expected cost, availability); and
2. a **distinct** reviewer route is admissible for the projected review cost.

If (2) fails, the decision is `defer`, not `execute_local`. Running local work that can
never be reviewed burns machine time and parks tasks in `review` indefinitely — which is
exactly the stall Mission Control would then display as progress.

This also means the reviewer is re-derived per attempt, not fixed at configuration time.
Today `validateProcessConfig` in `run-once.mjs` rejects a reviewer equal to the policy
agent or to the local model, and `evaluateTask` returns `reviewer_must_be_distinct` for
the same reason. Once the executor can be a cloud provider, the same check must run
against the **effective route of the attempt**: falling back to Codex for execution while
`poc-aegis-cloud` (a Codex runtime) reviews would let one provider grade its own work.
In that case the engine reassigns the reviewer to the other provider, or refuses with
`reviewer_must_be_distinct`.

### 4.5 Admission control on the 5 h window

The weekly window is protected by a percentage reserve. The 5 h window is protected
differently, because its failure mode is different: it kills work in flight. A percentage
is the wrong instrument; the right one is **do not start a job whose expected cost
exceeds what is left**:

```text
admissible_5h  ⇔  remaining_fraction × tokens_per_window  ≥  p90_cost(route) × safety_factor
```

with `p90_cost` from §2.7. A job that cannot finish inside the current window is deferred
until the window resets rather than started and killed halfway.

### 4.6 Deferral

`defer` is a new terminal outcome for an invocation, distinct from `awaiting_owner`:
nothing is wrong, the work is simply not runnable now.

- the task is returned to `assigned` for the policy agent through the existing
  `MissionControlClient.updateTask` (`status`, `assigned_to`, `metadata`, `error_message`
  are all in `TASK_UPDATE_FIELDS`);
- `metadata.policy_mvp.deferred_until` carries the ISO instant, and `error_message`
  carries a short non-secret reason. Both are operator-visible: Mission Control displays
  the wait, it does not decide it;
- metadata is merged with a fresh read, exactly as `taskUpdateWithFreshMetadata` already
  does, so a concurrent operator edit is not clobbered;
- **no completion journal entry, no token record, no receipt.** A deferral is not work;
- the lease is released through the normal `releaseLeaseForCleanup` path;
- the CLI exits 0 with `{ "outcome": "deferred", "processed": 0, "taskId": …,
  "deferredUntil": … }`.

Known limitation, stated rather than hidden: Mission Control's queue cannot filter on
`deferred_until`, so a deferred task can be claimed again by the next invocation. The
engine re-defers immediately, before any provider call, at the cost of one claim cycle.
Backing that off properly belongs to whatever scheduler is added later — the MVP is still
one-shot by design.

### 4.7 Preserving context, budget and audit across attempts

**Context.** A fallback-eligible failure produced no output, so the only context to
preserve is the task itself plus the attempt history. Attempts inside one invocation are
in memory. Attempts across invocations live in
`metadata.policy_mvp.attempt_log`: a bounded array (last 5) of
`{ route, failure_kind, at }`. Route identifiers and enum values only — never prompts,
never model output, never error strings that could carry task content.

**Budget.** Three ceilings, all Antonin's values (§5): `ANTONIN_MAX_ATTEMPTS` per task,
`ANTONIN_MAX_DEFER_MS`, and a daily cloud spend fraction. The attempt counter is the
length of `attempt_log`, so it survives process exit without new state.

**Identity — the trap.** `completionEntry` currently derives
`completion_id = sha256(task_id \0 input_hash \0 output_hash)`, which does not include the
route. With one route that is fine. With a ladder, two routes producing byte-identical
output would collide on one completion id while
`receiptAlreadyStored` matches on `STABLE_RECEIPT_FIELDS` — which *does* include `route`.
The journal would consider the completion known while the ledger would not find its
receipt, and a second receipt would be appended for one completion. Policy v1 therefore
derives:

```text
completion_id = sha256(task_id \0 route \0 input_hash \0 output_hash)
```

and — critically — **identity is computed from the entry's own recorded
`policy_version`, never from the current build's `POLICY_VERSION` constant.** A pending
v0 entry left in `completions.json` by an older build must keep resolving under the v0
rule. The current `reconcileCompletion` already reads `current.receipt` from the journal
rather than recomputing it; that property must be preserved, not accidentally optimised
away.

**Audit.** Receipt schema v1 adds exactly three scalar fields, each mapping onto a
validator that already exists in `receipt-ledger.mjs`:

| field | validator | value |
| --- | --- | --- |
| `attempt` | `assertNonNegativeInteger`, non-zero | 1-based attempt that produced this receipt |
| `route_chain` | `assertBoundedString(…, 512)` | `"ollama/qwen2.5-coder:7b>claude-code/max"` |
| `quota_snapshot_hash` | `assertSha256` | pointer into `quota-observations.jsonl` |

No nested objects, no new validator families, no raw text. `route_chain` is built from
route identifiers only, so it cannot leak task content, and none of the three field names
trips `assertNoSensitiveFields`.

**The migration hazard.** `RECEIPT_SCHEMA_VERSION` is currently `antonin-receipt-v0`,
`STORED_FIELDS` is an exact set, and `assertStoredRecord` throws
`unsupported schema version at line N` for anything else — and `#readAndVerify` runs over
the **entire** file on every `append` and every `verify`. Bumping the constant naively
would make the first v1 append reject every existing v0 record and brick both the ledger
and `verify-ledger`. The verifier must therefore validate **each record against the field
set of its own `schema_version`**, accepting a mixed v0/v1 chain. This is a correctness
requirement, not a nicety.

## 5. Decisions reserved to Antonin

The engine must not invent any of these. Each needs a value before implementation starts;
the parenthesised figure is a proposal to react to, not a default to adopt silently.

1. **Weekly reserve per provider** — the share of the weekly window the fleet must never
   touch, so Antonin's own interactive work survives the week (proposal: 25 %). This is
   the single most consequential number here: it decides who gets the scarce resource,
   the fleet or Antonin.
2. **5 h safety factor** (proposal: 1.5 × p90) and whether admission control on that
   window applies to reviews as well as executions.
3. **`tokens_per_window` per provider/plan** — the constant that converts a fraction into
   a token budget. Only Antonin can source it, from `/usage`.
4. **Fail-open or fail-closed on `unknown` cloud quota.** This design proposes
   fail-closed plus the canary; fail-open would be faster and would occasionally kill
   agents in flight.
5. **`ANTONIN_MAX_ATTEMPTS`** (proposal: 3) and **`ANTONIN_MAX_DEFER_MS`** (proposal: 6 h,
   above which a deferral becomes `awaiting_owner`).
6. **Daily cloud spend ceiling** for the fleet, expressed as a fraction of the weekly
   window per day (proposal: 10 %).
7. **What happens to local work when no reviewer capacity exists** — defer before
   executing (this design's proposal) or execute and let it sit in `review`. The second
   option trades a visible stall for throughput.
8. **Whether a paid API-key route is ever admissible** as a last rung. Today: no, and
   nothing in this design assumes otherwise. Adding one turns quota into money and
   changes the risk conversation entirely.
9. **Whether cloud fallback may run at all while Antonin is working**, or only in an
   off-hours window.
10. **Operator timezone authority** for resolving `resets 7:30pm` (Europe/Paris assumed)
    and behaviour across DST transitions.
11. **Whether a cloud runner may spawn a subprocess at all** — see §7. The MVP forbids
    shell execution outright; rungs 4–5 cannot exist until that prohibition is
    deliberately amended.

## 6. Test plan for the future implementation

Same discipline as the existing suite: built-in `node:test`, injected clocks
(`options.now`), temp directories, fake loopback HTTP servers, no network, no real
provider. Run with `node --test ops/antonin-poc/policy-mvp/test/*.test.mjs`.

New file `ops/antonin-poc/policy-mvp/test/quota.test.mjs`:

1. first observation writes `quotas.json` with mode `600` and replaces it atomically;
2. `observe` is monotonic: an older `observed_at` is discarded;
3. an `exhausted` latch survives repeated snapshots and is cleared only by the clock;
4. after reset the window becomes `unknown`, not `ok`, and the canary interval is zero;
5. staleness beyond the maximum degrades any value to `unknown`;
6. a heuristic source can move a window to `warn`/`critical`/`exhausted` but **never** to
   `ok` — asserted in both directions;
7. a declarative observation outranks a heuristic one until it goes stale;
8. Codex rollout parsing against a fixture with the observed shape — including
   `limit_name: null`, `window_minutes: 10080`, `resets_at` in **seconds** — yields the
   weekly window with `used_fraction 1.0` and `state exhausted`;
9. Claude refusal parsing of `You've hit your session limit · resets 7:30pm
   (Europe/Paris)` resolves to the next occurrence, including the rollover case (observed
   at 20:00 → tomorrow) and a DST boundary;
10. scan bounds: with 300 fixture files, at most the configured number are opened
    (counting fs stub), and the scan stops at the first parsed record;
11. `quotas.json` and `quota-observations.jsonl` contain no prompt text, no session id, no
    project path and no API key — asserted by scanning the written bytes;
12. path guard: a source root outside `~/.codex/sessions` / `~/.claude/projects`,
    including via symlink, is refused;
13. `claimCanary` elects exactly one winner under concurrent invocations.

Additions to `ops/antonin-poc/policy-mvp/test/core.test.mjs`:

14. `planRoute` is pure: it performs no I/O (injected throwing `fetch`) and is
    deterministic for identical inputs;
15. the matrix is **total**: the cartesian product of (risk × failure kind × quota state)
    is enumerated and every cell resolves to exactly one decision — no cell falls through;
16. `classifyFailure` maps the real errors produced by the existing clients: connection
    refused, 404, 500, `AbortSignal.timeout`, an ambiguous 2xx mutation, a stale-lease
    error. Errors are constructed by driving `OllamaClient` and `MissionControlClient`
    against fake servers, not by hand-writing message strings;
17. `lease_lost` and `control_plane_ambiguous` never yield a fallback route;
18. an unclassified error yields `awaiting_owner`, never a route;
19. a `sensitive` task yields `awaiting_owner` at every failure kind and quota state;
20. when the fallback route belongs to the reviewer's provider, the decision either
    reassigns the reviewer or returns `reviewer_must_be_distinct`;
21. admission refuses when reviewer capacity is missing even though executor capacity is
    fine;
22. the 5 h admission inequality defers a job whose p90 cost exceeds the remaining window.

Additions to `ops/antonin-poc/policy-mvp/test/run-once.test.mjs`:

23. local daemon unreachable + admissible cloud → exactly **one** completion journal
    entry, **one** receipt, `route` equal to the cloud route, `attempt: 2`, and a
    `route_chain` naming both rungs;
24. every cloud rung exhausted → `deferred` outcome, task PUT back to `assigned` with
    `deferred_until`, **no** receipt, **no** token record, lease released, exit 0;
25. a deferred task claimed again is re-deferred before any provider call;
26. attempts exhausted → `awaiting_owner`, one failure receipt, `attempt_log` bounded to
    5 entries and free of task text;
27. a fallback attempt after a completion entry exists is impossible: the second
    `CompletionJournal.begin` for the same `(task_id, fencing_token)` is refused;
28. a pending v0 journal entry is reconciled under the v0 identity rule after the build
    moves to v1 — no duplicate receipt;
29. receipt ledger accepts a mixed v0/v1 chain, `verify-ledger` passes on a v0-only
    ledger, and a v1-only field on a v0 record is rejected;
30. the cost estimator ignores failure receipts and reads a bounded tail of the ledger;
31. every new error path passes through `safeErrorMessage(error, mcApiKey)`: no new
    message can leak the API key;
32. `quota-status` CLI output is JSON, non-secret, and contains no session identifiers.

Regression gates, unchanged and all required green before completion:

```bash
node --test ops/antonin-poc/policy-mvp/test/*.test.mjs
bash ops/antonin-poc/test-mc-poc.sh
corepack pnpm test
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm api:parity
```

## 7. What this design does not cover

- **The cloud runner itself.** Rungs 4–5 are CLI subscriptions, not HTTP endpoints:
  `OllamaClient` is loopback-HTTP-only by construction (`validateLoopbackHttpUrl`), and
  the MVP forbids shell execution. A `claude`/`codex` runner means spawning a subprocess,
  which needs its own spec and its own gate — argv-only invocation with no shell, no
  repository working directory, no inherited secrets, bounded timeout, bounded output.
  This document defines only the *contract* such a runner must satisfy: the same
  `{ text, inputTokens, outputTokens }` shape as `OllamaClient.complete`, plus typed
  errors that `classifyFailure` can map. Until that gate is passed, the ladder stops at
  rung 3 and everything below it is `defer` or `awaiting_owner`.
- **Money.** No currency, no invoices, no API-key billing, no spend reconciliation. The
  scarce resource here is quota, not euros.
- **Scraping `/usage`.** No authenticated session, no browser automation, no credential
  handling. The only path from `/usage` into the engine is Antonin typing a number.
- **Any change to Mission Control core.** `src/` is untouched. The upstream fixes in
  handoff §14 — `classifyDirectModel()` prefix loss, structured quota exposure, reviewer
  route separation — remain separate contributions with their own PRs.
- **Reviewer routing policy** beyond quota admission (handoff §12.5). Which cloud model
  reviews what, and how Aegis is configured, stays open.
- **Leases, receipts hosting, lease unit** (handoff §18). This design consumes the
  existing single-host `LeaseStore` and `ReceiptLedger` and adds no distributed
  coordination. Two machines running this engine would still be unsafe.
- **A scheduler or daemon.** Still one task per invocation.
- **Model capability routing.** This is about capacity, not about which model is better at
  what. Choosing a rung for quality reasons is a different policy.
- **Notifications.** Whether a `defer` or an `awaiting_owner` pings Antonin is a Mission
  Control / Telegram concern.
- **The OpenClaw approvals bridge** (handoff §12.10).

## 8. Open questions carried forward

Not Antonin's product decisions (those are §5) — genuinely unresolved engineering
questions:

- how to detect that the *operator* is interactively consuming the same subscription
  right now, so the fleet can yield to him instead of racing him. The transcript scanner
  can see recent activity, but that is another non-contractual read;
- whether `quota-observations.jsonl` should eventually be hash-chained, or whether keeping
  it deliberately non-authoritative is the better safety property;
- whether the canary should prefer the smallest queued task, so that the measurement costs
  as little as possible when it succeeds;
- how a refusal observed by a *subprocess* runner is surfaced reliably, given that the
  refusal is a message in the model's output stream rather than a process exit code.
