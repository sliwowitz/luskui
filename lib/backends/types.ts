/**
 * Shared types for backend implementations.
 *
 * This module defines the interface between the server and AI backends.
 * All backends must implement the Backend interface to be pluggable.
 */

/**
 * Represents a tool/command executed by the AI.
 */
export type BackendTool = {
  name: string;
  args: string[];
};

/**
 * Normalized event types emitted by all backends.
 * The server translates these to SSE messages for the UI.
 */
export type BackendEvent =
  | { type: "thinking"; text: string }
  | { type: "message"; text: string }
  | { type: "diff"; diff: { patch: string } }
  | { type: "tool.start"; tool: BackendTool }
  | { type: "tool.stdout"; text: string }
  | { type: "tool.stderr"; text: string }
  | { type: "tool.end"; tool: BackendTool; exit_code?: number; status?: string }
  | { type: "status"; text: string };

/**
 * Configuration for backend initialization.
 *
 * DESIGN NOTE: This project runs in fully isolated containers with ephemeral lifetimes.
 * Security features like sandboxing, approval policies, and network restrictions are
 * intentionally disabled/bypassed since the container boundary provides isolation.
 * In this context:
 * - sandboxMode is always "danger-full-access" (container is the sandbox)
 * - networkAccessEnabled is always true (external network isolation is at container level)
 * - approvalPolicy is always "never" (no human in the loop for this use case)
 *
 * These fields exist because the Codex SDK requires them, but their values are fixed.
 */
export type BackendConfig = {
  /** Absolute path to the repository/workspace directory */
  workingDirectory: string;
  /** Skip .git directory check for non-repo workspaces */
  skipGitRepoCheck: boolean;
  /** Always "danger-full-access" - container boundary is the sandbox */
  sandboxMode: "danger-full-access" | "sandbox";
  /** Always true - network isolation handled at container level */
  networkAccessEnabled: boolean;
  /** Always "never" - no manual approval in container context */
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
};

/**
 * Payload for updating model selection via POST /api/model.
 * Fields are optional - only specified fields are updated.
 */
export type ModelSelectionPayload = { model?: unknown; effort?: unknown };

/**
 * Model settings returned by GET /api/model.
 * Used by UI to populate model selector dropdowns.
 */
export type BackendModelSettings = {
  model: string | null;
  defaultModel: string | null;
  availableModels: string[];
  effort: string | null;
  defaultEffort: string | null;
  effortOptions: readonly string[];
};

/**
 * Interface that all AI backends must implement.
 * Enables pluggable backend architecture (Codex, Claude, Mistral).
 */
export type Backend = {
  /** Human-readable backend name for logging */
  name: string;
  /** Execute a prompt and stream results as BackendEvents */
  streamRun: (prompt: string) => Promise<AsyncIterable<BackendEvent>>;
  /** Get current model configuration for UI */
  getModelSettings: () => Promise<BackendModelSettings>;
  /** Update model/effort selection */
  updateModelSelection: (payload: ModelSelectionPayload) => void;
};
