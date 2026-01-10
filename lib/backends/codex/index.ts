import { Codex } from "@openai/codex-sdk";
import type { ApprovalMode, ModelReasoningEffort, SandboxMode } from "@openai/codex-sdk";

import type { Backend, BackendConfig, BackendEvent, BackendTool } from "../types.js";
import {
  getActiveEffort,
  getActiveModel,
  getModelSettings,
  updateModelSelection
} from "./models.js";

type CommandEventItem = {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  patch?: string;
  diff?: { patch?: string };
  changes?: Array<{ patch?: string }>;
};

type StreamEvent = {
  type?: string;
  thread_id?: string;
  usage?: unknown;
  error?: { message?: string } | string;
  item?: CommandEventItem;
  diff?: { patch?: string };
};

type RunStream = AsyncIterable<StreamEvent> & {
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;
};

type ThreadRunner = {
  runStreamed: (prompt: string) => Promise<{ events: RunStream }>;
};

function translateCodexStream(events: RunStream): AsyncIterable<BackendEvent> {
  const commandOutputState = new Map<string, { flushed: number; tool: BackendTool }>();

  const handleCommandItem = function* (
    eventType: string,
    item: CommandEventItem
  ): Generator<BackendEvent> {
    if (!item.id) return;
    const itemId = String(item.id);
    const existing = commandOutputState.get(itemId);
    if (!existing) {
      const tool = { name: item.command || "command", args: [] };
      commandOutputState.set(itemId, { flushed: 0, tool });
      yield { type: "tool.start", tool };
    }
    const state = commandOutputState.get(itemId);
    const output = item.aggregated_output ?? "";
    if (state && output.length > state.flushed) {
      const chunk = output.slice(state.flushed);
      state.flushed = output.length;
      yield { type: "tool.stdout", text: chunk };
    }
    if (eventType === "item.completed") {
      const tool = state?.tool || { name: item.command || "command", args: [] };
      yield {
        type: "tool.end",
        tool,
        exit_code: item.exit_code,
        status: item.status
      };
      commandOutputState.delete(itemId);
    }
  };

  const emitDiff = function* (patch?: string | null): Generator<BackendEvent> {
    if (!patch) return;
    yield { type: "diff", diff: { patch } };
  };

  return (async function* () {
    for await (const ev of events) {
      switch (ev.type) {
        case "thread.started":
          break;
        case "turn.started":
          yield { type: "status", text: "Running…" };
          break;
        case "turn.completed":
          break;
        case "turn.failed":
          throw new Error(
            typeof ev.error === "string" ? ev.error : ev.error?.message || "Codex turn failed"
          );
        case "item.started":
        case "item.updated":
        case "item.completed": {
          const item = ev.item;
          if (!item) break;
          switch (item.type) {
            case "reasoning":
              if (item.text) yield { type: "thinking", text: item.text };
              break;
            case "agent_message":
              if (ev.type === "item.completed" && item.text) {
                yield { type: "message", text: item.text };
              }
              break;
            case "command_execution":
              yield* handleCommandItem(ev.type, item);
              break;
            case "file_change": {
              const patch =
                item.patch ||
                item.diff?.patch ||
                (Array.isArray(item.changes)
                  ? item.changes.find((change) => change.patch)?.patch
                  : null);
              yield* emitDiff(patch);
              break;
            }
            case "error":
              yield { type: "message", text: item.message || "Agent error" };
              break;
            default:
              break;
          }
          break;
        }
        case "error":
          throw new Error(
            typeof ev.error === "string" ? ev.error : ev.error?.message || "Codex stream error"
          );
        default:
          if (ev.type === "diff" && ev.diff?.patch) {
            yield* emitDiff(ev.diff.patch);
          }
          break;
      }
    }
  })();
}

export function createCodexBackend(config: BackendConfig): Backend {
  const codex = new Codex();
  const sandboxMode = config.sandboxMode as SandboxMode | undefined;
  const approvalPolicy = config.approvalPolicy as ApprovalMode | undefined;

  return {
    name: "codex",
    async streamRun(prompt: string) {
      const thread: ThreadRunner = codex.startThread({
        workingDirectory: config.workingDirectory,
        skipGitRepoCheck: config.skipGitRepoCheck,
        sandboxMode,
        networkAccessEnabled: config.networkAccessEnabled,
        approvalPolicy,
        model: getActiveModel() || undefined,
        modelReasoningEffort: (getActiveEffort() as ModelReasoningEffort | null) || undefined
      });

      const { events } = await thread.runStreamed(prompt);
      return translateCodexStream(events);
    },
    getModelSettings,
    updateModelSelection
  };
}
