import { Mistral } from "@mistralai/mistralai";

import type { Backend, BackendConfig, BackendEvent, BackendTool } from "../types.js";
import { getActiveModel, getModelSettings, updateModelSelection } from "./models.js";

type StreamEvent = {
  data?: {
    type?: string;
    id?: string;
    name?: string;
    arguments?: string;
    content?: unknown;
    info?: unknown;
  };
};

type ContentChunk = {
  type?: string;
  text?: string;
  thinking?: Array<{ text?: string }>;
};

function getMistralApiKey(): string | null {
  return process.env.CODEXUI_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || null;
}

function formatToolArgs(raw: unknown): string[] {
  if (raw === null || raw === undefined) {
    return [];
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    // If the string looks like JSON, try to parse and format it.
    try {
      const parsed = JSON.parse(trimmed);
      return formatToolArgs(parsed);
    } catch {
      return [raw];
    }
  }

  if (typeof raw === "number" || typeof raw === "boolean") {
    return [String(raw)];
  }

  if (Array.isArray(raw) || typeof raw === "object") {
    try {
      return [JSON.stringify(raw, null, 2)];
    } catch {
      return [String(raw)];
    }
  }

  return [String(raw)];
}

function* handleContent(content: unknown): Generator<BackendEvent> {
  if (!content) return;
  if (typeof content === "string") {
    yield { type: "message", text: content };
    return;
  }
  if (typeof content !== "object") return;

  const chunk = content as ContentChunk;
  if (chunk.type === "text" && chunk.text) {
    yield { type: "message", text: chunk.text };
    return;
  }
  if (chunk.type === "thinking" && Array.isArray(chunk.thinking)) {
    for (const part of chunk.thinking) {
      if (part?.text) {
        yield { type: "thinking", text: part.text };
      }
    }
    return;
  }
  if (chunk.text) {
    yield { type: "message", text: chunk.text };
  }
}

function extractDiffs(text: string): string[] {
  const matches: string[] = [];
  const regex = /```(?:diff|patch)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text))) {
    if (match[1]) matches.push(match[1].trimEnd());
  }
  return matches;
}

export function createMistralBackend(config: BackendConfig): Backend {
  return {
    name: "mistral",
    async streamRun(prompt: string) {
      if (!config.networkAccessEnabled) {
        throw new Error("Mistral backend requires network access");
      }
      const apiKey = getMistralApiKey();
      if (!apiKey) {
        throw new Error("Missing Mistral API key (set CODEXUI_MISTRAL_API_KEY or MISTRAL_API_KEY)");
      }

      const mistral = new Mistral({ apiKey });
      const model = getActiveModel() || "mistral-large-latest";

      const stream = await mistral.beta.conversations.startStream({
        inputs: [
          {
            object: "entry",
            type: "message.input",
            role: "user",
            content: prompt
          }
        ],
        model,
        completionArgs: {
          responseFormat: { type: "text" }
        }
      });

      const toolState = new Map<string, BackendTool>();
      let messageBuffer = "";

      return (async function* (): AsyncIterable<BackendEvent> {
        yield { type: "status", text: "Running…" };

        for await (const event of stream as AsyncIterable<StreamEvent>) {
          const payload = event?.data;
          if (!payload?.type) continue;

          switch (payload.type) {
            case "conversation.response.started":
              yield { type: "status", text: "Running…" };
              break;
            case "conversation.response.error":
              throw new Error("Mistral stream error");
            case "message.output.delta": {
              const content = payload.content;
              for (const item of handleContent(content)) {
                if (item.type === "message") {
                  messageBuffer += item.text;
                }
                yield item;
              }
              break;
            }
            case "tool.execution.started":
            case "tool.execution.delta": {
              const id = payload.id || `${payload.name || "tool"}-${payload.arguments || ""}`;
              let tool = toolState.get(id);
              if (!tool) {
                tool = {
                  name: payload.name || "tool",
                  args: formatToolArgs(payload.arguments)
                };
                toolState.set(id, tool);
                yield { type: "tool.start", tool };
              } else if (payload.arguments) {
                tool.args = formatToolArgs(payload.arguments);
              }
              break;
            }
            case "tool.execution.done": {
              const id = payload.id || `${payload.name || "tool"}`;
              const tool = toolState.get(id) || {
                name: payload.name || "tool",
                args: formatToolArgs("")
              };
              yield { type: "tool.end", tool, status: "completed" };
              toolState.delete(id);
              break;
            }
            case "function.call.delta": {
              const id = payload.id || `${payload.name || "function"}`;
              let tool = toolState.get(id);
              if (!tool) {
                tool = {
                  name: payload.name || "function",
                  args: formatToolArgs(payload.arguments)
                };
                toolState.set(id, tool);
                yield { type: "tool.start", tool };
              } else if (payload.arguments) {
                tool.args = formatToolArgs(payload.arguments);
              }
              break;
            }
            case "conversation.response.done": {
              const diffs = extractDiffs(messageBuffer);
              for (const patch of diffs) {
                yield { type: "diff", diff: { patch } };
              }
              break;
            }
            default:
              if (payload.content) {
                for (const item of handleContent(payload.content)) {
                  if (item.type === "message") {
                    messageBuffer += item.text;
                  }
                  yield item;
                }
              }
              break;
          }
        }
      })();
    },
    getModelSettings,
    updateModelSelection
  };
}
