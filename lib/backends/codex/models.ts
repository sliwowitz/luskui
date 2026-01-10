import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CODEX_AUTH_PATH,
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  EFFORT_OPTIONS,
  MODEL_CACHE_TTL_MS,
  type ReasoningEffort
} from "../../config.js";

let activeModel: string | null = DEFAULT_MODEL;
let activeEffort: ReasoningEffort | null = DEFAULT_EFFORT;
let cachedModels: { list: string[]; fetchedAt: number } | null = null;
let inflightModelFetch: Promise<string[]> | null = null;

interface ModelEntry {
  id?: string;
}

interface ModelResponse {
  data?: ModelEntry[];
}

type CodexModelsResponse = {
  models?: Array<{ slug?: string; model?: string; id?: string }>;
};

const CHATGPT_MODELS_ENDPOINT = "https://chatgpt.com/backend-api/codex/models";
const OPENAI_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
type CodexAuth = { token: string | null; accountId: string | null };

function getCodexAuthFromFile(): CodexAuth {
  try {
    const raw = fs.readFileSync(CODEX_AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const token =
      typeof parsed?.tokens?.access_token === "string" ? parsed.tokens.access_token : null;
    const accountId =
      typeof parsed?.account_id === "string"
        ? parsed.account_id
        : typeof parsed?.tokens?.account_id === "string"
          ? parsed.tokens.account_id
          : null;
    return { token, accountId };
  } catch {
    return { token: null, accountId: null };
  }
}

function getClientVersion(): string {
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const packagePath = path.resolve(currentDir, "../../../package.json");
    const contents = fs.readFileSync(packagePath, "utf8");
    const parsed = JSON.parse(contents);
    if (typeof parsed?.version === "string" && parsed.version.trim()) {
      return parsed.version.trim();
    }
    console.debug(
      'getClientVersion: package.json does not contain a valid "version" field, falling back to "0.0.0".'
    );
  } catch (error) {
    console.debug(
      'getClientVersion: failed to read or parse package.json, falling back to "0.0.0".',
      error instanceof Error ? error.message : error
    );
  }
  return "0.0.0";
}

async function fetchModelsFromChatgpt(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  const { token, accountId } = getCodexAuthFromFile();
  if (!token) return null;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.CODEXUI_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const clientVersion = getClientVersion();
  try {
    const url = new URL(CHATGPT_MODELS_ENDPOINT);
    if (clientVersion) {
      url.searchParams.set("client_version", clientVersion);
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`
    };
    if (accountId) {
      headers["ChatGPT-Account-ID"] = accountId;
    }
    const resp = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`ChatGPT model request failed (${resp.status}) for ${url.toString()}`);
    }
    const payload = (await resp.json()) as CodexModelsResponse;
    if (!payload || !Array.isArray(payload.models)) return null;
    const seen = new Set<string>();
    for (const entry of payload.models) {
      const id =
        typeof entry?.slug === "string"
          ? entry.slug
          : typeof entry?.model === "string"
            ? entry.model
            : typeof entry?.id === "string"
              ? entry.id
              : null;
      if (!id) continue;
      seen.add(id);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn("Failed to fetch ChatGPT models", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchModelsFromApi(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  const token = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || null;
  if (!token) return null;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.CODEXUI_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(OPENAI_MODELS_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`Model request failed (${resp.status})`);
    }
    const payload = (await resp.json()) as ModelResponse;
    if (!payload || !Array.isArray(payload.data)) return null;
    const seen = new Set<string>();
    for (const entry of payload.data) {
      const id = typeof entry?.id === "string" ? entry.id : null;
      if (!id) continue;
      if (id.startsWith("ft:")) continue;
      if (id.includes("deprecated")) continue;
      seen.add(id);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn("Failed to fetch models", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAvailableModels(): Promise<string[]> {
  const now = Date.now();
  if (cachedModels && now - cachedModels.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cachedModels.list;
  }
  if (!inflightModelFetch) {
    inflightModelFetch = (async () => {
      const remote = (await fetchModelsFromChatgpt()) || (await fetchModelsFromApi());
      const models: string[] = remote && remote.length ? remote : [];
      cachedModels = { list: models, fetchedAt: Date.now() };
      return models;
    })()
      .catch(() => {
        cachedModels = { list: [], fetchedAt: Date.now() };
        return [];
      })
      .finally(() => {
        inflightModelFetch = null;
      });
  }
  return inflightModelFetch;
}

export function getActiveModel(): string | null {
  return activeModel;
}

export function getActiveEffort(): ReasoningEffort | null {
  return activeEffort;
}

interface ModelSelection {
  model?: unknown;
  effort?: unknown;
}

export function updateModelSelection(selection: ModelSelection = {}): void {
  const { model, effort } = selection;
  if ("model" in selection && typeof model !== "string") {
    activeModel = null;
  } else if (typeof model === "string") {
    const requested = model.trim();
    activeModel = requested || null;
  }
  if (effort === null || effort === "") {
    activeEffort = null;
  } else if (typeof effort === "string") {
    const normalized = effort.trim().toLowerCase();
    if ((EFFORT_OPTIONS as readonly string[]).includes(normalized)) {
      activeEffort = normalized as ReasoningEffort;
    }
  }
}

export async function getModelSettings(): Promise<{
  model: string | null;
  defaultModel: string | null;
  availableModels: string[];
  effort: ReasoningEffort | null;
  defaultEffort: ReasoningEffort | null;
  effortOptions: readonly ReasoningEffort[];
}> {
  const models = await getAvailableModels();
  return {
    model: activeModel,
    defaultModel: DEFAULT_MODEL,
    availableModels: models,
    effort: activeEffort,
    defaultEffort: DEFAULT_EFFORT,
    effortOptions: EFFORT_OPTIONS
  };
}
