import {
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  MODEL_CACHE_TTL_MS
} from "./config.js";
import { getAccessToken } from "./auth.js";

let activeModel = DEFAULT_MODEL;
let activeEffort = DEFAULT_EFFORT;
let cachedModels = { list: null, fetchedAt: 0 };
let inflightModelFetch = null;

async function fetchModelsFromApi() {
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
    const payload = await resp.json();
    if (!payload || !Array.isArray(payload.data)) return null;
    const seen = new Set();
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

export async function getAvailableModels() {
  const now = Date.now();
  if (cachedModels.list && now - cachedModels.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cachedModels.list;
  }
  if (!inflightModelFetch) {
    inflightModelFetch = (async () => {
      const remote = await fetchModelsFromApi();
      const combined = remote && remote.length ? remote : [];
      const defaults = FALLBACK_MODELS.filter(Boolean);
      const merged = Array.from(new Set([...combined, ...defaults])).sort((a, b) =>
        a.localeCompare(b)
      );
      cachedModels = { list: merged, fetchedAt: Date.now() };
      return merged;
    })()
      .catch(() => {
        const merged = Array.from(new Set(FALLBACK_MODELS));
        cachedModels = { list: merged, fetchedAt: Date.now() };
        return merged;
      })
      .finally(() => {
        inflightModelFetch = null;
      });
  }
  return inflightModelFetch;
}

export function getActiveModel() {
  return activeModel;
}

export function getActiveEffort() {
  return activeEffort;
}

export function updateModelSelection({ model, effort } = {}) {
  if (typeof model === "string") {
    const requested = model.trim();
    activeModel = requested || null;
  }
  if (effort === null || effort === "") {
    activeEffort = null;
  } else if (typeof effort === "string") {
    const normalized = effort.trim().toLowerCase();
    if (EFFORT_OPTIONS.includes(normalized)) {
      activeEffort = normalized;
    }
  }
}

export async function getModelSettings() {
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
