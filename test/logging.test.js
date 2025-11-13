import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const loggingModuleHref = pathToFileURL(path.join(__dirname, "..", "lib", "logging.js")).href;

const originalCreateWriteStream = fs.createWriteStream;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

test.afterEach(() => {
  fs.createWriteStream = originalCreateWriteStream;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

async function loadLoggingModule() {
  const href = `${loggingModuleHref}?t=${randomUUID()}`;
  return import(href);
}

test("logRun writes serialized entries to the log stream and console", async () => {
  const writes = [];
  fs.createWriteStream = () => ({
    write(chunk) {
      writes.push(chunk);
      return true;
    }
  });

  const messages = [];
  console.log = (message) => {
    messages.push(String(message));
  };

  const { logRun } = await loadLoggingModule();

  // drop the initialization message logged during module evaluation
  messages.length = 0;

  logRun("abc123", "Applied diff", { files: 2 });

  assert.equal(writes.length, 1, "log stream should receive exactly one write call");
  assert.match(
    writes[0],
    /^\[.*\] \[run abc123\] Applied diff — {"files":2}\n$/,
    "log stream write should include structured payload with newline"
  );
  assert.equal(messages.length, 1, "console logger should mirror each entry");
  assert.match(messages[0], /^\[.*\] \[run abc123\] Applied diff/, "console output should include the timestamp, run id and message");
});

test("logRun falls back to console-only logging when the log file cannot be opened", async () => {
  fs.createWriteStream = () => {
    throw new Error("permission denied");
  };

  const errors = [];
  console.error = (message) => {
    errors.push(String(message));
  };

  const messages = [];
  console.log = (message) => {
    messages.push(String(message));
  };

  const { logRun } = await loadLoggingModule();

  assert.ok(errors.length >= 1, "initialization failure should be reported via console.error");

  logRun("fallback", "capture output", undefined);

  assert.equal(messages.length, 1, "logRun should still emit console output without a file stream");
  assert.match(messages[0], /^\[.*\] \[run fallback\] capture output/, "fallback console line should match normal format");
});
