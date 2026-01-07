import {
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  MODEL_CACHE_TTL_MS,
  type ReasoningEffort
} from "../../config.js";
import { getAccessToken } from "../../auth.js";

type ModelList = string[] | null;

let activeModel: string | null = DEFAULT_MODEL;
let activeEffort: ReasoningEffort | null = DEFAULT_EFFORT;
let cachedModels: { list: ModelList; fetchedAt: number } = { list: null, fetchedAt: 0 };
let inflightModelFetch: Promise<string[]> | null = null;

interface ModelEntry {
  id?: string;
}

interface ModelResponse {
  data?: ModelEntry[];
}

async function fetchModelsFromApi(): Promise<string[] | null> {
  if (typeof fetch !== "function") return null;
  const token = getAccessToken();
  if (!token) return null;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.CODEXUI_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch("https://api.openai.com/v1/models", {
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
  if (cachedModels.list && now - cachedModels.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cachedModels.list;
  }
  if (!inflightModelFetch) {
    inflightModelFetch = (async () => {
      const remote = await fetchModelsFromApi();
      const combined: string[] = remote && remote.length ? remote : [];
      const defaults = FALLBACK_MODELS.filter(Boolean);
      const merged = Array.from(new Set<string>([...combined, ...defaults])).sort((a, b) =>
        a.localeCompare(b)
      );
      cachedModels = { list: merged, fetchedAt: Date.now() };
      return merged;
    })()
      .catch(() => {
        const merged = Array.from(new Set<string>(FALLBACK_MODELS));
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
