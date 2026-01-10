import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const REPO_ROOT: string = process.env.REPO_ROOT || "/workspace";
export const HOST: string = process.env.HOST || "0.0.0.0";
export const PORT: number = Number(process.env.PORT || 7860);
export const REPO_ROOT_ABS = path.resolve(REPO_ROOT);
export const LOG_PATH = process.env.CODEXUI_LOG || path.join("/var/log", "codexui.log");

const HOME_DIR = os.homedir?.() ?? process.env.HOME ?? "";
export const CODEX_CONFIG_PATH =
  process.env.CODEX_CONFIG || path.join(HOME_DIR, ".codex", "config.toml");
export const CODEX_AUTH_PATH = process.env.CODEX_AUTH || path.join(HOME_DIR, ".codex", "auth.json");

function readConfigValue(regex: RegExp): string | null {
  try {
    if (!CODEX_CONFIG_PATH) return null;
    const contents = fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
    const match = contents.match(regex);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

const DEFAULT_MODEL_FROM_CONFIG = readConfigValue(/^\s*model\s*=\s*"([^"]+)"/m);
const DEFAULT_EFFORT_FROM_CONFIG = readConfigValue(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);

export const DEFAULT_MODEL: string | null =
  process.env.CODEXUI_MODEL || DEFAULT_MODEL_FROM_CONFIG || null;
export const EFFORT_OPTIONS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof EFFORT_OPTIONS)[number];

function normalizeEffort(value: string | null | undefined): ReasoningEffort | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return (EFFORT_OPTIONS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : null;
}

export const DEFAULT_EFFORT: ReasoningEffort | null = normalizeEffort(
  process.env.CODEXUI_EFFORT || DEFAULT_EFFORT_FROM_CONFIG
);
export const MODEL_CACHE_TTL_MS = Number(process.env.CODEXUI_MODEL_CACHE_MS || 5 * 60 * 1000);

export const SKIP_GIT_REPO_CHECK =
  process.env.CODEXUI_SKIP_GIT_CHECK === "1" || !fs.existsSync(path.join(REPO_ROOT_ABS, ".git"));

export function resolveRepoPath(relPath: string = ""): { abs: string; rel: string } {
  const normalized = typeof relPath === "string" ? relPath.replace(/^[/\\]+/, "") : "";
  const abs = path.resolve(REPO_ROOT_ABS, normalized || ".");
  const relative = path.relative(REPO_ROOT_ABS, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes repository");
  }
  return {
    abs,
    rel: relative === "" ? "" : relative.replace(/\\/g, "/")
  };
}
