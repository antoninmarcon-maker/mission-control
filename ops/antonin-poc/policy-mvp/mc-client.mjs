import { validateLoopbackHttpUrl } from "./policy-core.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 320;
const TASK_UPDATE_FIELDS = new Set([
  "status",
  "assigned_to",
  "resolution",
  "metadata",
  "error_message",
]);

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

async function readBoundedText(response, maximumBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`response exceeded ${maximumBytes} bytes`);
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error(`response exceeded ${maximumBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sanitizeErrorDetail(value, apiKey) {
  const text = typeof value === "string" ? value : "request failed";
  const redacted = apiKey === "" ? text : text.split(apiKey).join("[REDACTED]");
  if (redacted.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function taskPath(taskId, suffix = "") {
  const normalized = String(taskId);
  requireNonEmptyString(normalized, "taskId");
  return `/api/tasks/${encodeURIComponent(normalized)}${suffix}`;
}

export class MissionControlRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MissionControlRequestError";
    this.ambiguous = options.ambiguous === true;
    this.status = options.status ?? null;
  }
}

function mutationResponseError(message) {
  return new MissionControlRequestError(message, { ambiguous: true });
}

/**
 * Structural equality over JSON values. A field of the policy metadata is not
 * always a scalar — §4.7's `attempt_log` is an array — and comparing those by
 * identity would fail every time, because the value read back has been through
 * JSON and is never the object that was sent.
 */
function sameJsonValue(actual, expected) {
  if (actual === expected) return true;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => sameJsonValue(actual[index], value))
    );
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      return false;
    }
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every((key, index) => key === actualKeys[index]) &&
      expectedKeys.every((key) => sameJsonValue(actual[key], expected[key]))
    );
  }
  return false;
}

function completionMetadataMatches(actual, expected) {
  if (expected === undefined) return true;
  if (
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(actual)
  ) {
    return false;
  }
  return Object.entries(expected).every(([field, value]) =>
    sameJsonValue(actual[field], value),
  );
}

export class MissionControlClient {
  constructor(options = {}) {
    const validatedUrl = validateLoopbackHttpUrl(options.baseUrl, "MC_URL");
    requireNonEmptyString(options.apiKey, "MC_API_KEY");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    requirePositiveInteger(timeoutMs, "timeoutMs");
    requirePositiveInteger(maxResponseBytes, "maxResponseBytes");

    this.baseUrl = validatedUrl;
    this.apiKey = options.apiKey;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async claimOne(agent) {
    requireNonEmptyString(agent, "agent");
    const query = new URLSearchParams({ agent, max_capacity: "1" });
    const response = await this.#request(`/api/tasks/queue?${query}`);
    if (response === null || response.task == null) {
      return null;
    }
    if (typeof response.task !== "object" || Array.isArray(response.task)) {
      throw new Error("Mission Control queue returned an invalid task");
    }
    return response.task;
  }

  async updateTask(taskId, update) {
    if (update === null || typeof update !== "object" || Array.isArray(update)) {
      throw new TypeError("task update must be an object");
    }
    for (const field of Object.keys(update)) {
      if (!TASK_UPDATE_FIELDS.has(field)) {
        throw new TypeError(`unsupported task update field: ${field}`);
      }
    }
    const response = await this.#request(taskPath(taskId), {
      method: "PUT",
      body: update,
    });
    if (
      response?.task === null ||
      typeof response?.task !== "object" ||
      Array.isArray(response.task)
    ) {
      throw mutationResponseError(
        "Mission Control returned an invalid task mutation response",
      );
    }
    if (
      update.status !== undefined &&
      response.task.status !== update.status
    ) {
      throw mutationResponseError(
        `Mission Control did not confirm status ${String(update.status)}`,
      );
    }
    if (
      update.assigned_to !== undefined &&
      response.task.assigned_to !== update.assigned_to
    ) {
      throw mutationResponseError(
        `Mission Control did not confirm reviewer ${String(update.assigned_to)}`,
      );
    }
    if (
      update.resolution !== undefined &&
      response.task.resolution !== update.resolution
    ) {
      throw mutationResponseError("Mission Control did not confirm resolution");
    }
    if (
      !completionMetadataMatches(
        response.task.metadata?.policy_mvp,
        update.metadata?.policy_mvp,
      )
    ) {
      throw mutationResponseError(
        "Mission Control did not confirm completion metadata",
      );
    }
    return response;
  }

  async getTask(taskId) {
    const response = await this.#request(taskPath(taskId));
    if (
      response?.task === null ||
      typeof response?.task !== "object" ||
      Array.isArray(response.task)
    ) {
      throw new Error("Mission Control returned an invalid task response");
    }
    return response.task;
  }

  async addComment(taskId, content) {
    requireNonEmptyString(content, "comment content");
    return this.#request(taskPath(taskId, "/comments"), {
      method: "POST",
      body: { content },
    });
  }

  async recordTokens(record) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError("token record must be an object");
    }
    const payload = Object.fromEntries(
      [
        "model",
        "sessionId",
        "inputTokens",
        "outputTokens",
        "operation",
        "duration",
        "taskId",
      ]
        .filter((field) => record[field] !== undefined)
        .map((field) => [field, record[field]]),
    );
    const response = await this.#request("/api/tokens", {
      method: "POST",
      body: payload,
    });
    if (
      response?.success !== true ||
      response.record === null ||
      typeof response.record !== "object" ||
      Array.isArray(response.record) ||
      response.record.sessionId !== payload.sessionId
    ) {
      throw mutationResponseError(
        "Mission Control returned an invalid token mutation response",
      );
    }
    return response;
  }

  async findTokenRecord(sessionId) {
    requireNonEmptyString(sessionId, "sessionId");
    const response = await this.#request(
      "/api/tokens?action=list&timeframe=all",
    );
    if (!Array.isArray(response?.usage)) {
      throw new Error("Mission Control returned an invalid token list response");
    }
    return (
      response.usage.find((record) => record?.sessionId === sessionId) ?? null
    );
  }

  async #request(pathname, options = {}) {
    const url = new URL(pathname, this.baseUrl);
    const method = options.method ?? "GET";
    const isMutation = method !== "GET";
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          accept: "application/json",
          "x-api-key": this.apiKey,
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const detail = sanitizeErrorDetail(error?.message, this.apiKey);
      throw new MissionControlRequestError(
        `Mission Control request failed: ${detail}`,
        { ambiguous: isMutation },
      );
    }

    if (response.status === 204) {
      return null;
    }

    const maximumBytes = response.ok
      ? this.maxResponseBytes
      : Math.min(this.maxResponseBytes, MAX_ERROR_BYTES);
    let raw;
    try {
      raw = await readBoundedText(response, maximumBytes);
    } catch (error) {
      throw new MissionControlRequestError(
        `Mission Control request failed (${response.status}): ${error.message}`,
        { ambiguous: response.ok && isMutation, status: response.status },
      );
    }

    let data;
    try {
      data = raw === "" ? {} : JSON.parse(raw);
    } catch {
      throw new MissionControlRequestError(
        `Mission Control request failed (${response.status}): invalid JSON response`,
        { ambiguous: response.ok && isMutation, status: response.status },
      );
    }

    if (!response.ok) {
      const detail = sanitizeErrorDetail(data?.error, this.apiKey);
      throw new MissionControlRequestError(
        `Mission Control request failed (${response.status}): ${detail}`,
        { ambiguous: false, status: response.status },
      );
    }
    return data;
  }
}
