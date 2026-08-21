/**
 * TokenBudgetEnforcer — final trim pass to fit within token budget.
 *
 * If compressed messages still exceed the token budget, drops lowest-value
 * messages in priority order:
 *  1. Oldest tool results (recoverable via CCR)
 *  2. Oldest conversation turns
 *  3. Never drops: system prompt, current user message
 *
 * Scoring dimensions:
 *  - Recency — newer messages score higher
 *  - Error presence — messages with errors/stack traces score higher
 *  - Tool-result density — tool results have medium base priority
 *  - Forward references — messages referenced by later messages score higher
 *  - Temporal anchors — messages carrying explicit dates/times score higher
 *    (temporal grounding is hard to reconstruct and drives later retrieval)
 *
 * Rough token estimate: 1 token ≈ 4 chars (English text average).
 */
import type { AgentMessage } from "../agents/runtime/index.js";
import { hasTemporalAnchor } from "./temporal.js";
import type { CompressionConfig } from "./types.js";

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count for a string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for an AgentMessage.
 */
export function estimateMessageTokens(msg: AgentMessage): number {
  if ("content" in msg && msg.content) {
    if (typeof msg.content === "string") {
      return estimateTokens(msg.content);
    }
    if (Array.isArray(msg.content)) {
      return msg.content.reduce((sum: number, part: unknown) => {
        if (typeof part === "object" && part !== null && "text" in part) {
          return sum + estimateTokens(String((part as { text: string }).text));
        }
        return sum;
      }, 0);
    }
  }
  return 0;
}

/**
 * Build a forward-reference index: message indices that are referenced
 * by later messages (via toolCallId → toolResult pairing).
 */
function buildForwardReferenceIndex(messages: AgentMessage[]): Set<number> {
  const referenced = new Set<number>();

  // Map toolCallId → message index for tool results
  const toolResultByCallId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role === "toolResult" && "toolCallId" in msg) {
      toolResultByCallId.set((msg as { toolCallId: string }).toolCallId, i);
    }
  }

  // Scan assistant messages for tool calls — if a later assistant references
  // a tool result, that tool result has forward relevance
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg?.role !== "assistant") {
      continue;
    }

    // Check if this assistant message has tool calls referencing earlier results
    const content = "content" in msg ? msg.content : null;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "object" && part !== null && "toolCallId" in part) {
          const callId = (part as { toolCallId?: string }).toolCallId;
          if (callId) {
            // This assistant references a tool call — the assistant message itself is referenced
            referenced.add(i);
            break;
          }
        }
      }
    }

    // Also: if this assistant comes right before a tool result, mark the
    // preceding assistant as referenced (the assistant-tool pair should stay together)
    if (i + 1 < messages.length && messages[i + 1]?.role === "toolResult") {
      referenced.add(i);
      referenced.add(i + 1);
    }
  }

  return referenced;
}

/**
 * Extract the concatenated text of a message (string content or text parts).
 */
function extractMessageText(msg: AgentMessage): string {
  if ("content" in msg && msg.content) {
    if (typeof msg.content === "string") {
      return msg.content;
    }
    if (Array.isArray(msg.content)) {
      return msg.content
        .map((p: unknown) =>
          typeof p === "object" && p !== null && "text" in p
            ? String((p as { text: string }).text)
            : "",
        )
        .join(" ");
    }
  }
  return "";
}

/**
 * Score a message for retention priority. Higher = more important to keep.
 */
function scoreMessageForRetention(
  msg: AgentMessage,
  index: number,
  total: number,
  forwardRefs: Set<number>,
): number {
  let score = 0;

  // Position: newer messages are more important
  const recency = total > 1 ? index / (total - 1) : 1;
  score += recency * 30;

  // Forward reference bonus: messages referenced by later messages are more important
  if (forwardRefs.has(index)) {
    score += 15;
  }

  const text = extractMessageText(msg);

  // Role-based scoring
  const role = msg.role;
  if (role === "user") {
    // Current user message gets highest priority
    score += 100;
  } else if (role === "toolResult") {
    // Tool results are recoverable (CCR), medium priority
    score += 20;

    // Error results are more important
    if ("isError" in msg && msg.isError) {
      score += 30;
    }

    // Check for error content
    if (/error|exception|fail|fatal/i.test(text)) {
      score += 25;
    }
  } else if (role === "assistant") {
    score += 40;
  }

  // Temporal-anchor bonus: explicit dates/times in message content are hard to
  // reconstruct later — prefer keeping them at the margin (F8 residual).
  if (hasTemporalAnchor(text)) {
    score += 10;
  }

  return score;
}

/**
 * Enforce token budget by dropping lowest-priority messages.
 * Returns the (potentially reduced) messages array.
 */
export function enforceTokenBudget(
  messages: AgentMessage[],
  tokenBudget: number,
  _config: CompressionConfig,
): AgentMessage[] {
  // Estimate total tokens
  let totalTokens = 0;
  const estimates: { index: number; tokens: number; score: number }[] = [];

  // Build forward-reference index for scoring
  const forwardRefs = buildForwardReferenceIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) {
      continue; // index bounded by messages.length; guard for noUncheckedIndexedAccess only
    }
    const tokens = estimateMessageTokens(msg);
    totalTokens += tokens;
    const score = scoreMessageForRetention(msg, i, messages.length, forwardRefs);
    estimates.push({ index: i, tokens, score });
  }

  if (totalTokens <= tokenBudget) {
    return messages;
  }

  // Identify protected indices: the last user message. (System prompts are not
  // part of the message array — they are passed separately — so there is no
  // system message to protect here.)
  const protectedIndices = new Set<number>();

  // Last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      protectedIndices.add(i);
      break;
    }
  }

  // Sort non-protected by score ascending (drop lowest first)
  const droppable = estimates
    .filter((e) => !protectedIndices.has(e.index))
    .toSorted((a, b) => a.score - b.score);

  // Drop messages until under budget
  const dropIndices = new Set<number>();
  let currentTokens = totalTokens;

  for (const entry of droppable) {
    if (currentTokens <= tokenBudget) {
      break;
    }
    dropIndices.add(entry.index);
    currentTokens -= entry.tokens;
  }

  if (dropIndices.size === 0) {
    return messages;
  }

  // Filter out dropped messages
  return messages.filter((_, i) => !dropIndices.has(i));
}
