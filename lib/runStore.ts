/**
 * In-memory run state management.
 *
 * Stores active run data keyed by UUID. Each run tracks:
 * - The original prompt (for backend execution)
 * - The last diff patch (for the Apply button)
 * - Command execution logs (for the terminal panel)
 *
 * DESIGN NOTES:
 * - In-memory storage is intentional: containers are ephemeral and runs
 *   don't need persistence across restarts.
 * - No cleanup/expiration: short-lived container sessions don't accumulate
 *   enough runs to matter. If needed, LRU eviction could be added.
 * - Thread-safe for single-process Node.js (no concurrent writes).
 */
import crypto from "node:crypto";

interface RunEntry {
  prompt: string;
  lastDiff: string | null;
  commands: string[];
}

/** Map of run ID -> run state. Not persisted across restarts. */
const runs = new Map<string, RunEntry>();

/**
 * Create a new run with the given prompt.
 * @returns UUID for the run, used for streaming and state access
 */
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
