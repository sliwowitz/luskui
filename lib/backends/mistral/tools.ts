import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { resolveRepoPath } from "../../config.js";
import type { BackendConfig, BackendTool } from "../types.js";

type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
};

type ToolExecutionResult = {
  tool: BackendTool;
  stdout: string;
  stderr: string;
  exitCode: number;
  result: string;
};

type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "filesystem.read",
    description: "Read a text file from the repository workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to read (relative to repo)." }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "filesystem.write",
    description: "Write a text file to the repository workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file to write (relative to repo)." },
        content: { type: "string", description: "File contents to write." }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    name: "filesystem.list",
    description: "List entries inside a repository directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list (relative to repo)." }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "shell",
    description: "Run a shell command inside the repository workspace.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute." }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
];

function formatToolResult(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function parseToolArgs(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildToolDefinitions(): ToolDefinition[] {
  return TOOL_SPECS.map((spec) => ({
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters
    }
  }));
}

async function executeShell(command: string, config: BackendConfig): Promise<ToolExecutionResult> {
  const tool: BackendTool = { name: "shell", args: [command] };
  return await new Promise<ToolExecutionResult>((resolve) => {
    const child = spawn("bash", ["-c", command], { cwd: config.workingDirectory });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("close", (code) => {
      resolve({
        tool,
        stdout,
        stderr,
        exitCode: code ?? 0,
        result: formatToolResult({
          ok: code === 0,
          exitCode: code ?? 0,
          stdout,
          stderr
        })
      });
    });
  });
}

function executeFilesystemRead(filePath: string): ToolExecutionResult {
  const tool: BackendTool = { name: "filesystem.read", args: [filePath] };
  try {
    const { abs, rel } = resolveRepoPath(filePath);
    const content = fs.readFileSync(abs, "utf8");
    return {
      tool,
      stdout: content,
      stderr: "",
      exitCode: 0,
      result: formatToolResult({ ok: true, path: rel, content })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool,
      stdout: "",
      stderr: message,
      exitCode: 1,
      result: formatToolResult({ ok: false, error: message })
    };
  }
}

function executeFilesystemList(dirPath: string): ToolExecutionResult {
  const tool: BackendTool = { name: "filesystem.list", args: [dirPath] };
  try {
    const { abs, rel } = resolveRepoPath(dirPath);
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }));
    const output = JSON.stringify(entries, null, 2);
    return {
      tool,
      stdout: output,
      stderr: "",
      exitCode: 0,
      result: formatToolResult({ ok: true, path: rel, entries })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool,
      stdout: "",
      stderr: message,
      exitCode: 1,
      result: formatToolResult({ ok: false, error: message })
    };
  }
}

function executeFilesystemWrite(filePath: string, content: string): ToolExecutionResult {
  const tool: BackendTool = { name: "filesystem.write", args: [filePath] };
  try {
    const { abs, rel } = resolveRepoPath(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return {
      tool,
      stdout: `Wrote ${rel}\n`,
      stderr: "",
      exitCode: 0,
      result: formatToolResult({ ok: true, path: rel })
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool,
      stdout: "",
      stderr: message,
      exitCode: 1,
      result: formatToolResult({ ok: false, error: message })
    };
  }
}

export function getMistralToolDefinitions(): ToolDefinition[] {
  return buildToolDefinitions();
}

export async function executeMistralTool(
  toolName: string,
  rawArgs: string,
  config: BackendConfig
): Promise<ToolExecutionResult> {
  const parsed = parseToolArgs(rawArgs);
  if (!parsed && toolName !== "shell") {
    const tool: BackendTool = { name: toolName, args: [rawArgs] };
    return {
      tool,
      stdout: "",
      stderr: "Invalid tool arguments",
      exitCode: 1,
      result: formatToolResult({ ok: false, error: "Invalid tool arguments" })
    };
  }

  switch (toolName) {
    case "filesystem.read": {
      const target = typeof parsed?.path === "string" ? parsed.path : "";
      if (!target) {
        return {
          tool: { name: toolName, args: [] },
          stdout: "",
          stderr: "Missing path argument",
          exitCode: 1,
          result: formatToolResult({ ok: false, error: "Missing path argument" })
        };
      }
      return executeFilesystemRead(target);
    }
    case "filesystem.list": {
      const target = typeof parsed?.path === "string" ? parsed.path : "";
      if (!target) {
        return {
          tool: { name: toolName, args: [] },
          stdout: "",
          stderr: "Missing path argument",
          exitCode: 1,
          result: formatToolResult({ ok: false, error: "Missing path argument" })
        };
      }
      return executeFilesystemList(target);
    }
    case "filesystem.write": {
      const target = typeof parsed?.path === "string" ? parsed.path : "";
      const content = typeof parsed?.content === "string" ? parsed.content : "";
      if (!target) {
        return {
          tool: { name: toolName, args: [] },
          stdout: "",
          stderr: "Missing path argument",
          exitCode: 1,
          result: formatToolResult({ ok: false, error: "Missing path argument" })
        };
      }
      return executeFilesystemWrite(target, content);
    }
    case "shell": {
      const command =
        typeof parsed?.command === "string"
          ? parsed.command
          : typeof rawArgs === "string"
            ? rawArgs
            : "";
      if (!command.trim()) {
        return {
          tool: { name: toolName, args: [] },
          stdout: "",
          stderr: "Missing command argument",
          exitCode: 1,
          result: formatToolResult({ ok: false, error: "Missing command argument" })
        };
      }
      return executeShell(command, config);
    }
    default: {
      const tool: BackendTool = { name: toolName, args: [rawArgs] };
      return {
        tool,
        stdout: "",
        stderr: `Unknown tool: ${toolName}`,
        exitCode: 1,
        result: formatToolResult({ ok: false, error: `Unknown tool: ${toolName}` })
      };
    }
  }
}
