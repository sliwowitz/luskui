import { MODEL_CACHE_TTL_MS } from "../../config.js";
import { getVibeConfig } from "../../vibeConfig.js";

const vibeConfig = getVibeConfig();

const DEFAULT_MISTRAL_MODEL =
  process.env.CODEXUI_MISTRAL_MODEL ||
  process.env.CODEXUI_MODEL ||
  vibeConfig?.active_model ||
  "mistral-large-latest";

let activeModel: string | null = DEFAULT_MISTRAL_MODEL;
let cachedModels: { list: string[]; fetchedAt: number } | null = null;
let inflightModelFetch: Promise<string[]> | null = null;

interface ModelEntry {
  id?: string;
}

interface ModelResponse {
  data?: ModelEntry[];
}

function getMistralApiKey(): string | null {
  return process.env.CODEXUI_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || null;
}

function mergeModels(apiModels: string[], configModels: string[] | undefined): string[] {
  const seen = new Set<string>();
  for (const model of apiModels) {
    if (model) seen.add(model);
  }
  if (configModels) {
    for (const model of configModels) {
      if (model) seen.add(model);
    }
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

async function fetchModelsFromApi(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  const apiKey = getMistralApiKey();
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.CODEXUI_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch("https://api.mistral.ai/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
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
    console.warn("Failed to fetch Mistral models", error instanceof Error ? error.message : error);
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
      const merged = mergeModels(remote && remote.length ? remote : [], vibeConfig?.models);
      cachedModels = { list: merged, fetchedAt: Date.now() };
      return merged;
    })()
      .catch(() => {
        const merged = mergeModels([], vibeConfig?.models);
        cachedModels = { list: merged, fetchedAt: Date.now() };
        return merged;
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
    defaultModel: DEFAULT_MISTRAL_MODEL || null,
    availableModels,
    effort: null,
    defaultEffort: null,
    effortOptions: []
  };
}
