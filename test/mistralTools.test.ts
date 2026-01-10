import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Set up a temporary test directory
const testRepoRoot = path.join(__dirname, "..", "test-tmp-repo");

test.before(() => {
  process.env.REPO_ROOT = testRepoRoot;
  if (fs.existsSync(testRepoRoot)) {
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(testRepoRoot, { recursive: true });
});

test.after(() => {
  if (fs.existsSync(testRepoRoot)) {
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
  }
  delete process.env.REPO_ROOT;
});

test("getMistralToolDefinitions returns all tool definitions", async () => {
  const { getMistralToolDefinitions } = await import("../lib/backends/mistral/tools.js");
  const tools = getMistralToolDefinitions();

  assert.equal(tools.length, 4);
  assert.ok(tools.some((t) => t.function.name === "filesystem.read"));
  assert.ok(tools.some((t) => t.function.name === "filesystem.write"));
  assert.ok(tools.some((t) => t.function.name === "filesystem.list"));
  assert.ok(tools.some((t) => t.function.name === "shell"));

  // Verify structure
  tools.forEach((tool) => {
    assert.equal(tool.type, "function");
    assert.ok(tool.function.name);
    assert.ok(tool.function.description);
    assert.ok(tool.function.parameters);
  });
});

test("executeMistralTool - filesystem.read succeeds with valid file", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const testFile = path.join(testRepoRoot, "test-read.txt");
  const content = "Hello, world!";
  fs.writeFileSync(testFile, content);

  const result = await executeMistralTool(
    "filesystem.read",
    JSON.stringify({ path: "test-read.txt" }),
    {
      workingDirectory: testRepoRoot,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, content);
  assert.equal(result.stderr, "");
  assert.ok(result.result.includes(content));
  assert.ok(result.result.includes('"ok":true'));
});

test("executeMistralTool - filesystem.read fails with missing file", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool(
    "filesystem.read",
    JSON.stringify({ path: "nonexistent.txt" }),
    {
      workingDirectory: testRepoRoot,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    }
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.length > 0);
  assert.ok(result.result.includes('"ok":false'));
});

test("executeMistralTool - filesystem.read fails with missing path argument", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool("filesystem.read", JSON.stringify({}), {
    workingDirectory: testRepoRoot,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("Missing path argument"));
});

test("executeMistralTool - filesystem.write creates file successfully", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const testFile = "test-write.txt";
  const content = "Written content";

  const result = await executeMistralTool(
    "filesystem.write",
    JSON.stringify({ path: testFile, content }),
    {
      workingDirectory: testRepoRoot,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    }
  );

  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("Wrote"));
  assert.equal(result.stderr, "");
  assert.ok(result.result.includes('"ok":true'));

  const writtenContent = fs.readFileSync(path.join(testRepoRoot, testFile), "utf8");
  assert.equal(writtenContent, content);
});

test("executeMistralTool - filesystem.write creates nested directories", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const testFile = "nested/dir/test.txt";
  const content = "Nested content";

  const result = await executeMistralTool(
    "filesystem.write",
    JSON.stringify({ path: testFile, content }),
    {
      workingDirectory: testRepoRoot,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    }
  );

  assert.equal(result.exitCode, 0);
  assert.ok(fs.existsSync(path.join(testRepoRoot, testFile)));

  const writtenContent = fs.readFileSync(path.join(testRepoRoot, testFile), "utf8");
  assert.equal(writtenContent, content);
});

test("executeMistralTool - filesystem.write fails with missing path argument", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool("filesystem.write", JSON.stringify({ content: "test" }), {
    workingDirectory: testRepoRoot,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("Missing path argument"));
});

test("executeMistralTool - filesystem.list lists directory contents", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  // Create test directory structure
  const testDir = path.join(testRepoRoot, "list-test");
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, "file1.txt"), "content1");
  fs.writeFileSync(path.join(testDir, "file2.txt"), "content2");
  fs.mkdirSync(path.join(testDir, "subdir"));

  const result = await executeMistralTool(
    "filesystem.list",
    JSON.stringify({ path: "list-test" }),
    {
      workingDirectory: testRepoRoot,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    }
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.ok(result.result.includes('"ok":true'));

  const parsed = JSON.parse(result.result);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 3);

  const fileNames = parsed.entries.map((e: { name: string }) => e.name).sort();
  assert.deepEqual(fileNames, ["file1.txt", "file2.txt", "subdir"]);

  const subdirEntry = parsed.entries.find((e: { name: string }) => e.name === "subdir");
  assert.equal(subdirEntry.dir, true);

  const fileEntry = parsed.entries.find((e: { name: string }) => e.name === "file1.txt");
  assert.equal(fileEntry.dir, false);
});

test("executeMistralTool - filesystem.list fails with missing directory", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool(
    "filesystem.list",
    JSON.stringify({ path: "nonexistent-dir" }),
    {
      workingDirectory: testRepoRoot,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    }
  );

  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.length > 0);
  assert.ok(result.result.includes('"ok":false'));
});

test("executeMistralTool - shell executes command successfully", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool(
    "shell",
    JSON.stringify({ command: "echo 'Hello from shell'" }),
    {
      workingDirectory: testRepoRoot,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    }
  );

  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("Hello from shell"));
  assert.equal(result.stderr, "");
  assert.ok(result.result.includes('"ok":true'));
});

test("executeMistralTool - shell handles command failure", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool("shell", JSON.stringify({ command: "exit 42" }), {
    workingDirectory: testRepoRoot,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });

  assert.equal(result.exitCode, 42);
  assert.ok(result.result.includes('"ok":false'));
  assert.ok(result.result.includes('"exitCode":42'));
});

test("executeMistralTool - shell fails with missing command argument", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool("shell", JSON.stringify({ command: "" }), {
    workingDirectory: testRepoRoot,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("Missing command argument"));
});

test("executeMistralTool - shell handles stderr output", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool(
    "shell",
    JSON.stringify({ command: "echo 'error message' >&2" }),
    {
      workingDirectory: testRepoRoot,
      skipGitRepoCheck: true,
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      approvalPolicy: "never"
    }
  );

  assert.equal(result.exitCode, 0);
  assert.ok(result.stderr.includes("error message"));
});

test("executeMistralTool - rejects invalid tool arguments", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool("filesystem.read", "invalid json{", {
    workingDirectory: testRepoRoot,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("Invalid tool arguments"));
});

test("executeMistralTool - rejects unknown tool", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  const result = await executeMistralTool("unknown.tool", JSON.stringify({ arg: "value" }), {
    workingDirectory: testRepoRoot,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });

  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("Unknown tool"));
});

test("executeMistralTool - shell works with raw string arguments", async () => {
  const { executeMistralTool } = await import("../lib/backends/mistral/tools.js");

  // Shell tool should accept raw string when not valid JSON
  const result = await executeMistralTool("shell", "echo test", {
    workingDirectory: testRepoRoot,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    networkAccessEnabled: true,
    approvalPolicy: "never"
  });

  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes("test"));
});
