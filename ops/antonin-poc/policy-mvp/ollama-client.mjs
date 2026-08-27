import { validateLoopbackHttpUrl } from "./policy-core.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 320;

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
  if (!response.body) return "";

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

function boundedDetail(value) {
  const text = typeof value === "string" ? value : "request failed";
  if (text.length <= MAX_ERROR_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function normalizeTokenCount(value, field) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Ollama returned invalid ${field}`);
  }
  return value;
}

export class OllamaClient {
  constructor(options = {}) {
    const endpoint = validateLoopbackHttpUrl(
      options.endpoint,
      "LOCAL_LLM_ENDPOINT",
    );
    requireNonEmptyString(options.model, "LOCAL_LLM_MODEL");
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    requirePositiveInteger(timeoutMs, "timeoutMs");
    requirePositiveInteger(maxResponseBytes, "maxResponseBytes");

    this.endpoint = endpoint;
    this.model = options.model;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async complete(prompt) {
    requireNonEmptyString(prompt, "prompt");
    const endpoint = new URL(this.endpoint);
    if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
    const url = new URL("chat/completions", endpoint);

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`Ollama request failed: ${boundedDetail(error?.message)}`);
    }

    const maximumBytes = response.ok
      ? this.maxResponseBytes
      : Math.min(this.maxResponseBytes, MAX_ERROR_BYTES);
    let raw;
    try {
      raw = await readBoundedText(response, maximumBytes);
    } catch (error) {
      throw new Error(`Ollama request failed (${response.status}): ${error.message}`);
    }

    let data;
    try {
      data = raw === "" ? {} : JSON.parse(raw);
    } catch {
      throw new Error(
        `Ollama request failed (${response.status}): invalid JSON response`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Ollama request failed (${response.status}): ${boundedDetail(data?.error?.message ?? data?.error)}`,
      );
    }

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new Error("Ollama returned an invalid chat completion");
    }
    return {
      text,
      inputTokens: normalizeTokenCount(
        data?.usage?.prompt_tokens,
        "prompt token count",
      ),
      outputTokens: normalizeTokenCount(
        data?.usage?.completion_tokens,
        "completion token count",
      ),
    };
  }
}
