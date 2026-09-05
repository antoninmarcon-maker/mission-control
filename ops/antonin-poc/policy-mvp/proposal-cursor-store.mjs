import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveExternalStateDirectory } from "./lease-store.mjs";

const SCHEMA_VERSION = 1;

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertCursor(cursor) {
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new TypeError("proposal cursor must be an object");
  }
  for (const field of ["updatedAt", "id"]) {
    if (!Number.isSafeInteger(cursor[field]) || cursor[field] < 0) {
      throw new TypeError(`proposal cursor ${field} must be a non-negative safe integer`);
    }
  }
  return { updatedAt: cursor.updatedAt, id: cursor.id };
}

function isOlder(cursor, previous) {
  return (
    cursor.updatedAt < previous.updatedAt ||
    (cursor.updatedAt === previous.updatedAt && cursor.id < previous.id)
  );
}

export class ProposalCursorStore {
  constructor(stateDirectory, options = {}) {
    this.stateDirectory = resolveExternalStateDirectory(stateDirectory, options);
    this.filePath = path.join(this.stateDirectory, "proposal-cursor.json");
    this.lockPath = path.join(this.stateDirectory, ".proposal-cursor.lock");
    this.sleep = options.sleep ?? defaultSleep;
    this.lockRetryMs = options.lockRetryMs ?? 10;
    this.lockMaxAttempts = options.lockMaxAttempts ?? 50;
    requirePositiveInteger(this.lockMaxAttempts, "lockMaxAttempts");
  }

  async read() {
    return this.#readCursor();
  }

  async commit(cursor) {
    const next = assertCursor(cursor);
    return this.#withLock(async () => {
      const previous = await this.#readCursor();
      if (isOlder(next, previous)) {
        throw new Error("proposal cursor cannot move backward");
      }
      if (next.updatedAt === previous.updatedAt && next.id === previous.id) {
        return previous;
      }
      await this.#writeCursor(next);
      return next;
    });
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
        if (error?.code !== "EEXIST") throw error;
        if (attempt === this.lockMaxAttempts) {
          throw new Error("proposal cursor lock is unavailable");
        }
        await this.sleep(this.lockRetryMs);
      }
    }

    if (!acquired) {
      throw new Error("proposal cursor lock is unavailable");
    }

    try {
      return await operation();
    } finally {
      if (acquired) await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async #readCursor() {
    let state;
    try {
      state = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return { updatedAt: 0, id: 0 };
      throw new Error("invalid proposal cursor state");
    }

    if (
      state === null ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      Object.keys(state).length !== 3 ||
      state.schema_version !== SCHEMA_VERSION ||
      !Number.isSafeInteger(state.updated_at) ||
      state.updated_at < 0 ||
      !Number.isSafeInteger(state.id) ||
      state.id < 0
    ) {
      throw new Error("invalid proposal cursor state");
    }
    return { updatedAt: state.updated_at, id: state.id };
  }

  async #writeCursor(cursor) {
    const state = {
      schema_version: SCHEMA_VERSION,
      updated_at: cursor.updatedAt,
      id: cursor.id,
    };
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
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
