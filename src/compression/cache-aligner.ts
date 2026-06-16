/**
 * CacheAligner — prefix stabilization for Anthropic/OpenAI prompt caching.
 *
 * Moves dynamic content (dates, session IDs, timestamps) from the system
 * prompt prefix to a tail block, keeping the static prefix stable across
 * turns for better prompt cache hit rates.
 *
 * Algorithm:
 *  1. Find system message(s)
 *  2. Split lines into static and dynamic
 *  3. Reassemble: static prefix + `[Dynamic Context]` tail block
 *
 * Overhead: sub-millisecond regex pass per system message.
 */
import type { AgentMessage } from "../agents/runtime/index.js";

/** Patterns that indicate dynamic content in a system prompt */
const DYNAMIC_PATTERNS = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO timestamps (most specific first)
  /\d{4}-\d{2}-\d{2}/, // ISO dates
  /sess_[a-f0-9]{6,}/, // Session IDs
  /\d{13,}/, // Unix timestamps in ms (>10 digits)
  /run_[a-z0-9]{6,}/, // Run IDs
  /\b[A-Z][a-z]+ [A-Z][a-z]+ \d{1,2},?\s*\d{4}\b/, // Human-readable dates ("June 7, 2026")
];

/** Lines that are structural separators (don't count as dynamic-only) */
const SEPARATOR_RE = /^\s*(---+|===+|```|#)\s*$/;

/**
 * Check if a line is dynamic (contains volatile content that changes per turn).
 * Pure separators and blank lines are never classified as dynamic.
 */
function isDynamicLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (SEPARATOR_RE.test(trimmed)) {
    return false;
  }
  return DYNAMIC_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Rearrange system message content to stabilize the prefix.
 * Static lines stay at the top, dynamic lines move to a `[Dynamic Context]` tail block.
 *
 * Returns a new messages array. Does not mutate the input.
 * Only restructures system messages — all other roles pass through unchanged.
 */
export function alignCachePrefix(messages: AgentMessage[]): AgentMessage[] {
  let modified = false;
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== "system") {
      result.push(msg);
      continue;
    }

    const content = extractSystemContent(msg);
    if (!content) {
      result.push(msg);
      continue;
    }

    const lines = content.split("\n");
    const staticLines: string[] = [];
    const dynamicLines: string[] = [];

    for (const line of lines) {
      if (isDynamicLine(line)) {
        dynamicLines.push(line);
      } else {
        staticLines.push(line);
      }
    }

    // If no dynamic lines or all lines are dynamic, passthrough
    if (dynamicLines.length === 0 || staticLines.length === 0) {
      result.push(msg);
      continue;
    }

    // Reassemble: static prefix + dynamic tail
    const realigned =
      staticLines.join("\n").trimEnd() + "\n\n---\n[Dynamic Context]\n" + dynamicLines.join("\n");

    result.push(replaceSystemContent(msg, realigned));
    modified = true;
  }

  return modified ? result : messages;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSystemContent(msg: AgentMessage): string | null {
  if (!("content" in msg) || !msg.content) {
    return null;
  }
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part: unknown) => {
        if (typeof part === "object" && part !== null && "text" in part) {
          return String((part as { text: string }).text);
        }
        return "";
      })
      .join("\n");
  }
  return null;
}

function replaceSystemContent(msg: AgentMessage, newContent: string): AgentMessage {
  if (typeof msg.content === "string") {
    return { ...msg, content: newContent };
  }
  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: [{ type: "text" as const, text: newContent }],
    };
  }
  return msg;
}
