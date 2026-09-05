import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProposalCursorStore } from "../proposal-cursor-store.mjs";

async function temporaryPolicyState(t) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "antonin-policy-proposals-"));
  const repositoryRoot = path.join(sandbox, "repository");
  const runtimeDirectory = path.join(sandbox, "runtime");
  const stateDirectory = path.join(sandbox, "external", "policy-state");
  await Promise.all([
    mkdir(repositoryRoot),
    mkdir(runtimeDirectory),
    mkdir(path.dirname(stateDirectory)),
  ]);
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  return {
    stateDirectory,
    stateStoreOptions: { repositoryRoot, runtimeDirectory },
  };
}

test("proposal cursor writes a mode-600 replacement with the durable wire shape", async (t) => {
  const state = await temporaryPolicyState(t);
  const store = new ProposalCursorStore(
    state.stateDirectory,
    state.stateStoreOptions,
  );

  assert.deepEqual(await store.read(), { updatedAt: 0, id: 0 });
  await store.commit({ updatedAt: 1_788_560_000, id: 42 });
  const first = await stat(store.filePath);
  assert.equal(first.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(store.filePath, "utf8")), {
    schema_version: 1,
    updated_at: 1_788_560_000,
    id: 42,
  });

  await store.commit({ updatedAt: 1_788_560_001, id: 43 });
  const second = await stat(store.filePath);
  assert.notEqual(second.ino, first.ino);
  assert.equal(second.mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(state.stateDirectory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("proposal cursor fails closed on malformed persisted state", async (t) => {
  const state = await temporaryPolicyState(t);
  const store = new ProposalCursorStore(
    state.stateDirectory,
    state.stateStoreOptions,
  );
  await mkdir(state.stateDirectory, { recursive: true });
  await writeFile(store.filePath, "not-json", "utf8");

  await assert.rejects(store.read(), /invalid proposal cursor state/);
});

test("proposal cursor refuses lexicographically older commits", async (t) => {
  const state = await temporaryPolicyState(t);
  const store = new ProposalCursorStore(
    state.stateDirectory,
    state.stateStoreOptions,
  );
  await store.commit({ updatedAt: 1_788_560_000, id: 42 });

  await assert.rejects(
    store.commit({ updatedAt: 1_788_560_000, id: 41 }),
    /cannot move backward/,
  );
  await assert.rejects(
    store.commit({ updatedAt: 1_788_559_999, id: 999 }),
    /cannot move backward/,
  );
  assert.deepEqual(await store.read(), { updatedAt: 1_788_560_000, id: 42 });
});

test("proposal cursor rejects invalid lock attempt limits", async (t) => {
  const state = await temporaryPolicyState(t);

  for (const lockMaxAttempts of [0, Number.NaN, 1.5]) {
    assert.throws(
      () => new ProposalCursorStore(state.stateDirectory, {
        ...state.stateStoreOptions,
        lockMaxAttempts,
      }),
      /lockMaxAttempts must be a positive integer/,
    );
  }
});

test("proposal cursor never writes when its existing lock cannot be acquired", async (t) => {
  const state = await temporaryPolicyState(t);
  const store = new ProposalCursorStore(state.stateDirectory, {
    ...state.stateStoreOptions,
    lockMaxAttempts: 1,
  });
  await mkdir(state.stateDirectory, { recursive: true });
  await mkdir(store.lockPath);

  await assert.rejects(
    store.commit({ updatedAt: 1_788_560_000, id: 42 }),
    /proposal cursor lock is unavailable/,
  );
  await assert.rejects(stat(store.filePath), { code: "ENOENT" });
  assert.deepEqual(await readdir(state.stateDirectory), [".proposal-cursor.lock"]);
});
