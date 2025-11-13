import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "static", "index.html"), "utf8");
const THEME_KEY = "codexui-theme";

const inlineScripts = (() => {
  const { document } = parseHTML(indexHtml);
  return [...document.querySelectorAll("script")]
    .filter((script) => !script.getAttribute("src"))
    .map((script) => script.textContent);
})();

function extractRule(pattern) {
  return new RegExp(pattern, "i").test(indexHtml);
}

test("commands pane keeps monospace styling declarations", () => {
  assert.ok(
    extractRule("#commands\\s*{[^}]*font-family:[^}]*monospace"),
    "commands pane should enforce a monospace font family"
  );
  assert.ok(
    extractRule("\\.cmd\\s*{[^}]*white-space:\\s*pre-wrap"),
    "individual command blocks should preserve whitespace"
  );
});

test("appendCommandBlock renders <pre> entries with matching classes", async () => {
  const { context, document } = await bootstrapUi();
  context.appendCommandBlock("echo test", "start");
  context.appendCommandBlock("done", "output");
  const blocks = [...document.querySelectorAll("#commands pre")];
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].className, "cmd cmd-start");
  assert.equal(blocks[0].textContent, "echo test");
  assert.equal(blocks[1].className, "cmd cmd-output");
  assert.equal(blocks[1].textContent, "done");
});

test("theme toggle cycles preferences and persists manual selection", async () => {
  const { document, context, localStorage } = await bootstrapUi({ prefersDark: true });
  const button = document.getElementById("themeToggle");
  assert.equal(button.textContent, "Theme: Auto (Dark)");
  button.dispatchEvent(new context.window.Event("click"));
  assert.equal(document.documentElement.getAttribute("data-theme"), "light");
  assert.equal(localStorage.getItem(THEME_KEY), "light");
  assert.equal(button.textContent, "Theme: Light");
  button.dispatchEvent(new context.window.Event("click"));
  assert.equal(document.documentElement.getAttribute("data-theme"), null);
  assert.equal(localStorage.getItem(THEME_KEY), null);
  assert.equal(button.textContent, "Theme: Auto (Dark)");
});

test("stored theme preference is applied immediately on load", async () => {
  const { document, localStorage } = await bootstrapUi({ storedTheme: "dark", prefersDark: false });
  const button = document.getElementById("themeToggle");
  assert.equal(localStorage.getItem(THEME_KEY), "dark");
  assert.equal(document.documentElement.getAttribute("data-theme"), "dark");
  assert.equal(button.textContent, "Theme: Dark");
});

test("auto theme label updates when system preference changes", async () => {
  const { document, themeMediaMock, context } = await bootstrapUi({ prefersDark: false });
  const button = document.getElementById("themeToggle");
  assert.equal(button.textContent, "Theme: Auto (Light)");
  themeMediaMock.dispatchChange(true);
  await nextTick();
  assert.equal(button.textContent, "Theme: Auto (Dark)");
  button.dispatchEvent(new context.window.Event("click"));
  themeMediaMock.dispatchChange(false);
  await nextTick();
  assert.equal(button.textContent, "Theme: Light", "manual preference should block auto updates");
});

function createLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    }
  };
}

function createThemeMediaMock(prefersDark = false) {
  let matches = !!prefersDark;
  const listeners = new Set();
  return {
    get matches() {
      return matches;
    },
    addEventListener(event, cb) {
      if (event === "change") listeners.add(cb);
    },
    removeEventListener(event, cb) {
      if (event === "change") listeners.delete(cb);
    },
    dispatchChange(nextValue) {
      matches = !!nextValue;
      listeners.forEach((cb) => cb({ matches }));
    }
  };
}

async function bootstrapUi({ storedTheme = null, prefersDark = false } = {}) {
  const { window, document } = parseHTML(indexHtml);
  const localStorage = createLocalStorage(storedTheme ? { [THEME_KEY]: storedTheme } : {});
  Object.defineProperty(window, "localStorage", { value: localStorage, configurable: true });
  const promptStub = () => null;
  const optionCtor =
    window.Option ||
    function Option(text, value = "") {
      const el = document.createElement("option");
      el.textContent = text;
      el.value = value;
      return el;
    };
  window.prompt = promptStub;
  window.Option = optionCtor;

  const themeMediaMock = createThemeMediaMock(prefersDark);
  window.matchMedia = () => themeMediaMock;

  let currentSettings = {
    model: null,
    defaultModel: "gpt-4o",
    effort: null,
    defaultEffort: "medium",
    availableModels: ["gpt-4o-mini"],
    effortOptions: ["minimal", "low", "medium", "high"]
  };

  window.fetch = async (url, options = {}) => {
    if (url.startsWith("/api/model")) {
      if ((options.method || "GET").toUpperCase() === "POST") {
        const body = options.body ? JSON.parse(options.body) : {};
        if (Object.prototype.hasOwnProperty.call(body, "model")) {
          currentSettings = { ...currentSettings, model: body.model || null };
        }
        if (Object.prototype.hasOwnProperty.call(body, "effort")) {
          currentSettings = { ...currentSettings, effort: body.effort || null };
        }
      }
      return makeResponse(currentSettings);
    }
    if (url.startsWith("/api/list")) return makeResponse({ entries: [] });
    if (url.startsWith("/api/apply")) return makeResponse({ ok: true, output: "" });
    if (url.startsWith("/api/send")) return makeResponse({ runId: "test-run" });
    return makeResponse({});
  };

  window.EventSource = class {
    constructor() {
      throw new Error("EventSource should not be constructed in tests");
    }
    close() {}
  };

  const context = {
    window,
    document,
    console,
    localStorage,
    fetch: window.fetch,
    EventSource: window.EventSource,
    matchMedia: window.matchMedia,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Option: window.Option,
    prompt: window.prompt
  };
  context.globalThis = context;
  vm.createContext(context);
  inlineScripts.forEach((code, idx) => vm.runInContext(code, context, { filename: `inline-script-${idx}.js` }));
  await nextTick();
  return { window, document, context, themeMediaMock, localStorage };
}

function makeResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    }
  };
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}
