import test from "node:test";
import assert from "node:assert/strict";
import {
  appendCommandLog,
  clearRun,
  createRun,
  getCommands,
  getLastDiff,
  getRun,
  setLastDiff
} from "../lib/runStore.js";

test("createRun stores prompt and initializes run state", () => {
  const runId = createRun("hello world");
  const stored = getRun(runId);

  assert.ok(runId, "runId should be truthy");
  assert.ok(stored, "run should exist immediately after creation");
  assert.equal(stored.prompt, "hello world");
  assert.equal(getLastDiff(runId), null);
  assert.deepEqual(getCommands(runId), []);

  clearRun(runId);
});

test("run mutation helpers update diff and command log", () => {
  const runId = createRun("mutations");

  setLastDiff(runId, "--- a\n+++ b");
  appendCommandLog(runId, "pwd");
  appendCommandLog(runId, "ls");

  assert.equal(getLastDiff(runId), "--- a\n+++ b");
  assert.deepEqual(getCommands(runId), ["pwd", "ls"]);

  clearRun(runId);
});

test("clearRun removes existing entries", () => {
  const runId = createRun("cleanup");
  clearRun(runId);

  assert.equal(getRun(runId), null);
  assert.deepEqual(getCommands(runId), []);
  assert.equal(getLastDiff(runId), null);
});
