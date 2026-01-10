/**
 * Shared utility functions for backend implementations.
 *
 * These utilities handle common tasks that are duplicated across backends:
 * - Extracting diff patches from markdown code blocks
 * - Formatting tool arguments for display
 * - Error message extraction
 */

/**
 * Extracts diff/patch content from markdown code blocks.
 * Used by Claude and Mistral backends to detect file changes in model responses.
 *
 * Matches code blocks with ```diff or ```patch language tags.
 */
export function extractDiffs(text: string): string[] {
  const matches: string[] = [];
  const regex = /```(?:diff|patch)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(text))) {
    if (match[1]) matches.push(match[1].trimEnd());
  }
  return matches;
}

/**
 * Formats tool input arguments for display in UI/logs.
 * Handles various input types from different backends:
 * - null/undefined -> []
 * - string -> [string] (with JSON parsing attempt)
 * - primitives -> [String(value)]
 * - objects/arrays -> [JSON.stringify(value)]
 *
 * Used by Mistral backend for tool execution display.
 */
export function formatToolArgs(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    // Try to parse as JSON for better formatting
    try {
      const parsed = JSON.parse(trimmed);
      return formatToolArgs(parsed);
    } catch {
      return [raw];
    }
  }

  if (typeof raw === "number" || typeof raw === "boolean") {
    return [String(raw)];
  }

  if (Array.isArray(raw) || typeof raw === "object") {
    try {
      return [JSON.stringify(raw, null, 2)];
    } catch {
      return [String(raw)];
    }
  }

  return [String(raw)];
}

/**
 * Formats tool input for Claude's simpler display format.
 * Claude uses key=value format for object entries.
 */
export function formatToolArgsForDisplay(input: unknown): string[] {
  if (input === null || typeof input === "undefined") return [];
  if (typeof input === "string") return [input];
  if (typeof input === "number" || typeof input === "boolean") return [String(input)];
  if (Array.isArray(input)) return input.map((entry) => String(entry));
  if (typeof input === "object") {
    return Object.entries(input as Record<string, unknown>).map(
      ([key, value]) => `${key}=${JSON.stringify(value)}`
    );
  }
  return [String(input)];
}

/**
 * Safely extracts an error message from an unknown error value.
 * Used throughout backends for consistent error handling.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
