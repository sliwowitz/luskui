import { MODEL_CACHE_TTL_MS } from "../../config.js";
import { resolveClaudeApiKey } from "./auth.js";

const DEFAULT_CLAUDE_MODEL =
  process.env.CODEXUI_CLAUDE_MODEL || process.env.CODEXUI_MODEL || "claude-3-5-sonnet-20240620";

let activeModel: string | null = DEFAULT_CLAUDE_MODEL || null;
let cachedModels: { list: string[]; fetchedAt: number } | null = null;
let inflightModelFetch: Promise<string[]> | null = null;

interface ModelEntry {
  id?: string;
}

interface ModelResponse {
  data?: ModelEntry[];
}

async function fetchModelsFromApi(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  let apiKey: string | null = null;
  try {
    apiKey = await resolveClaudeApiKey();
  } catch (error) {
    console.warn("Failed to fetch Claude models", error instanceof Error ? error.message : error);
    return null;
  }
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.CODEXUI_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
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
      seen.add(id);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn("Failed to fetch Claude models", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAvailableModels(): Promise<string[]> {
  const now = Date.now();
  if (cachedModels && now - cachedModels.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cachedModels.list;
  }
  if (!inflightModelFetch) {
    inflightModelFetch = (async () => {
      const remote = await fetchModelsFromApi();
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

export function updateModelSelection(selection: { model?: unknown } = {}): void {
  const { model } = selection;
  if ("model" in selection && typeof model !== "string") {
    activeModel = null;
  } else if (typeof model === "string") {
    const requested = model.trim();
    activeModel = requested || null;
  }
}

export async function getModelSettings(): Promise<{
  model: string | null;
  defaultModel: string | null;
  availableModels: string[];
  effort: null;
  defaultEffort: null;
  effortOptions: readonly string[];
}> {
  const availableModels = await getAvailableModels();
  return {
    model: activeModel,
    defaultModel: DEFAULT_CLAUDE_MODEL || null,
    availableModels,
    effort: null,
    defaultEffort: null,
    effortOptions: []
  };
}
