import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

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

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
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
  for (const key of Object.keys(record)) {
    if (!allowedFields.has(key)) {
      throw new TypeError(`unsupported or sensitive receipt field: ${key}`);
    }
  }
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
}

export class ReceiptLedger {
  constructor(stateDirectory, options = {}) {
    if (!path.isAbsolute(stateDirectory)) {
      throw new TypeError("receipt state directory must be an absolute path");
    }
    if (path.resolve(stateDirectory) === path.parse(stateDirectory).root) {
      throw new TypeError("receipt state directory cannot be the filesystem root");
    }

    this.stateDirectory = path.resolve(stateDirectory);
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

      records.push(record);
      await this.#writeRecords(records);
      return record;
    });
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

  async #writeRecords(records) {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const contents = `${records.map(canonicalJson).join("\n")}\n`;
    try {
      await writeFile(temporaryPath, contents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
      await chmod(this.filePath, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
