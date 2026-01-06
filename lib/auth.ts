import fs from "node:fs";

import { CODEX_AUTH_PATH } from "./config.js";

export function getAccessToken(): string | null {
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
