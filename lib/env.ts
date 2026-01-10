import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let didHydrate = false;

type EnvMap = Record<string, string>;

function unescapeValue(value: string): string {
  return value
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

export function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? unescapeValue(parsed) : String(parsed);
    } catch {
      return unescapeValue(trimmed.slice(1, -1));
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return unescapeValue(trimmed.slice(1, -1));
  }
  return unescapeValue(trimmed);
}

export function parseEnv(contents: string): EnvMap {
  const env: EnvMap = {};
  let currentKey: string | null = null;
  let currentValue: string | null = null;

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      if (currentKey !== null) {
        env[currentKey] = stripQuotes(currentValue ?? "");
        currentKey = null;
        currentValue = null;
      }
      continue;
    }
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const equalsIndex = withoutExport.indexOf("=");

    if (equalsIndex <= 0) {
      if (currentKey !== null) {
        currentValue = `${currentValue ?? ""}\n${line}`;
      }
      continue;
    }

    if (currentKey !== null) {
      env[currentKey] = stripQuotes(currentValue ?? "");
      currentKey = null;
      currentValue = null;
    }

    const key = withoutExport.slice(0, equalsIndex).trim();
    const rawValue = withoutExport.slice(equalsIndex + 1);
    if (!key) continue;
    currentKey = key;
    currentValue = rawValue;
  }

  if (currentKey !== null) {
    env[currentKey] = stripQuotes(currentValue ?? "");
  }
  return env;
}

function setIfMissing(key: string, value: string | null | undefined): void {
  if (!value) return;
  if (process.env[key]) return;
  process.env[key] = value;
}

function logLoadError(context: string, error: unknown): void {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  console.warn(`[codexui] ${context}: ${message}`);
}

function loadEnvFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const contents = fs.readFileSync(filePath, "utf8");
    const parsed = parseEnv(contents);
    for (const [key, value] of Object.entries(parsed)) {
      setIfMissing(key, value);
    }
  } catch (error) {
    logLoadError(`Failed to read env file at ${filePath}`, error);
  }
}

function extractKeyFromObject(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  if ("claudeAiOauth" in record && typeof record.claudeAiOauth === "object") {
    return extractKeyFromObject(record.claudeAiOauth, ["accessToken", "access_token"]);
  }
  return null;
}

function loadClaudeCredentials(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const key = extractKeyFromObject(parsed, [
      "ANTHROPIC_API_KEY",
      "anthropic_api_key",
      "CLAUDE_API_KEY",
      "claude_api_key",
      "apiKey",
      "api_key"
    ]);
    if (!key) return;
    setIfMissing("ANTHROPIC_API_KEY", key);
    setIfMissing("CLAUDE_API_KEY", key);
  } catch (error) {
    logLoadError(`Failed to read Claude credentials at ${filePath}`, error);
  }
}

export function hydrateEnv(): void {
  if (didHydrate) return;
  didHydrate = true;
  const home = process.env.HOME || os.homedir?.() || "";
  // Default per-user configuration directory for vibe-based tooling.
  const vibeConfigDir = process.env.VIBE_CONFIG_DIR
    ? path.isAbsolute(process.env.VIBE_CONFIG_DIR)
      ? process.env.VIBE_CONFIG_DIR
      : home
        ? path.join(home, process.env.VIBE_CONFIG_DIR)
        : path.resolve(process.env.VIBE_CONFIG_DIR)
    : home
      ? path.join(home, ".vibe")
      : "";
  if (vibeConfigDir) loadEnvFile(path.join(vibeConfigDir, ".env"));
  if (home) {
    loadClaudeCredentials(path.join(home, ".claude", ".credentials.json"));
  }
}
