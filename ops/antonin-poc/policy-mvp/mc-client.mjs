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
    return this.#request(taskPath(taskId), { method: "PUT", body: update });
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
    return this.#request("/api/tokens", { method: "POST", body: payload });
  }

  async #request(pathname, options = {}) {
    const url = new URL(pathname, this.baseUrl);
    let response;
    try {
      response = await fetch(url, {
        method: options.method ?? "GET",
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
      throw new Error(`Mission Control request failed: ${detail}`);
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
      throw new Error(
        `Mission Control request failed (${response.status}): ${error.message}`,
      );
    }

    let data;
    try {
      data = raw === "" ? {} : JSON.parse(raw);
    } catch {
      throw new Error(
        `Mission Control request failed (${response.status}): invalid JSON response`,
      );
    }

    if (!response.ok) {
      const detail = sanitizeErrorDetail(data?.error, this.apiKey);
      throw new Error(
        `Mission Control request failed (${response.status}): ${detail}`,
      );
    }
    return data;
  }
}
