import crypto from "node:crypto";

const runs = new Map();

export function createRun(prompt) {
  const runId = crypto.randomUUID();
  runs.set(runId, { prompt, lastDiff: null, commands: [] });
  return runId;
}

export function getRun(id) {
  return runs.get(id) || null;
}

export function setLastDiff(id, patch) {
  const entry = runs.get(id);
  if (entry) entry.lastDiff = patch;
}

export function appendCommandLog(id, text) {
  const entry = runs.get(id);
  if (entry) entry.commands.push(text);
}

export function getLastDiff(id) {
  return runs.get(id)?.lastDiff || null;
}

export function getCommands(id) {
  return runs.get(id)?.commands || [];
}

export function clearRun(id) {
  runs.delete(id);
}
