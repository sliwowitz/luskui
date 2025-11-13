import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

type AuthModule = typeof import("../lib/auth.ts");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const authModuleHref = pathToFileURL(path.join(__dirname, "..", "lib", "auth.ts")).href;

const trackedEnvKeys = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_AUTH"] as const;
const originalEnv: Record<(typeof trackedEnvKeys)[number], string | undefined> = Object.fromEntries(
  trackedEnvKeys.map((key) => [key, process.env[key]])
) as Record<(typeof trackedEnvKeys)[number], string | undefined>;
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

async function loadAuthModule({ openaiKey, codexKey, authPath }: LoadAuthModuleOptions = {}): Promise<AuthModule> {
  applyEnv("OPENAI_API_KEY", openaiKey);
  applyEnv("CODEX_API_KEY", codexKey);
  applyEnv("CODEX_AUTH", authPath);
  const href = `${authModuleHref}?t=${randomUUID()}`;
  return import(href) as Promise<AuthModule>;
}

interface LoadAuthModuleOptions {
  openaiKey?: string | null;
  codexKey?: string | null;
  authPath?: string | null;
}

function applyEnv(key: (typeof trackedEnvKeys)[number], value: string | null | undefined): void {
  if (value === undefined || value === null) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function mockAuthFile(contents: string): void {
  fs.readFileSync = ((..._args: Parameters<typeof fs.readFileSync>) => contents) as typeof fs.readFileSync;
}

function mockAuthFileFailure(message = "missing auth file"): void {
  fs.readFileSync = ((..._args: Parameters<typeof fs.readFileSync>) => {
    throw new Error(message);
  }) as typeof fs.readFileSync;
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
