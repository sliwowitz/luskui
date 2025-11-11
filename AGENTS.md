# Codex-in-Container: Agent + Local Web UI

This setup runs an **OpenAI Codex agent inside a Podman container** that also hosts a single project workspace. The pattern is:

* **One project per container**, mounted at:
  `/workspace/<projectname>`
* **Codex** operates inside that workspace directory, with shared auth/config in `~/.codex`.
* You can drive Codex **from the CLI** (interactive or `exec`) **or via the SDK** (programmatic, streaming events).
* The files in `/opt/codexgui` provide a **lightweight web UI** (SDK-powered) that mimics the “Codex Cloud” flow:
  discuss code, inspect thinking/command execution, and **export/apply diffs**.

This local UI is intentionally thin so you can iterate quickly **from within the same container** (e.g., launch Codex in a shell, have it modify `/opt/codexgui`, refresh the UI, repeat).

---

## Container Layout

* **Project root**: `/workspace/<projectname>`
  The UI treats this as its repository root (set by `REPO_ROOT` env).
* **Codex GUI** (this app): `/opt/codexgui`

  * `package.json` — JS dependencies and startup script
  * `server.js` — Express backend using **`@openai/codex-sdk`**
  * `static/` — Browser UI (HTML/JS/CSS, no build step)

**Shared auth/config**: `~/.codex` (mounted volume) is used by both CLI and SDK.

---

## How the Local UI Works

* The **browser** hits the Express server in this container.
* The server uses **`@openai/codex-sdk`** to start a **streamed run** bound to `REPO_ROOT`.
* It forwards **structured events** over **SSE** to the browser:

  * `thinking` — model’s internal reasoning (rendered collapsible)
  * `message` — final/user-facing content (Markdown)
  * `tool.*` — commands Codex runs (shown live in a “Commands” tab)
  * `diff` — unified patches Codex proposes (shown in a “Diffs” tab)
  * `done` — end of turn
* The UI can **apply the last diff** via the backend using `git apply --index`.

This mirrors the Cloud UI workflow, but the agent edits **your local workspace** directly.

---

## Files in `/opt/codexgui`

### 1) `package.json`

**Purpose:** declares runtime deps and how to start the server.

* **Key dependencies:**

  * `@openai/codex-sdk` — official SDK used to start runs and stream events
  * `express` — minimal HTTP server (REST + SSE)
* **No bundlers/build steps** required. Everything runs as-is with Node.

What you might change:

* Pin/upgrade the SDK version.
* Add small libs (e.g., a nicer diff renderer) without changing the server.

---

### 2) `server.js`

**Purpose:** the backend that **bridges Codex SDK ⇄ Browser UI**.

Responsibilities:

* **Config/env**

  * `REPO_ROOT` (default `/workspace`) — project directory Codex works in
  * `HOST` (default `0.0.0.0`) and `PORT` (default `7860`) — server binding

* **Static files**

  * Serves `/static/` (the web UI) as-is

* **Session management**

  * Creates a **run** per user request (`/api/send`)
  * Streams Codex **events** over **SSE** (`/api/stream/:id`)
  * Keeps transient state: last diff (patch), recent command log

* **API surface (SDK-only)**

  * `POST /api/send` → `{ runId }`
    Allocates a run & stores the prompt (returns immediately).
  * `GET /api/stream/:id` (SSE)
    Uses `codex.runStreamed({ prompt, cwd: REPO_ROOT })` to forward events:

    * `thinking` (collapsed in UI)
    * `message` (Markdown answer)
    * `tool.start|tool.stdout|tool.stderr|tool.end`
    * `diff` (stores latest patch)
    * `done` or `error`
  * `GET /api/cmd-log/:id` → `{ commands: [...] }`
    Returns collected command lines/stdout/stderr for the run.
  * `GET /api/last-diff/:id` → `{ diff: <unified patch or null> }`
  * `POST /api/apply/:id` → `{ ok, output }`
    Writes the stored patch to a temp file and runs `git apply --index` (stages changes on success).

* **Repository endpoints (for the left file-pane)**

  * `GET /api/list?path=` → `{ root, path, entries: [{name,dir}], error? }`
  * `GET /api/read?path=...`
  * `POST /api/save` with `{ path, content }`

Design notes:

* **SSE** keeps the browser responsive and tolerant of long runs.
* The server tries to **never 404** the repo listing; on errors, it returns `entries: []` and a message (the UI can retry).
* “Apply last diff” is **opt-in** and uses `git apply --index` so your staging area reflects changes.

---

### 3) `static/` (Web UI)

**Purpose:** A small, framework-free browser UI.

Main pieces inside:

* `index.html`

  * **Chat** pane:

    * User’s prompts (right-aligned bubble)
    * Codex outputs grouped by **thinking** (collapsible) and **codex** (answer), rendered as **Markdown**
  * **Commands** tab:

    * Live stream of `tool.*` events (shell commands + stdout/stderr)
  * **Diffs** tab:

    * Shows the latest `diff` patch; **Apply Last Diff** button triggers `/api/apply/:id`
  * **Repo pane** (left side):

    * Directory tree rooted at `REPO_ROOT`
    * Quick viewer/editor (simple modal for now)
  * Small script adds:

    * SSE client (connects to `/api/stream/:id`)
    * Markdown rendering (`marked.min.js`)
    * Minimal retry/error banners for robustness

What you might change:

* Nicer code/diff highlighting.
* A proper editor (Monaco) instead of `prompt()` for file edits.
* A run history pane with “resume” and “compare” actions.

---

## Typical Workflow (Inside This Container)

1. **Mount the project** under `/workspace/<projectname>`.
   Ensure `REPO_ROOT=/workspace/<projectname>` for the UI container.

2. **Auth/config** are mounted to `/home/dev/.codex` (shared with CLI).
   The SDK reads `~/.codex/config.toml` so your model/profile/approval settings apply here too.

3. **Open the UI**: [http://localhost:7860](http://localhost:7860)

   * Type a prompt: *“Summarize the architecture”* / *“Add a unit test for X”* / *“Refactor Y to use std::mdspan”*
   * Watch **thinking**, **commands**, and **diffs** stream in live
   * Click **Apply Last Diff** to stage changes

4. **Iterate quickly**:
   Keep a terminal in the same container to:

   * run `git status`, `git diff`
   * run `codex` CLI directly when you want line-by-line control
   * have Codex modify `/opt/codexgui` and then refresh the browser

---

## Using Codex from the Container Shell (Optional)

* **Interactive**: `codex -C /workspace/<projectname>`
* **One-shot**: `codex exec -C /workspace/<projectname> "Write a Catch2 test for Vector::push_back"`
* **Apply** last diff: `codex apply`

Both CLI and SDK share the same config/auth. You can freely switch between them.

---

## Permissions & Safety

* The UI writes only under `REPO_ROOT` (server guards against path traversal).
* Diffs are applied via `git apply --index`; if the patch doesn’t apply, you’ll get stderr in the UI.
* For shells/commands, the UI **only displays** what Codex runs; execution happens within the SDK’s tool calls (subject to your `~/.codex/config.toml` policy: model, sandboxing, approvals).

---

## Roadmap / Nice-to-haves

* Diff viewer with side-by-side rendering (e.g., diff2html)
* Per-run history: timestamps, prompts, applied patches
* Buttons for model/profile toggles (saved back to `~/.codex/config.toml`)
* Multi-file patch preview with selective apply

---

*This document is meant for the agent (and humans!) working **inside** the container to understand the moving parts quickly and modify the UI safely. The intent is to keep everything small, hackable, and easy to iterate with Codex itself.*

