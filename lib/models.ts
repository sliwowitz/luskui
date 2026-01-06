import {
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  MODEL_CACHE_TTL_MS,
} from './config.js';
import { getAccessToken } from './auth.js';

interface ModelListCache {
  list: string[] | null;
  fetchedAt: number;
}

export interface ModelSettings {
  model: string | null;
  defaultModel: string | null;
  availableModels: string[];
  effort: string | null;
  defaultEffort: string | null;
  effortOptions: string[];
}

export interface ModelSelectionInput {
  model?: string | null;
  effort?: string | null;
}

let activeModel: string | null = DEFAULT_MODEL;
let activeEffort: string | null = DEFAULT_EFFORT;
let cachedModels: ModelListCache = { list: null, fetchedAt: 0 };
let inflightModelFetch: Promise<string[]> | null = null;

async function fetchModelsFromApi(): Promise<string[] | null> {
  if (typeof fetch !== 'function') return null;
  const token = getAccessToken();
  if (!token) return null;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.CODEXUI_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`Model request failed (${resp.status})`);
    }
    const payload = await resp.json();
    if (!payload || !Array.isArray(payload.data)) return null;
    const seen = new Set<string>();
    for (const entry of payload.data) {
      const id = typeof entry?.id === 'string' ? entry.id : null;
      if (!id) continue;
      if (id.startsWith('ft:')) continue;
      if (id.includes('deprecated')) continue;
      seen.add(id);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn('Failed to fetch models', error instanceof Error ? error.message : error);
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
      const combined = remote && remote.length ? remote : [];
      const defaults = FALLBACK_MODELS.filter(Boolean);
      const merged = Array.from(new Set([...combined, ...defaults])).sort((a, b) =>
        a.localeCompare(b),
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
  return inflightModelFetch ?? Promise.resolve(cachedModels.list ?? []);
}

export function getActiveModel(): string | null {
  return activeModel;
}

export function getActiveEffort(): string | null {
  return activeEffort;
}

export function updateModelSelection(selection: ModelSelectionInput = {}): void {
  if (Object.prototype.hasOwnProperty.call(selection, 'model')) {
    const value = selection.model;
    if (typeof value === 'string') {
      const requested = value.trim();
      activeModel = requested || null;
    } else {
      activeModel = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(selection, 'effort')) {
    const value = selection.effort;
    if (value === null || value === '') {
      activeEffort = null;
    } else if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (EFFORT_OPTIONS.includes(normalized)) {
        activeEffort = normalized;
      }
    }
  }
}

export async function getModelSettings(): Promise<ModelSettings> {
  const models = await getAvailableModels();
  return {
    model: activeModel,
    defaultModel: DEFAULT_MODEL,
    availableModels: models,
    effort: activeEffort,
    defaultEffort: DEFAULT_EFFORT,
    effortOptions: EFFORT_OPTIONS,
  };
}
