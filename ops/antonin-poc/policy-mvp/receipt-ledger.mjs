import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";

import { resolveExternalStateDirectory } from "./lease-store.mjs";

export const RECEIPT_SCHEMA_VERSION = "antonin-receipt-v0";

const RECEIPT_FIELDS = new Set([
  "task_id",
  "task_version",
  "policy_version",
  "route",
  "reviewer",
  "lease_id",
  "fencing_token",
  "input_hash",
  "output_hash",
  "token_usage",
  "outcome",
]);

const DEFAULT_COST_TAIL_BYTES = 262_144;
const DEFAULT_COST_SAMPLES = 200;

const STORED_FIELDS = new Set([
  ...RECEIPT_FIELDS,
  "schema_version",
  "timestamp",
  "previous_hash",
  "record_hash",
]);

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeFieldName(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toLowerCase();
}

function assertNoSensitiveFields(value, parentField = null) {
  if (Array.isArray(value)) {
    value.forEach((nested) => assertNoSensitiveFields(nested, parentField));
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizeFieldName(key);
    if (
      ((normalized === "input" || normalized === "output") &&
        parentField !== "token_usage") ||
      normalized === "secret" ||
      normalized === "authorization" ||
      normalized === "subscription_credentials" ||
      normalized === "api_key" ||
      normalized.endsWith("_api_key")
    ) {
      throw new TypeError(`unsupported or sensitive receipt field: ${key}`);
    }
    assertNoSensitiveFields(nested, normalized);
  }
}

function assertExactFields(record, allowedFields) {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string" || !allowedFields.has(key)) {
      throw new TypeError(`unsupported or sensitive receipt field: ${String(key)}`);
    }
  }
}

function assertBoundedString(value, field, maximumLength) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    throw new TypeError(`invalid receipt field: ${field}`);
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`invalid receipt field: ${field}`);
  }
}

function assertSha256(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`invalid receipt field: ${field}`);
  }
}

function assertReceiptValues(receipt) {
  assertBoundedString(receipt.task_id, "task_id", 256);
  if (receipt.task_version !== null) {
    assertNonNegativeInteger(receipt.task_version, "task_version");
  }
  assertBoundedString(receipt.policy_version, "policy_version", 128);
  assertBoundedString(receipt.route, "route", 512);
  assertBoundedString(receipt.reviewer, "reviewer", 512);
  assertBoundedString(receipt.lease_id, "lease_id", 512);
  assertNonNegativeInteger(receipt.fencing_token, "fencing_token");
  if (receipt.fencing_token === 0) {
    throw new TypeError("invalid receipt field: fencing_token");
  }
  assertSha256(receipt.input_hash, "input_hash");
  assertSha256(receipt.output_hash, "output_hash");
  if (
    receipt.token_usage === null ||
    typeof receipt.token_usage !== "object" ||
    Array.isArray(receipt.token_usage)
  ) {
    throw new TypeError("invalid receipt field: token_usage");
  }
  assertExactFields(receipt.token_usage, new Set(["input", "output"]));
  if (
    !Object.hasOwn(receipt.token_usage, "input") ||
    !Object.hasOwn(receipt.token_usage, "output")
  ) {
    throw new TypeError("invalid receipt field: token_usage");
  }
  assertNonNegativeInteger(receipt.token_usage.input, "token_usage.input");
  assertNonNegativeInteger(receipt.token_usage.output, "token_usage.output");
  assertBoundedString(receipt.outcome, "outcome", 128);
}

function assertReceiptInput(receipt) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("receipt must be an object");
  }
  assertExactFields(receipt, RECEIPT_FIELDS);
  assertNoSensitiveFields(receipt);
  for (const field of RECEIPT_FIELDS) {
    if (!Object.hasOwn(receipt, field)) {
      throw new TypeError(`receipt is missing required field: ${field}`);
    }
  }
  assertReceiptValues(receipt);
}

function assertStoredRecord(record, lineNumber) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`invalid receipt at line ${lineNumber}`);
  }
  assertExactFields(record, STORED_FIELDS);
  assertNoSensitiveFields(record);
  for (const field of STORED_FIELDS) {
    if (!Object.hasOwn(record, field)) {
      throw new Error(`missing ${field} at line ${lineNumber}`);
    }
  }
  if (record.schema_version !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`unsupported schema version at line ${lineNumber}`);
  }
  assertBoundedString(record.timestamp, "timestamp", 64);
  if (record.previous_hash !== null) {
    assertSha256(record.previous_hash, "previous_hash");
  }
  assertSha256(record.record_hash, "record_hash");
  assertReceiptValues(
    Object.fromEntries(
      [...RECEIPT_FIELDS].map((field) => [field, record[field]]),
    ),
  );
}

export class ReceiptLedger {
  constructor(stateDirectory, options = {}) {
    this.stateDirectory = resolveExternalStateDirectory(stateDirectory, options);
    this.filePath = path.join(this.stateDirectory, "receipts.jsonl");
    this.lockPath = path.join(this.stateDirectory, ".receipts.lock");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.lockRetryMs = options.lockRetryMs ?? 10;
    this.lockMaxAttempts = options.lockMaxAttempts ?? 50;
  }

  async append(receipt) {
    assertReceiptInput(receipt);

    return this.#withLock(async () => {
      const records = await this.#readAndVerify();
      const previousHash = records.at(-1)?.record_hash ?? null;
      const withoutRecordHash = {
        schema_version: RECEIPT_SCHEMA_VERSION,
        timestamp: new Date(this.now()).toISOString(),
        ...receipt,
        previous_hash: previousHash,
      };
      const record = JSON.parse(
        canonicalJson({
          ...withoutRecordHash,
          record_hash: sha256(canonicalJson(withoutRecordHash)),
        }),
      );

      await this.#appendRecord(record);
      return record;
    });
  }

  /**
   * §2.7 the cost estimator reads the evidence we already have. It is
   * deliberately tolerant and bounded: it reads only the tail of the ledger,
   * skips anything it cannot parse, and never verifies the chain, because a
   * routing hint must not be able to fail an execution. Failure receipts are
   * excluded — they measure a crash, not a route.
   */
  async recentSuccessCosts(route, options = {}) {
    const maximumBytes = options.maximumBytes ?? DEFAULT_COST_TAIL_BYTES;
    const maximumSamples = options.maximumSamples ?? DEFAULT_COST_SAMPLES;
    let handle;
    try {
      handle = await open(this.filePath, "r");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    let text;
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, maximumBytes);
      const position = size - length;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      text = buffer.toString("utf8");
      if (position > 0) {
        // The byte window may start mid-record; that partial line is dropped.
        text = text.slice(text.indexOf("\n") + 1);
      }
    } finally {
      await handle.close();
    }

    const costs = [];
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.outcome !== "success" || record.route !== route) continue;
      const input = record.token_usage?.input;
      const output = record.token_usage?.output;
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) {
        continue;
      }
      costs.push(input + output);
    }
    return costs.slice(-maximumSamples);
  }

  async verify() {
    const records = await this.#readAndVerify();
    return {
      valid: true,
      records: records.length,
      lastHash: records.at(-1)?.record_hash ?? null,
    };
  }

  async #readAndVerify() {
    let contents;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    if (contents === "") {
      return [];
    }

    const lines = contents.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }

    const records = [];
    let previousHash = null;
    for (let index = 0; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      let record;
      try {
        record = JSON.parse(lines[index]);
      } catch {
        throw new Error(`malformed JSON at line ${lineNumber}`);
      }

      assertStoredRecord(record, lineNumber);
      if (record.previous_hash !== previousHash) {
        throw new Error(`previous hash mismatch at line ${lineNumber}`);
      }
      const { record_hash: recordHash, ...withoutRecordHash } = record;
      const expectedHash = sha256(canonicalJson(withoutRecordHash));
      if (recordHash !== expectedHash) {
        throw new Error(`record hash mismatch at line ${lineNumber}`);
      }

      records.push(record);
      previousHash = recordHash;
    }
    return records;
  }

  async #withLock(operation) {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });

    let acquired = false;
    for (let attempt = 1; attempt <= this.lockMaxAttempts; attempt += 1) {
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        if (attempt === this.lockMaxAttempts) {
          throw new Error("receipt ledger lock is unavailable");
        }
        await this.sleep(this.lockRetryMs);
      }
    }

    if (!acquired) {
      throw new Error("receipt ledger lock is unavailable");
    }

    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async #appendRecord(record) {
    await appendFile(this.filePath, `${canonicalJson(record)}\n`, {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    });
    await chmod(this.filePath, 0o600);
  }
}
