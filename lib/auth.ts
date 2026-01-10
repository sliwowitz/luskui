import fs from "node:fs";

import { CODEX_AUTH_PATH } from "./config.js";

export interface CodexAuthData {
  token: string | null;
  accountId: string | null;
}

/**
 * Read and parse the Codex auth file
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
