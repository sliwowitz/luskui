export type BackendTool = {
  name: string;
  args: string[];
};

export type BackendEvent =
  | { type: "thinking"; text: string }
  | { type: "message"; text: string }
  | { type: "diff"; diff: { patch: string } }
  | { type: "tool.start"; tool: BackendTool }
  | { type: "tool.stdout"; text: string }
  | { type: "tool.stderr"; text: string }
  | { type: "tool.end"; tool: BackendTool; exit_code?: number; status?: string }
  | { type: "status"; text: string };

export type BackendConfig = {
  workingDirectory: string;
  skipGitRepoCheck: boolean;
  sandboxMode: "danger-full-access" | "sandbox";
  networkAccessEnabled: boolean;
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
};

export type ModelSelectionPayload = { model?: unknown; effort?: unknown };

export type BackendModelSettings = {
  model: string | null;
  defaultModel: string | null;
  availableModels: string[];
  effort: string | null;
  defaultEffort: string | null;
  effortOptions: readonly string[];
};

export type Backend = {
  name: string;
  streamRun: (prompt: string) => Promise<AsyncIterable<BackendEvent>>;
  getModelSettings: () => Promise<BackendModelSettings>;
  updateModelSelection: (payload: ModelSelectionPayload) => void;
};
