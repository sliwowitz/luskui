import test from "node:test";
import assert from "node:assert/strict";

const originalBackend = process.env.CODEXUI_BACKEND;

test.afterEach(() => {
  if (originalBackend === undefined) {
    delete process.env.CODEXUI_BACKEND;
  } else {
    process.env.CODEXUI_BACKEND = originalBackend;
  }
});

test("getBackend selects the Codex adapter by default", async () => {
  delete process.env.CODEXUI_BACKEND;
  const { getBackend } = await import("../lib/backends/index.js");
  const backend = getBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });
  assert.equal(backend.name, "codex");
});

test("getBackend rejects unsupported backend ids", async () => {
  process.env.CODEXUI_BACKEND = "unsupported";
  const { getBackend } = await import("../lib/backends/index.js");
  assert.throws(() => {
    getBackend({
      workingDirectory: "/tmp",
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    });
  }, /Unsupported backend/);
});

test("getBackend selects the Claude adapter when configured", async () => {
  process.env.CODEXUI_BACKEND = "claude";
  const { getBackend } = await import("../lib/backends/index.js");
  const backend = getBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });
  assert.equal(backend.name, "claude");
});

test("Claude backend rejects runs without an API key", async () => {
  delete process.env.CODEXUI_CLAUDE_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_API_KEY;
  const { createClaudeBackend } = await import("../lib/backends/claude/index.js");
  const backend = createClaudeBackend({
    workingDirectory: "/tmp",
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });
  await assert.rejects(async () => backend.streamRun("hello"), /Missing Claude API key/);
});
