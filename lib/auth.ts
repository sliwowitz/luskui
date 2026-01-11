/**
 * Codex CLI authentication helpers.
 *
 * Reads authentication credentials from:
 * 1. Environment variables (OPENAI_API_KEY, CODEX_API_KEY)
 * 2. Codex CLI auth file (~/.codex/auth.json)
 *
 * The auth file is created by the Codex CLI's login flow and contains
 * OAuth tokens for ChatGPT API access. This enables using the same
 * authentication as the CLI without separate API key management.
 */
import fs from "node:fs";

import { CODEX_AUTH_PATH } from "./config.js";

export interface CodexAuthData {
  token: string | null;
  accountId: string | null;
}

/**
 * Read and parse the Codex CLI auth file.
 * Returns null if file doesn't exist or isn't valid JSON.
 */
function readAuthFile(): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(CODEX_AUTH_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Get Codex CLI authentication data (access token and account ID)
 */
export function getCodexAuth(): CodexAuthData {
  const parsed = readAuthFile();
  if (!parsed) {
    return { token: null, accountId: null };
  }

  const tokens = parsed.tokens as { access_token?: string; account_id?: string } | undefined;
  const token = typeof tokens?.access_token === "string" ? tokens.access_token : null;
  const accountId =
    typeof parsed.account_id === "string"
      ? parsed.account_id
      : typeof tokens?.account_id === "string"
        ? tokens.account_id
        : null;

  return { token, accountId };
}

/**
 * Get OpenAI API access token from environment or auth file
 */
export function getAccessToken(): string | null {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  if (process.env.CODEX_API_KEY) return process.env.CODEX_API_KEY;

  const parsed = readAuthFile();
  if (!parsed) return null;

  const tokens = parsed.tokens as { access_token?: string } | undefined;
  return (
    (typeof parsed.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null) ||
    (typeof tokens?.access_token === "string" ? tokens.access_token : null)
  );
}
