import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let didHydrate = false;

type EnvMap = Record<string, string>;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnv(contents: string): EnvMap {
  const env: EnvMap = {};
  let currentKey: string | null = null;
  let currentValue: string | null = null;

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    // Blank or comment line: finalize any pending multiline value and skip
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

    // Line without '=', treat as continuation of previous value if any
    if (equalsIndex <= 0) {
      if (currentKey !== null) {
        currentValue = (currentValue ?? "") + "\n" + line;
      }
      continue;
    }

    // New assignment: flush any previous pending key/value
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

  // Flush any trailing multiline value at EOF
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

function loadEnvFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const contents = fs.readFileSync(filePath, "utf8");
    const parsed = parseEnv(contents);
    for (const [key, value] of Object.entries(parsed)) {
      setIfMissing(key, value);
    }
  } catch {
    // ignore missing or invalid env files
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
  const nested = record.credentials ?? record.auth ?? record.account;
  if (nested && typeof nested === "object") {
    return extractKeyFromObject(nested, keys);
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
      "api_key",
      "token",
      "access_token"
    ]);
    if (!key) return;
    setIfMissing("ANTHROPIC_API_KEY", key);
    setIfMissing("CLAUDE_API_KEY", key);
  } catch {
    // ignore missing or invalid credentials file
  }
}

export function hydrateEnv(): void {
  if (didHydrate) return;
  didHydrate = true;
  const home = os.homedir?.() ?? process.env.HOME ?? "";
  if (!home) return;
  // Default per-user configuration directory for this tool. Can be overridden
  // by setting VIBE_CONFIG_DIR to a custom path (absolute or relative).
  const vibeConfigDir = process.env.VIBE_CONFIG_DIR || path.join(home, ".vibe");
  loadEnvFile(path.join(vibeConfigDir, ".env"));
  loadClaudeCredentials(path.join(home, ".claude", ".credentials.json"));
}
