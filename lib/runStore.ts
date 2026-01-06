import crypto from 'node:crypto';

export interface RunEntry {
  prompt: string;
  lastDiff: string | null;
  commands: string[];
}

const runs = new Map<string, RunEntry>();

export function createRun(prompt: string): string {
  const runId = crypto.randomUUID();
  runs.set(runId, { prompt, lastDiff: null, commands: [] });
  return runId;
}

export function getRun(id: string): RunEntry | null {
  return runs.get(id) || null;
}

export function setLastDiff(id: string, patch: string): void {
  const entry = runs.get(id);
  if (entry) entry.lastDiff = patch;
}

export function appendCommandLog(id: string, text: string): void {
  const entry = runs.get(id);
  if (entry) entry.commands.push(text);
}

export function getLastDiff(id: string): string | null {
  return runs.get(id)?.lastDiff || null;
}

export function getCommands(id: string): string[] {
  return runs.get(id)?.commands || [];
}

export function clearRun(id: string): void {
  runs.delete(id);
}
