import fs from "node:fs";

import { LOG_PATH } from "./config.js";

let logStream;
try {
  logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  console.log(`Logging Codex UI activity to ${LOG_PATH}`);
} catch (error) {
  console.error("Failed to open log file, falling back to console only", error);
  logStream = null;
}

function serializeLogData(data) {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function logRun(id, message, data) {
  const ts = new Date().toISOString();
  const serialized = serializeLogData(data);
  const line = `[${ts}] [run ${id}] ${message}${serialized ? ` — ${serialized}` : ""}`;
  console.log(line);
  logStream?.write(line + "\n");
}
