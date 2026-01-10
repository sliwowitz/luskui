import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REPO_ROOT_ABS } from "./config.js";

// High-level: read a minimal subset of Vibe CLI config for the UI.
// We intentionally parse only the fields the UI needs and keep the parser lightweight.

export type VibeConfig = {
  active_model?: string;
  providers?: Record<string, unknown>;
  models?: string[];
  enabled_tools?: string[];
  disabled_tools?: string[];
  tools?: Record<string, { permissions?: unknown }>;
};

let cachedConfig: VibeConfig | null | undefined;

export function clearVibeConfigCache(): void {
  cachedConfig = undefined;
}

function findVibeConfigPath(): string | null {
  const repoConfig = path.join(REPO_ROOT_ABS, ".vibe", "config.toml");
  if (fs.existsSync(repoConfig)) return repoConfig;

  const home = os.homedir?.() ?? process.env.HOME ?? "";
  if (!home) return null;

  const userConfig = path.join(home, ".vibe", "config.toml");
  return fs.existsSync(userConfig) ? userConfig : null;
}

function stripTomlComments(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'")) {
    // For single-quoted TOML strings, ensure the string is properly closed
    // before stripping the surrounding quotes. If it's malformed (e.g. missing
    // a closing quote), return the trimmed value unchanged to avoid corrupting it.
    if (trimmed.length >= 2 && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }
  return trimmed;
}

function splitTomlArray(raw: string): string[] {
  const values: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }

    if (ch === "," && !inSingle && !inDouble) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }
  if (current.trim()) values.push(current.trim());
  return values;
}

function parseTomlValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitTomlArray(inner).map((entry) => parseTomlValue(entry));
  }
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return parseTomlString(trimmed);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (!Number.isNaN(Number(trimmed)) && trimmed !== "") {
    return Number(trimmed);
  }
  return trimmed;
}

function parseToml(contents: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let currentPath: string[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const cleaned = stripTomlComments(rawLine).trim();
    if (!cleaned) continue;

    if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
      const section = cleaned.slice(1, -1).trim();
      currentPath = section ? section.split(".") : [];
      continue;
    }

    const equalsIndex = cleaned.indexOf("=");
    if (equalsIndex <= 0) continue;

    const key = cleaned.slice(0, equalsIndex).trim();
    const value = cleaned.slice(equalsIndex + 1).trim();
    if (!key) continue;

    let target: Record<string, unknown> = root;
    for (const segment of currentPath) {
      const existing = target[segment];
      if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
        target[segment] = {};
      }
      target = target[segment] as Record<string, unknown>;
    }

    target[key] = parseTomlValue(value);
  }

  return root;
}

function extractStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return items.length ? items : undefined;
}

function extractModelList(value: unknown): string[] | undefined {
  const array = extractStringArray(value);
  if (array) return array;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      entries.push(entry.trim());
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string" && id.trim()) entries.push(id.trim());
    } else if (key.trim()) {
      entries.push(key.trim());
    }
  }
  return entries.length ? entries : undefined;
}

function extractTools(value: unknown): Record<string, { permissions?: unknown }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, { permissions?: unknown }> = {};
  for (const [toolName, config] of Object.entries(value as Record<string, unknown>)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    const permissions = (config as Record<string, unknown>).permissions;
    if (permissions !== undefined) {
      result[toolName] = { permissions };
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export function getVibeConfig(): VibeConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  const configPath = findVibeConfigPath();
  if (!configPath) {
    cachedConfig = null;
    return cachedConfig;
  }

  try {
    const contents = fs.readFileSync(configPath, "utf8");
    const parsed = parseToml(contents);
    const config: VibeConfig = {};

    if (typeof parsed.active_model === "string" && parsed.active_model.trim()) {
      config.active_model = parsed.active_model.trim();
    }

    if (
      parsed.providers &&
      typeof parsed.providers === "object" &&
      !Array.isArray(parsed.providers)
    ) {
      config.providers = parsed.providers as Record<string, unknown>;
    }

    const models = extractModelList(parsed.models);
    if (models) config.models = models;

    const enabledTools = extractStringArray(parsed.enabled_tools);
    if (enabledTools) config.enabled_tools = enabledTools;

    const disabledTools = extractStringArray(parsed.disabled_tools);
    if (disabledTools) config.disabled_tools = disabledTools;

    const tools = extractTools(parsed.tools);
    if (tools) config.tools = tools;

    cachedConfig = Object.keys(config).length ? config : null;
    return cachedConfig;
  } catch {
    cachedConfig = null;
    return cachedConfig;
  }
}
