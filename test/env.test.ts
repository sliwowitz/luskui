import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envModuleHref = pathToFileURL(path.join(__dirname, "..", "lib", "env.js")).href;

type EnvModule = typeof import("../lib/env.js");

const trackedEnvKeys = [
  "HOME",
  "VIBE_CONFIG_DIR",
  "MISTRAL_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "EXTRA_ENV"
] as const;
type EnvKey = (typeof trackedEnvKeys)[number];

const originalEnv: Record<EnvKey, string | undefined> = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]])
) as Record<EnvKey, string | undefined>;

const originalWarn = console.warn;

test.afterEach(() => {
  for (const key of trackedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  console.warn = originalWarn;
});

async function loadEnvModule(): Promise<EnvModule> {
  const href = `${envModuleHref}?t=${randomUUID()}`;
  return import(href);
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codexui-env-"));
}

test("parseEnv handles comments, export statements, multiline values, and escapes", async () => {
  const { parseEnv } = await loadEnvModule();
  const parsed = parseEnv(
    [
      "# comment",
      "export FOO=bar",
      "MULTI=line one",
      "line two",
      String.raw`QUOTED="my\\\"secret\\\"key"`,
      "TRAILING="
    ].join("\n")
  );

  assert.equal(parsed.FOO, "bar");
  assert.equal(parsed.MULTI, "line one\nline two");
  assert.equal(parsed.QUOTED, 'my"secret"key');
  assert.equal(parsed.TRAILING, "");
});

test("hydrateEnv loads .env values without overwriting existing variables", async () => {
  const tempDir = makeTempDir();
  const envDir = path.join(tempDir, "vibe");
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(
    path.join(envDir, ".env"),
    ["MISTRAL_API_KEY=file-key", "EXTRA_ENV=from-file"].join("\n"),
    "utf8"
  );

  process.env.VIBE_CONFIG_DIR = envDir;
  process.env.MISTRAL_API_KEY = "existing-key";

  const { hydrateEnv } = await loadEnvModule();
  hydrateEnv();

  assert.equal(process.env.MISTRAL_API_KEY, "existing-key");
  assert.equal(process.env.EXTRA_ENV, "from-file");
});

test("hydrateEnv reads Claude access tokens from credentials JSON", async () => {
  const tempDir = makeTempDir();
  const homeDir = path.join(tempDir, "home");
  const claudeDir = path.join(homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "oauth-token" } }),
    "utf8"
  );

  process.env.HOME = homeDir;

  const { hydrateEnv } = await loadEnvModule();
  hydrateEnv();

  assert.equal(process.env.ANTHROPIC_API_KEY, "oauth-token");
  assert.equal(process.env.CLAUDE_API_KEY, "oauth-token");
});

test("hydrateEnv is idempotent", async () => {
  const tempDir = makeTempDir();
  const envDir = path.join(tempDir, "vibe");
  fs.mkdirSync(envDir, { recursive: true });
  const envPath = path.join(envDir, ".env");
  fs.writeFileSync(envPath, "EXTRA_ENV=first", "utf8");

  process.env.VIBE_CONFIG_DIR = envDir;

  const { hydrateEnv } = await loadEnvModule();
  hydrateEnv();

  fs.writeFileSync(envPath, "EXTRA_ENV=second", "utf8");
  hydrateEnv();

  assert.equal(process.env.EXTRA_ENV, "first");
});

test("hydrateEnv logs failures when credential files are malformed", async () => {
  const tempDir = makeTempDir();
  const homeDir = path.join(tempDir, "home");
  const claudeDir = path.join(homeDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, ".credentials.json"), "{invalid", "utf8");

  process.env.HOME = homeDir;
  let warned = false;
  console.warn = () => {
    warned = true;
  };

  const { hydrateEnv } = await loadEnvModule();
  hydrateEnv();

  assert.equal(warned, true);
});
