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
