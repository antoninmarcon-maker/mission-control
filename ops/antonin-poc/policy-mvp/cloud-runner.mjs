import { spawn as defaultSpawn } from "node:child_process";
import path from "node:path";

import { CLOUD_PROVIDERS } from "./quota-config.mjs";

/**
 * §7 the cloud runner contract. Rungs 4-5 of the §4.1 ladder are CLI
 * subscriptions, not HTTP endpoints, so reaching them means spawning a
 * subprocess — the thing the MVP forbade until Antonin authorised it on
 * 2026-08-28 (§5.11, « Autoriser (Recommandé) »).
 *
 * The gate this module has to satisfy, verbatim from §7: "argv-only invocation
 * with no shell, no repository working directory, no inherited secrets,
 * bounded timeout, bounded output", returning "the same
 * `{ text, inputTokens, outputTokens }` shape as `OllamaClient.complete`, plus
 * typed errors that `classifyFailure` can map".
 *
 * Two properties are load-bearing beyond that list:
 *
 * - the prompt travels on **stdin**, never in argv, so no task text can be
 *   read out of the process table by anything running on this machine;
 * - the runner never re-emits what it reads. Model output, stderr, argv and
 *   the environment never appear in an error message, a log line or a quota
 *   observation. A refusal is reported as the *fact* of a refusal plus a
 *   parsed reset instant, nothing else.
 */

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const KILL_SIGNAL = "SIGKILL";

/**
 * The child's environment is an allow-list, not the parent's environment minus
 * a deny-list: a deny-list silently leaks every variable nobody thought of.
 * `HOME` is deliberately present — that is where the subscription credential
 * lives, and using the subscription is the whole point of rungs 4-5 — while
 * every API key stays out, so a subscription rung can never quietly become the
 * metered API route §5.8 does not authorise.
 */
const INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
]);

const REFUSAL_PATTERN =
  /hit your (session|weekly|usage|rate) limit(?:[^\n]{0,160}?\bresets?\b[^\n]{0,20}?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i;

export class CloudRunnerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CloudRunnerError";
    this.provider = details.provider ?? null;
    if (typeof details.failureKind === "string") {
      // §3 the taxonomy is fed by a runner-declared kind. Leaving it undefined
      // is not an oversight: an exit this runner cannot explain must classify
      // as `unknown` and fail closed to the owner.
      this.failureKind = details.failureKind;
    }
    if (details.quotaWindowId !== undefined) {
      this.quotaWindowId = details.quotaWindowId;
    }
    if (details.resetsAt !== undefined) {
      this.resetsAt = details.resetsAt;
    }
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function zoneOffsetMs(timeZone, instant) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const fields = {};
  for (const part of parts) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour % 24,
    fields.minute,
    fields.second,
  );
  return asUtc - instant;
}

function localFields(timeZone, instant) {
  const offset = zoneOffsetMs(timeZone, instant);
  const shifted = new Date(instant + offset);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function instantForLocal(timeZone, { year, month, day, hour, minute }) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  // One correction pass, then a second: the first uses the offset in force at
  // the guessed instant, the second the offset actually in force at the
  // corrected one. That is what makes a DST transition resolve to a real
  // instant instead of an hour that does not exist.
  const first = guess - zoneOffsetMs(timeZone, guess);
  return guess - zoneOffsetMs(timeZone, first);
}

/**
 * §1 the Claude refusal carries a local wall-clock time, no date and no zone
 * beyond what the operator knows. Resolving it needs the operator timezone
 * (§5.10) and a rollover rule: a time already past today means tomorrow.
 */
export function resolveWallClockInstant({ hour, minute, timeZone, now }) {
  const today = localFields(timeZone, now);
  const candidate = instantForLocal(timeZone, { ...today, hour, minute });
  if (candidate > now) return candidate;
  const tomorrow = new Date(
    Date.UTC(today.year, today.month - 1, today.day) + 86_400_000,
  );
  return instantForLocal(timeZone, {
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth() + 1,
    day: tomorrow.getUTCDate(),
    hour,
    minute,
  });
}

/**
 * §2.4 the *fact* of a refusal is contractual — the provider refused this very
 * call — while the reset time inside the sentence is a heuristic reading of
 * free text. An unparseable time therefore yields a refusal with no reset
 * rather than a guessed one.
 */
export function parseQuotaRefusal(text, { now, timeZone }) {
  if (typeof text !== "string" || text === "") return null;
  const match = REFUSAL_PATTERN.exec(text);
  if (match === null) return null;

  const windowId = match[1].toLowerCase() === "weekly" ? "weekly" : "session_5h";
  if (match[2] === undefined) return { windowId, resetsAt: null };

  const meridiem = match[4]?.toLowerCase() ?? null;
  let hour = Number(match[2]);
  const minute = match[3] === undefined ? 0 : Number(match[3]);
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { windowId, resetsAt: null };

  return {
    windowId,
    resetsAt: resolveWallClockInstant({ hour, minute, timeZone, now }),
  };
}

function normalizeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * `claude --print --output-format json` answers with a single result object.
 * The parse is deliberately tolerant: an unrecognised shape degrades to the
 * raw text with unknown token counts instead of failing a completion that did
 * happen and was paid for.
 */
function readClaudeJson(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return { text: stdout.trim(), inputTokens: 0, outputTokens: 0 };
  }
  const text =
    typeof payload?.result === "string"
      ? payload.result
      : typeof payload?.text === "string"
        ? payload.text
        : stdout.trim();
  return {
    text,
    inputTokens: normalizeTokenCount(payload?.usage?.input_tokens),
    outputTokens: normalizeTokenCount(payload?.usage?.output_tokens),
  };
}

export class CloudSubprocessRunner {
  constructor(options = {}) {
    if (!CLOUD_PROVIDERS.includes(options.provider)) {
      throw new TypeError(
        `provider must be one of ${CLOUD_PROVIDERS.join(", ")}`,
      );
    }
    requireNonEmptyString(options.command, "command");
    if (
      !Array.isArray(options.args) ||
      options.args.some((value) => typeof value !== "string")
    ) {
      throw new TypeError("args must be an array of strings");
    }
    if (
      typeof options.workingDirectory !== "string" ||
      !path.isAbsolute(options.workingDirectory)
    ) {
      throw new TypeError("workingDirectory must be an absolute path");
    }

    this.provider = options.provider;
    this.command = options.command;
    this.args = [...options.args];
    this.workingDirectory = options.workingDirectory;
    this.timeoutMs = requirePositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    this.maxOutputBytes = requirePositiveInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      "maxOutputBytes",
    );
    this.outputFormat = options.outputFormat ?? "text";
    this.timeZone = options.timeZone ?? "Europe/Paris";
    this.now = options.now ?? Date.now;
    this.spawn = options.spawn ?? defaultSpawn;
    this.environment = options.environment ?? process.env;
  }

  #childEnvironment() {
    const environment = Object.create(null);
    for (const key of INHERITED_ENVIRONMENT_KEYS) {
      const value = this.environment[key];
      if (typeof value === "string" && value !== "") environment[key] = value;
    }
    return environment;
  }

  #error(message, details = {}) {
    return new CloudRunnerError(message, { provider: this.provider, ...details });
  }

  async #run(prompt) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawn(this.command, this.args, {
          cwd: this.workingDirectory,
          env: this.#childEnvironment(),
          // No shell, ever: argv only, so nothing in a prompt or a model
          // answer can become a command.
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          signal: AbortSignal.timeout(this.timeoutMs),
          killSignal: KILL_SIGNAL,
        });
      } catch (error) {
        resolve({ outcome: "spawn_failed", error });
        return;
      }

      let stdout = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes > this.maxOutputBytes) {
          child.kill(KILL_SIGNAL);
          settle({ outcome: "output_too_large" });
          return;
        }
        stdout += chunk;
      });
      // stderr is drained so the child never blocks on a full pipe, and
      // discarded so its content cannot reach a log line or an error message.
      child.stderr.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) child.stderr.destroy();
      });

      child.on("error", (error) => settle({ outcome: "spawn_failed", error }));
      child.on("close", (code, signal) =>
        settle({ outcome: "closed", code, signal, stdout }),
      );

      child.stdin.on("error", () => {
        // A child that exits before reading its prompt closes the pipe; the
        // exit path reports that, so the write failure itself is not an event.
      });
      child.stdin.end(prompt, "utf8");
    });
  }

  /**
   * Same contract as `OllamaClient.complete`: `{ text, inputTokens,
   * outputTokens }` on success, a typed error otherwise.
   */
  async complete(prompt) {
    requireNonEmptyString(prompt, "prompt");
    const result = await this.#run(prompt);

    if (result.outcome === "output_too_large") {
      return Promise.reject(
        this.#error(
          `${this.provider} runner output exceeded ${this.maxOutputBytes} bytes`,
        ),
      );
    }
    if (result.outcome === "spawn_failed") {
      const code = result.error?.code;
      const name = result.error?.name;
      if (name === "AbortError" || name === "TimeoutError") {
        return Promise.reject(
          this.#error(`${this.provider} runner timed out`, {
            failureKind: "cloud_transient",
          }),
        );
      }
      if (code === "ENOENT" || code === "EACCES") {
        // §3 no runtime for that provider is a missing subscription: the
        // provider is dropped for the run rather than retried.
        return Promise.reject(
          this.#error(`${this.provider} runner is not available`, {
            failureKind: "cloud_auth_missing",
          }),
        );
      }
      return Promise.reject(this.#error(`${this.provider} runner failed to start`));
    }

    const completion =
      this.outputFormat === "claude_json"
        ? readClaudeJson(result.stdout)
        : { text: result.stdout.trim(), inputTokens: 0, outputTokens: 0 };

    // §2.6 the refusal is read before the exit code, because on Claude Code it
    // arrives as an ordinary assistant message on a successful run.
    const refusal = parseQuotaRefusal(completion.text || result.stdout, {
      now: this.now(),
      timeZone: this.timeZone,
    });
    if (refusal !== null) {
      return Promise.reject(
        this.#error(`${this.provider} refused the request: quota exhausted`, {
          failureKind: "cloud_quota_exhausted",
          quotaWindowId: refusal.windowId,
          resetsAt: refusal.resetsAt,
        }),
      );
    }

    if (result.signal !== null && result.signal !== undefined) {
      return Promise.reject(
        this.#error(`${this.provider} runner was killed`, {
          failureKind: "cloud_transient",
        }),
      );
    }
    if (result.code !== 0) {
      // Deliberately undeclared: an exit this runner cannot explain is
      // `unknown`, which §3 fails closed to the owner.
      return Promise.reject(
        this.#error(`${this.provider} runner exited with code ${result.code}`),
      );
    }
    if (typeof completion.text !== "string" || completion.text.trim() === "") {
      return Promise.reject(
        this.#error(`${this.provider} runner returned an empty completion`),
      );
    }
    return completion;
  }
}
