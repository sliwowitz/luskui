import type { Backend, BackendConfig, BackendEvent, BackendTool } from "../types.js";
import { getActiveModel, getModelSettings, updateModelSelection } from "./models.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

type SseEvent = {
  event: string;
  data: string;
};

type ClaudeContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
};

type ClaudeStreamPayload = {
  type?: string;
  message?: { id?: string; model?: string };
  index?: number;
  content_block?: ClaudeContentBlock;
  delta?: { type?: string; text?: string; partial_json?: string };
  error?: { message?: string } | string;
};

function getClaudeApiKey(): string | null {
  return (
    process.env.CODEXUI_CLAUDE_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    null
  );
}

function formatToolArgs(input: unknown): string[] {
  if (input === null || typeof input === "undefined") return [];
  if (typeof input === "string") return [input];
  if (typeof input === "number" || typeof input === "boolean") return [String(input)];
  if (Array.isArray(input)) return input.map((entry) => String(entry));
  if (typeof input === "object") {
    return Object.entries(input as Record<string, unknown>).map(
      ([key, value]) => `${key}=${JSON.stringify(value)}`
    );
  }
  return [String(input)];
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

async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundaryIndex = buffer.indexOf("\n\n");
    while (boundaryIndex !== -1) {
      const raw = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      const event = parseSseBlock(raw);
      if (event) yield event;
      boundaryIndex = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) {
    const event = parseSseBlock(buffer);
    if (event) yield event;
  }
}

function parseSseBlock(raw: string): SseEvent | null {
  const lines = raw.split("\n");
  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || eventName;
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) return null;
  return { event: eventName, data: dataLines.join("\n") };
}

export function createClaudeBackend(config: BackendConfig): Backend {
  const systemPrompt = [
    `Working directory: ${config.workingDirectory}`,
    `Network access enabled: ${config.networkAccessEnabled ? "yes" : "no"}`,
    `Sandbox mode: ${config.sandboxMode}`,
    `Approval policy: ${config.approvalPolicy}`
  ].join("\n");

  return {
    name: "claude",
    async streamRun(prompt: string) {
      if (!config.networkAccessEnabled) {
        throw new Error("Claude backend requires network access");
      }
      const apiKey = getClaudeApiKey();
      if (!apiKey) {
        throw new Error("Missing Claude API key (set CODEXUI_CLAUDE_API_KEY or ANTHROPIC_API_KEY)");
      }

      const model = getActiveModel() || "claude-3-5-sonnet-20240620";
      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          stream: true,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }]
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Claude request failed (${response.status}): ${errorText}`);
      }

      const body = response.body;
      if (!body) throw new Error("Claude response body missing");

      const toolState = new Map<number, BackendTool>();
      let messageBuffer = "";

      const stream = parseSseStream(body);

      return (async function* (): AsyncIterable<BackendEvent> {
        yield { type: "status", text: "Running…" };
        for await (const { event, data } of stream) {
          if (!data || data === "[DONE]") continue;
          let payload: ClaudeStreamPayload;
          try {
            payload = JSON.parse(data) as ClaudeStreamPayload;
          } catch {
            continue;
          }

          switch (event) {
            case "message_start":
              break;
            case "content_block_start": {
              const index = payload.index ?? 0;
              const block = payload.content_block;
              if (block?.type === "tool_use") {
                const tool: BackendTool = {
                  name: block.name || "tool",
                  args: formatToolArgs(block.input)
                };
                toolState.set(index, tool);
                yield { type: "tool.start", tool };
              }
              if (block?.type === "text" && block.text) {
                messageBuffer += block.text;
                yield { type: "message", text: block.text };
              }
              if (block?.type === "thinking" && block.text) {
                yield { type: "thinking", text: block.text };
              }
              break;
            }
            case "content_block_delta": {
              const index = payload.index ?? 0;
              const delta = payload.delta;
              if (delta?.type === "text_delta" && delta.text) {
                messageBuffer += delta.text;
                yield { type: "message", text: delta.text };
              }
              if (delta?.type === "thinking_delta" && delta.text) {
                yield { type: "thinking", text: delta.text };
              }
              if (delta?.type === "input_json_delta" && delta.partial_json) {
                const tool = toolState.get(index);
                if (tool && tool.args.length === 0) {
                  tool.args = [delta.partial_json];
                }
              }
              break;
            }
            case "content_block_stop": {
              const index = payload.index ?? 0;
              const tool = toolState.get(index);
              if (tool) {
                yield { type: "tool.end", tool, status: "completed" };
                toolState.delete(index);
              }
              break;
            }
            case "message_stop": {
              const diffs = extractDiffs(messageBuffer);
              for (const patch of diffs) {
                yield { type: "diff", diff: { patch } };
              }
              break;
            }
            case "error":
              throw new Error(
                typeof payload.error === "string"
                  ? payload.error
                  : payload.error?.message || "Claude error"
              );
            default:
              break;
          }
        }
      })();
    },
    getModelSettings,
    updateModelSelection
  };
}
