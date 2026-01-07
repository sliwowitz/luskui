const DEFAULT_CLAUDE_MODEL =
  process.env.CODEXUI_CLAUDE_MODEL || process.env.CODEXUI_MODEL || "claude-3-5-sonnet-20240620";

const FALLBACK_CLAUDE_MODELS = [
  "claude-3-5-sonnet-20240620",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229"
];

let activeModel: string | null = DEFAULT_CLAUDE_MODEL || null;

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
  const availableModels = Array.from(new Set([DEFAULT_CLAUDE_MODEL, ...FALLBACK_CLAUDE_MODELS]))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return {
    model: activeModel,
    defaultModel: DEFAULT_CLAUDE_MODEL || null,
    availableModels,
    effort: null,
    defaultEffort: null,
    effortOptions: []
  };
}
