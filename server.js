import express from "express";
import { Codex } from "@openai/codex-sdk";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const REPO_ROOT = process.env.REPO_ROOT || "/workspace";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 7860);
const REPO_ROOT_ABS = path.resolve(REPO_ROOT);
// Run-level activity is persisted so logs are inspectable without console access.
const LOG_PATH = process.env.CODEXUI_LOG || path.join("/opt/codexui", "codexui.log");
const SKIP_GIT_REPO_CHECK =
  process.env.CODEXUI_SKIP_GIT_CHECK === "1" || !fs.existsSync(path.join(REPO_ROOT_ABS, ".git"));

const HOME_DIR = os.homedir?.() ?? process.env.HOME ?? "";
const CODEX_CONFIG_PATH = process.env.CODEX_CONFIG || path.join(HOME_DIR, ".codex", "config.toml");
const CODEX_AUTH_PATH = process.env.CODEX_AUTH || path.join(HOME_DIR, ".codex", "auth.json");

function readDefaultModel() {
  try {
    if (!CODEX_CONFIG_PATH) return null;
    const contents = fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
    const match = contents.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function readDefaultEffort() {
  try {
    if (!CODEX_CONFIG_PATH) return null;
    const contents = fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
    const match = contents.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

const DEFAULT_MODEL = process.env.CODEXUI_MODEL || readDefaultModel() || null;
const DEFAULT_EFFORT = process.env.CODEXUI_EFFORT || readDefaultEffort() || null;
let activeModel = DEFAULT_MODEL;
let activeEffort = DEFAULT_EFFORT;
const EFFORT_OPTIONS = ["minimal", "low", "medium", "high"];
const FALLBACK_MODELS = [
  "gpt-5-codex",
  "o4",
  "o4-mini",
  "o3",
  "o1",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-mini"
];
const MODEL_CACHE_TTL_MS = Number(process.env.CODEXUI_MODEL_CACHE_MS || 5 * 60 * 1000);
let cachedModels = { list: null, fetchedAt: 0 };
let inflightModelFetch = null;

const app = express();
app.use(express.json());
app.use("/static", express.static("/opt/codexui/static"));

/** runId -> { prompt, lastDiff: string|null, commands: string[] } */
const RUNS = new Map();

const codex = new Codex(); // uses ~/.codex/config.toml & cached auth

let logStream;
try {
  logStream = fs.createWriteStream(LOG_PATH, { flags: "a" });
  console.log(`Logging Codex UI activity to ${LOG_PATH}`);
} catch (error) {
  console.error("Failed to open log file, falling back to console only", error);
  logStream = null;
}

function serializeLogData(data) {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function logRun(id, message, data) {
  const ts = new Date().toISOString();
  const serialized = serializeLogData(data);
  const line = `[${ts}] [run ${id}] ${message}${serialized ? ` — ${serialized}` : ""}`;
  console.log(line);
  logStream?.write(line + "\n");
}

function resolveRepoPath(relPath = "") {
  const normalized = typeof relPath === "string" ? relPath.replace(/^[/\\]+/, "") : "";
  const abs = path.resolve(REPO_ROOT_ABS, normalized || ".");
  const relative = path.relative(REPO_ROOT_ABS, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes repository");
  }
  return {
    abs,
    rel: relative === "" ? "" : relative.replace(/\\/g, "/")
  };
}

function getAccessToken() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (process.env.CODEX_API_KEY) return process.env.CODEX_API_KEY;
  try {
    const raw = fs.readFileSync(CODEX_AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.OPENAI_API_KEY || parsed.tokens?.access_token || null;
  } catch {
    return null;
  }
}

async function fetchModelsFromApi() {
  if (typeof fetch !== "function") return null;
  const token = getAccessToken();
  if (!token) return null;
  const controller = new AbortController();
  const timeoutMs = Number(process.env.CODEXUI_MODEL_FETCH_TIMEOUT_MS || 5000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      },
      signal: controller.signal
    });
    if (!resp.ok) {
      throw new Error(`Model request failed (${resp.status})`);
    }
    const payload = await resp.json();
    if (!payload || !Array.isArray(payload.data)) return null;
    const seen = new Set();
    for (const entry of payload.data) {
      const id = typeof entry?.id === "string" ? entry.id : null;
      if (!id) continue;
      if (id.startsWith("ft:")) continue;
      if (id.includes("deprecated")) continue;
      seen.add(id);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  } catch (error) {
    console.warn("Failed to fetch models", error instanceof Error ? error.message : error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getAvailableModels() {
  const now = Date.now();
  if (cachedModels.list && now - cachedModels.fetchedAt < MODEL_CACHE_TTL_MS) {
    return cachedModels.list;
  }
  if (!inflightModelFetch) {
    inflightModelFetch = (async () => {
      const remote = await fetchModelsFromApi();
      const combined = remote && remote.length ? remote : [];
      const defaults = FALLBACK_MODELS.filter(Boolean);
      const merged = Array.from(new Set([...combined, ...defaults])).sort((a, b) =>
        a.localeCompare(b)
      );
      cachedModels = { list: merged, fetchedAt: Date.now() };
      return merged;
    })()
      .catch(() => {
        const merged = Array.from(new Set(FALLBACK_MODELS));
        cachedModels = { list: merged, fetchedAt: Date.now() };
        return merged;
      })
      .finally(() => {
        inflightModelFetch = null;
      });
  }
  return inflightModelFetch;
}

async function serializeModelSettings() {
  const models = await getAvailableModels();
  return {
    model: activeModel,
    defaultModel: DEFAULT_MODEL,
    availableModels: models,
    effort: activeEffort,
    defaultEffort: DEFAULT_EFFORT,
    effortOptions: EFFORT_OPTIONS
  };
}

app.get("/", (_, res) => res.redirect("/static/index.html"));

app.post("/api/send", async (req, res) => {
  const prompt = String(req.body?.text ?? "");
  const runId = crypto.randomUUID();
  RUNS.set(runId, { prompt, lastDiff: null, commands: [] });
  logRun(runId, "Created run", {
    promptPreview: prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt
  });
  // return immediately; the stream will be started by /api/stream/:id
  res.json({ runId });
});

app.get("/api/stream/:id", async (req, res) => {
  const id = req.params.id;
  const entry = RUNS.get(id);
  if (!entry) return res.status(404).json({ error: "no such run" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.flushHeaders?.();

  const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const commandOutputState = new Map(); // itemId -> bytes flushed
  let clientClosed = false;

  logRun(id, "SSE stream opened");
  req.on("close", () => {
    if (!clientClosed) {
      clientClosed = true;
      logRun(id, "HTTP client disconnected; stopping Codex stream");
    }
  });

  const thread = codex.startThread({
    workingDirectory: REPO_ROOT,
    skipGitRepoCheck: SKIP_GIT_REPO_CHECK,
    model: activeModel || undefined,
    modelReasoningEffort: activeEffort || undefined
  });

  const handleCommandItem = (eventType, item) => {
    const existing = commandOutputState.get(item.id);
    if (!existing) {
      commandOutputState.set(item.id, { flushed: 0 });
      const cmdLine = item.command || "command";
      entry.commands.push(`$ ${cmdLine}`);
      send({ type: "tool.start", tool: { name: cmdLine, args: [] } });
    }
    const state = commandOutputState.get(item.id);
    const output = item.aggregated_output || "";
    if (state && output.length > state.flushed) {
      const chunk = output.slice(state.flushed);
      state.flushed = output.length;
      entry.commands.push(chunk);
      send({ type: "tool.stdout", text: chunk });
    }
    if (eventType === "item.completed") {
      send({
        type: "tool.end",
        tool: { name: item.command || "command", args: [] },
        exit_code: item.exit_code,
        status: item.status
      });
      commandOutputState.delete(item.id);
    }
  };

  const emitThinking = text => {
    if (!text) return;
    send({ type: "thinking", text });
  };
  const emitMessage = text => {
    if (!text) return;
    send({ type: "message", text });
  };
  const emitDiff = patch => {
    if (!patch) return;
    entry.lastDiff = patch;
    send({ type: "diff", diff: { patch } });
  };

  const translateEvent = ev => {
    switch (ev.type) {
      case "thread.started":
        logRun(id, "Thread started", { threadId: ev.thread_id });
        return true;
      case "turn.started":
        send({ type: "status", text: "Running…" });
        return true;
      case "turn.completed":
        logRun(id, "Turn completed", ev.usage);
        return true;
      case "turn.failed":
        throw new Error(ev.error?.message || "Codex turn failed");
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const item = ev.item;
        switch (item.type) {
          case "reasoning":
            emitThinking(item.text);
            break;
          case "agent_message":
            if (ev.type === "item.completed") emitMessage(item.text);
            break;
          case "command_execution":
            handleCommandItem(ev.type, item);
            break;
          case "file_change": {
            const patch =
              item.patch ||
              item.diff?.patch ||
              (Array.isArray(item.changes) ? item.changes.find(c => c.patch)?.patch : null);
            if (patch) {
              emitDiff(patch);
            }
            break;
          }
          case "error":
            send({ type: "message", text: item.message || "Agent error" });
            break;
          default:
            break;
        }
        return true;
      }
      case "error":
        throw new Error(ev.message || "Codex stream error");
      default:
        if (ev.type === "diff" && ev.diff?.patch) {
          emitDiff(ev.diff.patch);
          return true;
        }
        // Old SDK events passthrough for compatibility (UI ignores unknown types)
        if (ev.type && typeof ev.type === "string") {
          send(ev);
        }
        return true;
    }
  };

  try {
    const { events } = await thread.runStreamed(entry.prompt);
    const iterator = events[Symbol.asyncIterator]();
    while (true) {
      const { value, done } = await iterator.next();
      if (done || clientClosed) {
        if (clientClosed) await iterator.return?.();
        break;
      }
      try {
        translateEvent(value);
      } catch (err) {
        throw err;
      }
    }
    if (!clientClosed) {
      logRun(id, "Codex run completed");
      send({ type: "done" });
    }
  } catch (e) {
    logRun(id, "Codex run error", e instanceof Error ? e.stack || e.message : e);
    send({ type: "error", error: String(e instanceof Error ? e.message : e) });
  } finally {
    logRun(id, "SSE stream closing");
    res.end();
  }
});

/* Side panels */
app.get("/api/last-diff/:id", (req, res) => {
  res.json({ diff: RUNS.get(req.params.id)?.lastDiff || null });
});
app.get("/api/cmd-log/:id", (req, res) => {
  res.json({ commands: RUNS.get(req.params.id)?.commands || [] });
});

app.get("/api/model", async (_req, res) => {
  res.json(await serializeModelSettings());
});

app.post("/api/model", async (req, res) => {
  if ("model" in req.body) {
    const requested = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    activeModel = requested || null;
  }
  if ("effort" in req.body) {
    if (req.body?.effort === null || req.body?.effort === "") {
      activeEffort = null;
    } else if (typeof req.body?.effort === "string") {
      const normalized = req.body.effort.trim().toLowerCase();
      if (EFFORT_OPTIONS.includes(normalized)) {
        activeEffort = normalized;
      }
    }
  }
  logRun("model", "Model selection updated", {
    activeModel: activeModel || "(default)",
    defaultModel: DEFAULT_MODEL || "(none)",
    activeEffort: activeEffort || "(default)",
    defaultEffort: DEFAULT_EFFORT || "(none)"
  });
  res.json(await serializeModelSettings());
});

/* Apply latest diff with git (SDK provided the patch content) */
app.post("/api/apply/:id", async (req, res) => {
  const entry = RUNS.get(req.params.id);
  const patch = entry?.lastDiff;
  if (!patch) return res.json({ ok: false, output: "No diff available" });

  const tmp = path.join(REPO_ROOT, `.codexui-${crypto.randomUUID()}.patch`);
  try {
    fs.writeFileSync(tmp, patch, "utf8");
    const { spawn } = await import("node:child_process");
    const p = spawn("bash", ["-lc", `git apply --index '${tmp.replace(/'/g, `'\\''`)}'`], { cwd: REPO_ROOT });
    let out = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => out += d.toString());
    p.on("close", code => {
      try { fs.unlinkSync(tmp); } catch {}
      res.json({ ok: code === 0, output: out });
    });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    res.json({ ok: false, output: String(e) });
  }
});

/* Repository browsing APIs */
app.get("/api/list", (req, res) => {
  const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
  try {
    const { abs, rel } = resolveRepoPath(requestedPath);
    const entries = fs
      .readdirSync(abs, { withFileTypes: true })
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(dirent => ({ name: dirent.name, dir: dirent.isDirectory() }));

    res.json({ root: REPO_ROOT_ABS, path: rel, entries });
  } catch (error) {
    res.json({ root: REPO_ROOT_ABS, path: requestedPath, entries: [], error: String(error) });
  }
});

app.get("/api/read", (req, res) => {
  const requestedPath = req.query.path;
  if (typeof requestedPath !== "string" || !requestedPath) {
    return res.status(400).json({ error: "path is required" });
  }
  try {
    const { abs, rel } = resolveRepoPath(requestedPath);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Path is a directory" });
    }
    const content = fs.readFileSync(abs, "utf8");
    res.json({ path: rel, content });
  } catch (error) {
    res.status(400).json({ error: String(error) });
  }
});

app.post("/api/save", (req, res) => {
  const relPath = req.body?.path;
  if (typeof relPath !== "string" || !relPath) {
    return res.status(400).json({ ok: false, error: "path is required" });
  }
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  try {
    const { abs, rel } = resolveRepoPath(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    res.json({ ok: true, path: rel });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

app.listen(PORT, HOST, () =>
  console.log(`Codex UI (SDK streaming) on http://${HOST}:${PORT} — repo ${REPO_ROOT}`)
);
