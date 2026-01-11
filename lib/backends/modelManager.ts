/**
 * Shared model management module for all backends.
 *
 * All three backends (Codex, Claude, Mistral) share nearly identical logic for:
 * - Model caching with TTL and in-flight request deduplication
 * - Active model state management
 * - Model selection updates with validation
 * - Model settings retrieval
 *
 * This module provides a factory to create backend-specific model managers,
 * eliminating ~150 lines of duplicated code per backend while keeping each
 * backend's specific model fetching logic isolated.
 */
import { MODEL_CACHE_TTL_MS } from "../config.js";
import type { BackendModelSettings, ModelSelectionPayload } from "./types.js";

export type ModelManagerConfig = {
  /** Default model ID when none is selected. Resolved from env/config at init time. */
  defaultModel: string | null;
  /** Whether this backend supports reasoning effort levels (only Codex does). */
  supportsEffort: boolean;
  /** Default effort level if supportsEffort is true. */
  defaultEffort: string | null;
  /** Valid effort options if supportsEffort is true. */
  effortOptions: readonly string[];
  /** Async function to fetch available models from the provider's API. */
  fetchModels: () => Promise<string[] | null>;
  /** Optional list of models from config (e.g., Vibe config) to merge with API results. */
  configModels?: string[];
};

export type ModelManager = {
  getActiveModel: () => string | null;
  getActiveEffort: () => string | null;
  updateModelSelection: (payload: ModelSelectionPayload) => void;
  getModelSettings: () => Promise<BackendModelSettings>;
};

/**
 * Creates a model manager instance with backend-specific configuration.
 *
 * The manager maintains local state for:
 * - Active model selection (overrides default)
 * - Active effort level (Codex only)
 * - Cached model list with TTL
 * - In-flight fetch deduplication to prevent redundant API calls
 */
export function createModelManager(config: ModelManagerConfig): ModelManager {
  let activeModel: string | null = config.defaultModel;
  let activeEffort: string | null = config.supportsEffort ? config.defaultEffort : null;
  let cachedModels: { list: string[]; fetchedAt: number } | null = null;
  let inflightFetch: Promise<string[]> | null = null;

  /**
   * Merges API-fetched models with config-defined models (if any).
   * Used by Mistral to include models from Vibe CLI config.
   */
  function mergeWithConfigModels(apiModels: string[]): string[] {
    const seen = new Set<string>(apiModels);
    if (config.configModels) {
      for (const m of config.configModels) {
        if (m) seen.add(m);
      }
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  }

  async function getAvailableModels(): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - cachedModels.fetchedAt < MODEL_CACHE_TTL_MS) {
      return cachedModels.list;
    }
    // Deduplicate concurrent fetches - all callers share the same in-flight promise
    if (!inflightFetch) {
      inflightFetch = (async () => {
        const remote = await config.fetchModels();
        const models = mergeWithConfigModels(remote && remote.length ? remote : []);
        cachedModels = { list: models, fetchedAt: Date.now() };
        return models;
      })()
        .catch(() => {
          const models = mergeWithConfigModels([]);
          cachedModels = { list: models, fetchedAt: Date.now() };
          return models;
        })
        .finally(() => {
          inflightFetch = null;
        });
    }
    return inflightFetch;
  }

  function getActiveModel(): string | null {
    return activeModel;
  }

  function getActiveEffort(): string | null {
    return activeEffort;
  }

  function updateModelSelection(payload: ModelSelectionPayload = {}): void {
    const { model, effort } = payload;

    // Handle model update
    if ("model" in payload && typeof model !== "string") {
      activeModel = null;
    } else if (typeof model === "string") {
      const trimmed = model.trim();
      activeModel = trimmed || null;
    }

    // Handle effort update (only if backend supports it)
    if (config.supportsEffort) {
      if ("effort" in payload && typeof effort !== "string") {
        activeEffort = null;
      } else if (typeof effort === "string") {
        const normalized = effort.trim().toLowerCase();
        if (normalized === "") {
          activeEffort = null;
        } else if ((config.effortOptions as readonly string[]).includes(normalized)) {
          activeEffort = normalized;
        }
        // Invalid effort values are silently ignored, preserving current selection
      }
    }
  }

  async function getModelSettings(): Promise<BackendModelSettings> {
    const models = await getAvailableModels();
    return {
      model: activeModel,
      defaultModel: config.defaultModel,
      availableModels: models,
      effort: config.supportsEffort ? activeEffort : null,
      defaultEffort: config.supportsEffort ? config.defaultEffort : null,
      effortOptions: config.supportsEffort ? config.effortOptions : []
    };
  }

  return {
    getActiveModel,
    getActiveEffort,
    updateModelSelection,
    getModelSettings
  };
}
