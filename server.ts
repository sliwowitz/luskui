import express, { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { hydrateEnv } from "./lib/env.js";
import {
  REPO_ROOT,
  HOST,
  PORT,
  REPO_ROOT_ABS,
  SKIP_GIT_REPO_CHECK,
  resolveRepoPath
} from "./lib/config.js";
import { logRun } from "./lib/logging.js";
import {
  createRun,
  getRun,
  appendCommandLog,
  setLastDiff,
  getLastDiff,
  getCommands
} from "./lib/runStore.js";
import { getBackend } from "./lib/backends/index.js";
import type { BackendEvent, ModelSelectionPayload } from "./lib/backends/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, "static");

hydrateEnv();

const app = express();
app.use(express.json());
app.use("/static", express.static(staticDir));
const backend = getBackend({
  workingDirectory: REPO_ROOT,
  skipGitRepoCheck: SKIP_GIT_REPO_CHECK,
  sandboxMode: "danger-full-access",
  networkAccessEnabled: true,
  approvalPolicy: "never"
});

app.get("/", (_req: Request, res: Response) => res.redirect("/static/index.html"));

app.post("/api/send", async (req: Request, res: Response) => {
  const body = req.body as { text?: unknown };
  const prompt = String(body?.text ?? "");
  const runId = createRun(prompt);
  logRun(runId, "Created run", {
    promptPreview: prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt
  });
  res.json({ runId });
});

app.get("/api/stream/:id", async (req: Request, res: Response) => {
  const id = req.params.id;
  const run = getRun(id);
  if (!run) return res.status(404).json({ error: "no such run" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.flushHeaders?.();

  const send = (payload: unknown): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  let clientClosed = false;

  logRun(id, "SSE stream opened");
  req.on("close", () => {
    if (!clientClosed) {
      clientClosed = true;
      logRun(id, `HTTP client disconnected; stopping ${backend.name} stream`);
    }
  });

  const handleBackendEvent = (event: BackendEvent): void => {
    switch (event.type) {
      case "tool.start":
        appendCommandLog(id, `$ ${event.tool.name}`);
        send(event);
        return;
      case "tool.stdout":
      case "tool.stderr":
        appendCommandLog(id, event.text);
        send(event);
        return;
      case "tool.end":
        send(event);
        return;
      case "diff":
        setLastDiff(id, event.diff.patch);
        send(event);
        return;
      default:
        send(event);
    }
  };

  try {
    const events = await backend.streamRun(run.prompt);
    const iterator = events[Symbol.asyncIterator]();
    while (true) {
      const { value, done } = await iterator.next();
      if (done || clientClosed) {
        if (clientClosed) await iterator.return?.();
        break;
      }
      handleBackendEvent(value);
    }
    if (!clientClosed) {
      logRun(id, `${backend.name} run completed`);
      send({ type: "done" });
    }
  } catch (e) {
    logRun(id, `${backend.name} run error`, e instanceof Error ? e.stack || e.message : e);
    send({ type: "error", error: String(e instanceof Error ? e.message : e) });
  } finally {
    logRun(id, "SSE stream closing");
    res.end();
  }
});

app.get("/api/last-diff/:id", (req: Request, res: Response) => {
  res.json({ diff: getLastDiff(req.params.id) });
});
app.get("/api/cmd-log/:id", (req: Request, res: Response) => {
  res.json({ commands: getCommands(req.params.id) });
});

app.get("/api/model", async (_req: Request, res: Response) => {
  res.json(await backend.getModelSettings());
});

app.post("/api/model", async (req: Request, res: Response) => {
  backend.updateModelSelection(req.body as ModelSelectionPayload);
  const settings = await backend.getModelSettings();
  logRun("model", "Model selection updated", {
    activeModel: settings.model || "(default)",
    defaultModel: settings.defaultModel || "(none)",
    activeEffort: settings.effort || "(default)",
    defaultEffort: settings.defaultEffort || "(none)"
  });
  res.json(settings);
});

app.post("/api/apply/:id", async (req: Request, res: Response) => {
  const patch = getLastDiff(req.params.id);
  if (!patch) return res.json({ ok: false, output: "No diff available" });

  const tmp = path.join(REPO_ROOT, `.codexui-${crypto.randomUUID()}.patch`);
  try {
    fs.writeFileSync(tmp, patch, "utf8");
    const { spawn } = await import("node:child_process");
    const p = spawn("bash", ["-lc", `git apply --index '${tmp.replace(/'/g, "'\\''")}'`], {
      cwd: REPO_ROOT
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // ignore
      }
      res.json({ ok: code === 0, output: out });
    });
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    res.json({ ok: false, output: String(e) });
  }
});

app.get("/api/list", (req: Request, res: Response) => {
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
      .map((dirent) => ({ name: dirent.name, dir: dirent.isDirectory() }));

    res.json({ root: REPO_ROOT_ABS, path: rel, entries });
  } catch (error) {
    res.json({ root: REPO_ROOT_ABS, path: requestedPath, entries: [], error: String(error) });
  }
});

app.get("/api/read", (req: Request, res: Response) => {
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

app.post("/api/save", (req: Request, res: Response) => {
  const body = req.body as { path?: unknown; content?: unknown };
  const relPath = body?.path;
  if (typeof relPath !== "string" || !relPath) {
    return res.status(400).json({ ok: false, error: "path is required" });
  }
  const content = typeof body?.content === "string" ? body.content : "";
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
  console.log(`Agent UI (SDK streaming) on http://${HOST}:${PORT} — repo ${REPO_ROOT}`)
);
