import express, { type Request, type Response } from 'express';
import {
  Codex,
  type CommandExecutionItem,
  type FileChangeItem,
  type ModelReasoningEffort,
  type ThreadEvent,
} from '@openai/codex-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import {
  REPO_ROOT,
  HOST,
  PORT,
  REPO_ROOT_ABS,
  SKIP_GIT_REPO_CHECK,
  resolveRepoPath,
} from './lib/config.js';
import { logRun } from './lib/logging.js';
import {
  createRun,
  getRun,
  appendCommandLog,
  setLastDiff,
  getLastDiff,
  getCommands,
} from './lib/runStore.js';
import {
  getModelSettings,
  getActiveModel,
  getActiveEffort,
  updateModelSelection,
  type ModelSelectionInput,
} from './lib/models.js';

type ServerSentEvent = Record<string, unknown> & { type?: string };

interface CommandOutputState {
  flushed: number;
}

type FileChangeEntryWithPatch = FileChangeItem['changes'][number] & { patch?: string | null };

type FileChangeWithPatch = Omit<FileChangeItem, 'changes'> & {
  patch?: string | null;
  diff?: { patch?: string | null };
  changes: FileChangeEntryWithPatch[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, 'static');

const app = express();
app.use(express.json());
app.use('/static', express.static(staticDir));

const codex = new Codex();

app.get('/', (_, res) => res.redirect('/static/index.html'));

app.post('/api/send', async (req: Request, res: Response) => {
  const prompt = String(req.body?.text ?? '');
  const runId = createRun(prompt);
  logRun(runId, 'Created run', {
    promptPreview: prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt,
  });
  res.json({ runId });
});

app.get('/api/stream/:id', async (req: Request, res: Response) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'missing run id' });
  const run = getRun(id);
  if (!run) return res.status(404).json({ error: 'no such run' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.flushHeaders?.();

  const send = (payload: ServerSentEvent): void => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const commandOutputState = new Map<string, CommandOutputState>();
  let clientClosed = false;

  logRun(id, 'SSE stream opened');
  req.on('close', () => {
    if (!clientClosed) {
      clientClosed = true;
      logRun(id, 'HTTP client disconnected; stopping Codex stream');
    }
  });

  const thread = codex.startThread({
    workingDirectory: REPO_ROOT,
    skipGitRepoCheck: SKIP_GIT_REPO_CHECK,
    sandboxMode: 'danger-full-access',
    networkAccessEnabled: true,
    approvalPolicy: 'never',
    model: getActiveModel() || undefined,
    modelReasoningEffort: (getActiveEffort() || undefined) as ModelReasoningEffort | undefined,
  });

  const handleCommandItem = (eventType: string, item: CommandExecutionItem): void => {
    if (typeof item.id !== 'string') return;
    const existing = commandOutputState.get(item.id);
    if (!existing) {
      commandOutputState.set(item.id, { flushed: 0 });
      const cmdLine = item.command || 'command';
      appendCommandLog(id, `$ ${cmdLine}`);
      send({ type: 'tool.start', tool: { name: cmdLine, args: [] } });
    }
    const state = commandOutputState.get(item.id);
    const output = item.aggregated_output || '';
    if (state && output.length > state.flushed) {
      const chunk = output.slice(state.flushed);
      state.flushed = output.length;
      appendCommandLog(id, chunk);
      send({ type: 'tool.stdout', text: chunk });
    }
    if (eventType === 'item.completed') {
      send({
        type: 'tool.end',
        tool: { name: item.command || 'command', args: [] },
        exit_code: item.exit_code,
        status: item.status,
      });
      commandOutputState.delete(item.id);
    }
  };

  const emitThinking = (text?: string | null): void => {
    if (!text) return;
    send({ type: 'thinking', text });
  };
  const emitMessage = (text?: string | null): void => {
    if (!text) return;
    send({ type: 'message', text });
  };
  const emitDiff = (patch?: string | null): void => {
    if (!patch) return;
    setLastDiff(id, patch);
    send({ type: 'diff', diff: { patch } });
  };

  const translateEvent = (raw: unknown): boolean => {
    const ev = raw as ThreadEvent;
    switch (ev.type) {
      case 'thread.started':
        logRun(id, 'Thread started', { threadId: ev.thread_id });
        return true;
      case 'turn.started':
        send({ type: 'status', text: 'Running…' });
        return true;
      case 'turn.completed':
        logRun(id, 'Turn completed', ev.usage);
        return true;
      case 'turn.failed':
        throw new Error(ev.error?.message || 'Codex turn failed');
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const item = ev.item;
        if (!item) return true;
        switch (item.type) {
          case 'reasoning':
            emitThinking(item.text);
            break;
          case 'agent_message':
            if (ev.type === 'item.completed') emitMessage(item.text);
            break;
          case 'command_execution':
            handleCommandItem(ev.type, item);
            break;
          case 'file_change': {
            const fileChange = item as FileChangeWithPatch;
            const patch =
              fileChange.patch ||
              fileChange.diff?.patch ||
              (Array.isArray(fileChange.changes)
                ? fileChange.changes.find((change) => change.patch)?.patch || null
                : null);
            if (patch) {
              emitDiff(patch);
            }
            break;
          }
          case 'error':
            send({ type: 'message', text: item.message || 'Agent error' });
            break;
          default:
            break;
        }
        return true;
      }
      case 'error':
        throw new Error(ev.message || 'Codex stream error');
      default: {
        const fallback = raw as { type?: string; diff?: { patch?: string } };
        if (fallback.type === 'diff' && fallback.diff?.patch) {
          emitDiff(fallback.diff.patch);
          return true;
        }
        if (fallback.type && typeof fallback.type === 'string') {
          send(fallback as ServerSentEvent);
        }
        return true;
      }
    }
  };

  try {
    const { events } = (await thread.runStreamed(run.prompt)) as { events: AsyncIterable<unknown> };
    const iterator = events[Symbol.asyncIterator]();
    while (true) {
      const { value, done } = await iterator.next();
      if (done || clientClosed) {
        if (clientClosed) await iterator.return?.();
        break;
      }
      translateEvent(value);
    }
    if (!clientClosed) {
      logRun(id, 'Codex run completed');
      send({ type: 'done' });
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    logRun(id, 'Codex run error', e instanceof Error ? e.stack || errorMessage : e);
    send({ type: 'error', error: errorMessage });
  } finally {
    logRun(id, 'SSE stream closing');
    res.end();
  }
});

app.get('/api/last-diff/:id', (req, res) => {
  res.json({ diff: getLastDiff(req.params.id) });
});
app.get('/api/cmd-log/:id', (req, res) => {
  res.json({ commands: getCommands(req.params.id) });
});

app.get('/api/model', async (_req, res) => {
  res.json(await getModelSettings());
});

app.post('/api/model', async (req, res) => {
  updateModelSelection((req.body || {}) as ModelSelectionInput);
  const settings = await getModelSettings();
  logRun('model', 'Model selection updated', {
    activeModel: settings.model || '(default)',
    defaultModel: settings.defaultModel || '(none)',
    activeEffort: settings.effort || '(default)',
    defaultEffort: settings.defaultEffort || '(none)',
  });
  res.json(settings);
});

app.post('/api/apply/:id', async (req, res) => {
  const patch = getLastDiff(req.params.id);
  if (!patch) return res.json({ ok: false, output: 'No diff available' });

  const tmp = path.join(REPO_ROOT, `.codexui-${crypto.randomUUID()}.patch`);
  try {
    fs.writeFileSync(tmp, patch, 'utf8');
    const { spawn } = await import('node:child_process');
    const p = spawn('bash', ['-lc', `git apply --index '${tmp.replace(/'/g, `'\\''`)}'`], {
      cwd: REPO_ROOT,
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      res.json({ ok: code === 0, output: out });
    });
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    res.json({ ok: false, output: String(e) });
  }
});

app.get('/api/list', (req, res) => {
  const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
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

app.get('/api/read', (req, res) => {
  const requestedPath = req.query.path;
  if (typeof requestedPath !== 'string' || !requestedPath) {
    return res.status(400).json({ error: 'path is required' });
  }
  try {
    const { abs, rel } = resolveRepoPath(requestedPath);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory' });
    }
    const content = fs.readFileSync(abs, 'utf8');
    res.json({ path: rel, content });
  } catch (error) {
    res.status(400).json({ error: String(error) });
  }
});

app.post('/api/save', (req, res) => {
  const relPath = req.body?.path;
  if (typeof relPath !== 'string' || !relPath) {
    return res.status(400).json({ ok: false, error: 'path is required' });
  }
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  try {
    const { abs, rel } = resolveRepoPath(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    res.json({ ok: true, path: rel });
  } catch (error) {
    res.status(400).json({ ok: false, error: String(error) });
  }
});

app.listen(PORT, HOST, () =>
  console.log(`Codex UI (SDK streaming) on http://${HOST}:${PORT} — repo ${REPO_ROOT}`),
);
