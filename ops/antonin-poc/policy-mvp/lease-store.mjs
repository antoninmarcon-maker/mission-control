import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function requirePositiveDuration(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number`);
  }
}

function emptyState() {
  return {
    version: STATE_VERSION,
    fencing_tokens: Object.create(null),
    leases: Object.create(null),
  };
}

function ownValue(object, key) {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

export class LeaseStore {
  constructor(stateDirectory, options = {}) {
    if (!path.isAbsolute(stateDirectory)) {
      throw new TypeError("lease state directory must be an absolute path");
    }
    if (path.resolve(stateDirectory) === path.parse(stateDirectory).root) {
      throw new TypeError("lease state directory cannot be the filesystem root");
    }

    this.stateDirectory = path.resolve(stateDirectory);
    this.filePath = path.join(this.stateDirectory, "leases.json");
    this.lockPath = path.join(this.stateDirectory, ".leases.lock");
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.lockRetryMs = options.lockRetryMs ?? 10;
    this.lockMaxAttempts = options.lockMaxAttempts ?? 50;
  }

  async acquire(taskId, owner, options = {}) {
    requireNonEmptyString(taskId, "taskId");
    requireNonEmptyString(owner, "owner");
    const ttlMs = options.ttlMs;
    requirePositiveDuration(ttlMs, "ttlMs");

    return this.#withLock(async () => {
      const state = await this.#readState();
      const now = this.now();
      const current = ownValue(state.leases, taskId);

      if (current && current.expires_at > now) {
        if (current.owner !== owner) {
          return null;
        }

        const renewed = {
          ...current,
          expires_at: now + ttlMs,
          task_version: options.taskVersion ?? current.task_version,
        };
        state.leases[taskId] = renewed;
        await this.#writeState(state);
        return renewed;
      }

      const previousToken =
        ownValue(state.fencing_tokens, taskId) ?? current?.fencing_token ?? 0;
      const lease = {
        task_id: taskId,
        owner,
        fencing_token: previousToken + 1,
        acquired_at: now,
        expires_at: now + ttlMs,
        task_version: options.taskVersion ?? null,
      };
      state.fencing_tokens[taskId] = lease.fencing_token;
      state.leases[taskId] = lease;
      await this.#writeState(state);
      return lease;
    });
  }

  async renew(taskId, owner, fencingToken, ttlMs) {
    requirePositiveDuration(ttlMs, "ttlMs");

    return this.#withLock(async () => {
      const state = await this.#readState();
      const current = ownValue(state.leases, taskId);
      const now = this.now();
      if (
        !current ||
        current.owner !== owner ||
        current.fencing_token !== fencingToken ||
        current.expires_at <= now
      ) {
        throw new Error(`lease is not current for task ${taskId}`);
      }

      const renewed = { ...current, expires_at: now + ttlMs };
      state.leases[taskId] = renewed;
      await this.#writeState(state);
      return renewed;
    });
  }

  async assertCurrent(taskId, owner, fencingToken) {
    const state = await this.#readState();
    const current = ownValue(state.leases, taskId);
    if (
      !current ||
      current.owner !== owner ||
      current.fencing_token !== fencingToken ||
      current.expires_at <= this.now()
    ) {
      throw new Error(`lease is not current for task ${taskId}`);
    }
    return current;
  }

  async release(taskId, owner, fencingToken) {
    return this.#withLock(async () => {
      const state = await this.#readState();
      const current = ownValue(state.leases, taskId);
      if (
        !current ||
        current.owner !== owner ||
        current.fencing_token !== fencingToken
      ) {
        return false;
      }

      delete state.leases[taskId];
      await this.#writeState(state);
      return true;
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
        if (error?.code !== "EEXIST") {
          throw error;
        }
        if (attempt === this.lockMaxAttempts) {
          throw new Error("lease state lock is unavailable");
        }
        await this.sleep(this.lockRetryMs);
      }
    }

    if (!acquired) {
      throw new Error("lease state lock is unavailable");
    }

    try {
      return await operation();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async #readState() {
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf8"));
      if (
        state?.version !== STATE_VERSION ||
        !state.fencing_tokens ||
        !state.leases
      ) {
        throw new Error("invalid lease state");
      }
      return state;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
  }

  async #writeState(state) {
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
