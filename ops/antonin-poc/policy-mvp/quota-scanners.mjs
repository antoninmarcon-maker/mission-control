import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parseQuotaRefusal } from "./cloud-runner.mjs";
import { QUOTA_WINDOW_CATALOG } from "./quota-config.mjs";

/**
 * §2.9 the passive source scanners. They read files that contain everything
 * Antonin does, so the constraints are the point of this module, not a detail:
 *
 * - read-only, `O_RDONLY`, no write, no truncation, no mutation of any session;
 * - every path resolved through `realpath` and refused if it escapes the roots
 *   it was given — a symlinked file inside the root is skipped, not followed;
 * - bounded: the newest files by mtime, a byte cap per file, a cap on the
 *   directory walk, and a stop at the first parsed record;
 * - only the numeric fields of §2.2 are extracted. Raw lines, prompts, project
 *   paths, session ids and model output never leave this module, which is what
 *   keeps them out of `quotas.json` and out of the metadata pushed to Mission
 *   Control.
 *
 * §2.6 also bounds what these readings are *allowed to do*: they skip a
 * provider we already know is blocked. They never authorise a spend — both
 * sources are heuristic, and §2.4 rule 1 forbids a heuristic reading from
 * reaching `ok`.
 */

export const CODEX_SESSIONS_ROOT = path.join(homedir(), ".codex", "sessions");
export const CLAUDE_PROJECTS_ROOT = path.join(homedir(), ".claude", "projects");

const DEFAULT_FILE_LIMIT = 20;
const DEFAULT_TAIL_BYTES = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 4_000;
const DEFAULT_MAX_DEPTH = 6;
const EARLIEST_INSTANT_MS = 1_000_000_000_000;
const LATEST_INSTANT_MS = 4_102_444_800_000;

function windowIdForMinutes(provider, windowMinutes) {
  const entry = QUOTA_WINDOW_CATALOG.find(
    (candidate) =>
      candidate.provider === provider &&
      candidate.window_minutes === windowMinutes,
  );
  return entry === undefined ? null : entry.window_id;
}

function instantFromSeconds(value) {
  if (!Number.isFinite(value)) return null;
  const milliseconds = Math.round(value * 1000);
  return milliseconds >= EARLIEST_INSTANT_MS && milliseconds <= LATEST_INSTANT_MS
    ? milliseconds
    : null;
}

function instantFromIso(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= EARLIEST_INSTANT_MS &&
    parsed <= LATEST_INSTANT_MS
    ? parsed
    : null;
}

/**
 * §1 the observed rollout shape. `used_percent` is a percentage, `resets_at`
 * is epoch **seconds**, and `secondary` is frequently null. A window length the
 * catalog does not know is skipped rather than mapped by guesswork.
 */
export function parseCodexRateLimits(rateLimits, { observedAt, now }) {
  if (
    rateLimits === null ||
    typeof rateLimits !== "object" ||
    Array.isArray(rateLimits)
  ) {
    return [];
  }
  const observations = [];
  for (const key of ["primary", "secondary"]) {
    const window = rateLimits[key];
    if (window === null || typeof window !== "object" || Array.isArray(window)) {
      continue;
    }
    const windowId = windowIdForMinutes("codex", window.window_minutes);
    if (windowId === null) continue;
    if (!Number.isFinite(window.used_percent)) continue;
    const usedFraction = Math.min(1, Math.max(0, window.used_percent / 100));
    const resetsAt = instantFromSeconds(window.resets_at);
    observations.push({
      provider: "codex",
      plan: "pro",
      window_id: windowId,
      source: "codex_rollout_rate_limits",
      observed_at: observedAt,
      used_fraction: usedFraction,
      ...(resetsAt === null ? {} : { resets_at: resetsAt }),
      // A heuristic may latch an exhaustion — that direction is only ever more
      // cautious — but never one whose reset has already passed.
      ...(usedFraction >= 1 && resetsAt !== null && resetsAt > now
        ? { exhausted_until: resetsAt }
        : {}),
    });
  }
  return observations;
}

function findRateLimits(node, depth = 0) {
  if (depth > 4 || node === null || typeof node !== "object") return null;
  if (Object.hasOwn(node, "rate_limits")) return node.rate_limits;
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") {
      const found = findRateLimits(value, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function claudeTextOf(record) {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n");
}

async function defaultReadTail(filePath, maximumBytes) {
  // O_RDONLY, a bounded tail, and nothing else: the file is never written,
  // truncated or locked, and a session in flight is unaffected.
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maximumBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // The window may start mid-record; that partial first line is dropped.
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

async function resolveScanRoot(root, allowedRoots) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new TypeError("scan root must be an absolute path");
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new TypeError("scan root must resolve inside a declared root");
  }
  let resolvedRoot;
  try {
    resolvedRoot = await realpath(root);
  } catch {
    throw new TypeError(`scan root must resolve inside a declared root`);
  }
  for (const allowed of allowedRoots) {
    let resolvedAllowed;
    try {
      resolvedAllowed = await realpath(allowed);
    } catch {
      continue;
    }
    if (
      resolvedRoot === resolvedAllowed ||
      resolvedRoot.startsWith(`${resolvedAllowed}${path.sep}`)
    ) {
      return resolvedRoot;
    }
  }
  throw new TypeError("scan root must resolve inside a declared root");
}

/** A bounded, depth-limited walk that never follows a link out of the root. */
async function newestFiles(resolvedRoot, { limit, maxEntries, maxDepth }) {
  const found = [];
  let visited = 0;
  const walk = async (directory, depth) => {
    if (depth > maxDepth || visited >= maxEntries) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= maxEntries) return;
      visited += 1;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(candidate, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let resolved;
      try {
        resolved = await realpath(candidate);
      } catch {
        continue;
      }
      if (
        resolved !== candidate &&
        !resolved.startsWith(`${resolvedRoot}${path.sep}`)
      ) {
        // A link pointing outside the root is skipped, never opened.
        continue;
      }
      try {
        const stats = await stat(candidate);
        found.push({ filePath: candidate, mtimeMs: stats.mtimeMs });
      } catch {
        // A file that disappeared between the listing and the stat is not an
        // error: sessions come and go while the engine runs.
      }
    }
  };
  await walk(resolvedRoot, 0);
  return found
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.filePath);
}

async function scanNewest({ root, allowedRoots, options }, extract) {
  const resolvedRoot = await resolveScanRoot(root, allowedRoots);
  const readTail = options.readTail ?? defaultReadTail;
  const maximumBytes = options.maxBytes ?? DEFAULT_TAIL_BYTES;
  const files = await newestFiles(resolvedRoot, {
    limit: options.limit ?? DEFAULT_FILE_LIMIT,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  });

  for (const filePath of files) {
    let text;
    try {
      text = await readTail(filePath, maximumBytes);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    // Newest record first: the tail of the file is the freshest reading.
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index] === "") continue;
      let record;
      try {
        record = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      const observations = extract(record);
      // §2.9 stop at the first parsed record.
      if (observations.length > 0) return observations;
    }
  }
  return [];
}

export async function scanCodexRateLimits(options = {}) {
  const now = options.now ?? Date.now();
  return scanNewest(
    {
      root: options.root ?? CODEX_SESSIONS_ROOT,
      allowedRoots: options.allowedRoots ?? [CODEX_SESSIONS_ROOT],
      options,
    },
    (record) => {
      const rateLimits = findRateLimits(record);
      if (rateLimits === null) return [];
      return parseCodexRateLimits(rateLimits, {
        observedAt: instantFromIso(record?.timestamp) ?? now,
        now,
      });
    },
  );
}

export async function scanClaudeRefusals(options = {}) {
  const now = options.now ?? Date.now();
  const timeZone = options.timeZone ?? "Europe/Paris";
  return scanNewest(
    {
      root: options.root ?? CLAUDE_PROJECTS_ROOT,
      allowedRoots: options.allowedRoots ?? [CLAUDE_PROJECTS_ROOT],
      options,
    },
    (record) => {
      const observedAt = instantFromIso(record?.timestamp) ?? now;
      const refusal = parseQuotaRefusal(claudeTextOf(record), {
        now: observedAt,
        timeZone,
      });
      if (refusal === null || refusal.resetsAt === null) return [];
      // A refusal whose reset has already passed says nothing about now, and
      // latching it would block a window the provider has since reopened.
      if (refusal.resetsAt <= now) return [];
      return [
        {
          provider: "claude-code",
          plan: "max",
          window_id: refusal.windowId,
          source: "claude_refusal_string",
          observed_at: observedAt,
          used_fraction: 1,
          exhausted_until: refusal.resetsAt,
        },
      ];
    },
  );
}

/**
 * Both sources, best effort. A scanner that throws must never fail a routing
 * decision: the engine's fallback for "no reading" is the canary rule, which
 * is exactly the situation an unreadable source leaves it in.
 */
export async function scanDeclaredQuota(options = {}) {
  const observations = [];
  for (const scan of [scanCodexRateLimits, scanClaudeRefusals]) {
    try {
      observations.push(...(await scan(options)));
    } catch {
      // Unreadable, absent, or outside its root: no reading, no decision.
    }
  }
  return observations;
}
