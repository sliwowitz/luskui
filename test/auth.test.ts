import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authModuleHref = pathToFileURL(path.join(__dirname, "..", "lib", "auth.js")).href;

type AuthModule = typeof import("../lib/auth.js");
type EnvKey = "OPENAI_API_KEY" | "CODEX_API_KEY" | "CODEX_AUTH";

const trackedEnvKeys: EnvKey[] = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_AUTH"];
const originalEnv: Record<EnvKey, string | undefined> = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]])
) as Record<EnvKey, string | undefined>;
const originalReadFileSync = fs.readFileSync;

test.afterEach(() => {
  for (const key of trackedEnvKeys) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  fs.readFileSync = originalReadFileSync;
});

async function loadAuthModule({
  openaiKey,
  codexKey,
  authPath
}: Record<string, unknown> = {}): Promise<AuthModule> {
  applyEnv("OPENAI_API_KEY", openaiKey as string | null | undefined);
  applyEnv("CODEX_API_KEY", codexKey as string | null | undefined);
  applyEnv("CODEX_AUTH", authPath as string | null | undefined);
  const href = `${authModuleHref}?t=${randomUUID()}`;
  return import(href);
}

function applyEnv(key: EnvKey, value: string | null | undefined): void {
  if (value === undefined || value === null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function mockAuthFile(contents: string): void {
  fs.readFileSync = (() => contents) as unknown as typeof fs.readFileSync;
}

function mockAuthFileFailure(message = "missing auth file"): void {
  fs.readFileSync = (() => {
    throw new Error(message);
  }) as unknown as typeof fs.readFileSync;
}

test("prefer OPENAI_API_KEY over other sources", async () => {
  const { getAccessToken } = await loadAuthModule({
    openaiKey: "env-openai",
    codexKey: "env-codex",
    authPath: "/tmp/ignored"
  });
  assert.equal(getAccessToken(), "env-openai");
});

test("fall back to CODEX_API_KEY when OPENAI_API_KEY is missing", async () => {
  const { getAccessToken } = await loadAuthModule({
    openaiKey: null,
    codexKey: "env-codex",
    authPath: "/tmp/ignored"
  });
  assert.equal(getAccessToken(), "env-codex");
});

test("read tokens from auth file when environment variables are absent", async () => {
  const { getAccessToken } = await loadAuthModule({
    openaiKey: null,
    codexKey: null,
    authPath: "/tmp/ignored"
  });
  mockAuthFile(JSON.stringify({ tokens: { access_token: "file-token" } }));
  assert.equal(getAccessToken(), "file-token");
});

test("return null when the auth file cannot be read", async () => {
  const { getAccessToken } = await loadAuthModule({
    openaiKey: null,
    codexKey: null,
    authPath: "/tmp/ignored"
  });
  mockAuthFileFailure();
  assert.equal(getAccessToken(), null);
});

test("return null when the auth file contains invalid JSON", async () => {
  const { getAccessToken } = await loadAuthModule({
    openaiKey: null,
    codexKey: null,
    authPath: "/tmp/ignored"
  });
  mockAuthFile("{invalid");
  assert.equal(getAccessToken(), null);
});
