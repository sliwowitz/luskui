import { createCodexBackend } from "./codex/index.js";
import type { Backend, BackendConfig } from "./types.js";

export type BackendId = "codex";

export function getBackend(config: BackendConfig): Backend {
  const requested = (process.env.CODEXUI_BACKEND || "codex").toLowerCase();
  switch (requested) {
    case "codex":
      return createCodexBackend(config);
    default:
      throw new Error(`Unsupported backend: ${requested}`);
  }
}

export type {
  Backend,
  BackendConfig,
  BackendEvent,
  BackendModelSettings,
  ModelSelectionPayload
} from "./types.js";
