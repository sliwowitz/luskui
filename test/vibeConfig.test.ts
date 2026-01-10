import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { REPO_ROOT_ABS } from "../lib/config.js";
import { clearVibeConfigCache, getVibeConfig } from "../lib/vibeConfig.js";

type Backup = {
  existed: boolean;
  contents: string | null;
};

function backupFile(filePath: string): Backup {
  if (!fs.existsSync(filePath)) {
    return { existed: false, contents: null };
  }
  return { existed: true, contents: fs.readFileSync(filePath, "utf8") };
}

function restoreFile(filePath: string, backup: Backup): void {
  if (backup.existed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, backup.contents ?? "", "utf8");
    return;
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const repoConfigPath = path.join(REPO_ROOT_ABS, ".vibe", "config.toml");
const userConfigPath = path.join(os.homedir(), ".vibe", "config.toml");

let repoBackup: Backup;
let userBackup: Backup;

test.beforeEach(() => {
  repoBackup = backupFile(repoConfigPath);
  userBackup = backupFile(userConfigPath);
  clearVibeConfigCache();
});

test.afterEach(() => {
  restoreFile(repoConfigPath, repoBackup);
  restoreFile(userConfigPath, userBackup);
  clearVibeConfigCache();
});

test("getVibeConfig prefers repo config over user config", () => {
  ensureDir(repoConfigPath);
  ensureDir(userConfigPath);

  fs.writeFileSync(repoConfigPath, 'active_model = "repo-model"\n', "utf8");
  fs.writeFileSync(userConfigPath, 'active_model = "user-model"\n', "utf8");

  const config = getVibeConfig();
  assert.equal(config?.active_model, "repo-model");
});

test("getVibeConfig parses expected fields", () => {
  ensureDir(repoConfigPath);
  fs.writeFileSync(
    repoConfigPath,
    [
      'active_model = "active-model"',
      'models = ["alpha", "beta"]',
      'enabled_tools = ["tool-a"]',
      'disabled_tools = ["tool-b"]',
      "",
      "[providers]",
      'openai = "enabled"',
      "",
      "[tools.mytool]",
      'permissions = ["read"]',
      ""
    ].join("\n"),
    "utf8"
  );

  const config = getVibeConfig();
  assert.equal(config?.active_model, "active-model");
  assert.deepEqual(config?.models, ["alpha", "beta"]);
  assert.deepEqual(config?.enabled_tools, ["tool-a"]);
  assert.deepEqual(config?.disabled_tools, ["tool-b"]);
  assert.equal((config?.providers as Record<string, string>)?.openai, "enabled");
  assert.deepEqual(config?.tools?.mytool?.permissions, ["read"]);
});
