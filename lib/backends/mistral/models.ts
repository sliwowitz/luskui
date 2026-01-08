const DEFAULT_MISTRAL_MODEL =
  process.env.CODEXUI_MISTRAL_MODEL || process.env.CODEXUI_MODEL || "mistral-large-latest";

const FALLBACK_MISTRAL_MODELS = [
  "mistral-large-latest",
  "mistral-medium-latest",
  "mistral-small-latest"
];

let activeModel: string | null = DEFAULT_MISTRAL_MODEL;

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
  const availableModels = Array.from(new Set([DEFAULT_MISTRAL_MODEL, ...FALLBACK_MISTRAL_MODELS]))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return {
    model: activeModel,
    defaultModel: DEFAULT_MISTRAL_MODEL || null,
    availableModels,
    effort: null,
    defaultEffort: null,
    effortOptions: []
  };
}
