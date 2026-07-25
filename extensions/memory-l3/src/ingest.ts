import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { estimateMessageTokens } from "./token-estimate.js";

export type IngestStats = {
  messages: number;
  tokens: number;
};

// --- Intent-shift detection ---
// Revision signals that indicate a course correction by the user. When these
// appear in a user message, the conversation chunk likely contains
// higher-value information (the corrected direction) that deserves slower
// FSRS decay via the `significant` flag on extracted L2 facts.
//
// Pure regex heuristic — no model call needed.
const INTENT_SHIFT_PATTERNS: readonly RegExp[] = [
  /\bactually\b/i,
  /\bno\s*wait\b/i,
  /\binstead\s+of\b/i,
  /\bscratch\s+that\b/i,
  /\bdifferent\s+approach\b/i,
  /\blet'?s\s+(?:try|do|go)/i,
  /\bon\s+second\s+thought\b/i,
  /\bi\s+changed\s+my\s+mind\b/i,
  /\bdisregard\b/i,
  /\bnever\s*mind\b/i,
];

/**
 * Detect whether a message contains intent-shift / revision signals.
 * Exposed for unit testing and for compaction to call during fact extraction.
 */
export function detectIntentShift(message: AgentMessage): boolean {
  const text = extractMessageText(message);
  if (!text) return false;
  return INTENT_SHIFT_PATTERNS.some((re) => re.test(text));
}

function extractMessageText(message: AgentMessage): string {
  const m = message as { role?: string; content?: unknown };
  const content = m.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; thinking?: string };
    if (typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/**
 * In-memory buffer of ingested messages, keyed by sessionId. Holds the
 * post-bootstrap transcript that has not yet been distilled into L2 chunks.
 *
 * Stage 4 keeps this strictly in-process: messages live in memory until the
 * compactor (stage 5) cuts a chunk and persists facts to disk. A separate
 * L1 archive write (stage 5) ensures the raw transcript can be replayed if
 * the structured L2 chunk needs to be rebuilt.
 */
export class IngestBuffer {
  private readonly bySession = new Map<string, AgentMessage[]>();
  private readonly tokensBySession = new Map<string, number>();
  /** Indices of messages (per session) that contain intent-shift signals. */
  private readonly intentShiftsBySession = new Map<string, Set<number>>();

  push(sessionId: string, message: AgentMessage): void {
    const list = this.bySession.get(sessionId);
    if (list) {
      list.push(message);
    } else {
      this.bySession.set(sessionId, [message]);
    }
    const cost = estimateMessageTokens(message);
    this.tokensBySession.set(sessionId, (this.tokensBySession.get(sessionId) ?? 0) + cost);

    // Track intent-shift signals for significance boosting during compaction.
    if (detectIntentShift(message)) {
      const idx = (this.bySession.get(sessionId)?.length ?? 1) - 1;
      const shifts = this.intentShiftsBySession.get(sessionId);
      if (shifts) {
        shifts.add(idx);
      } else {
        this.intentShiftsBySession.set(sessionId, new Set([idx]));
      }
    }
  }

  pushBatch(sessionId: string, messages: ReadonlyArray<AgentMessage>): number {
    for (const message of messages) {
      this.push(sessionId, message);
    }
    return messages.length;
  }

  /** Returns a snapshot of the buffered messages without draining. */
  peek(sessionId: string): ReadonlyArray<AgentMessage> {
    return this.bySession.get(sessionId) ?? [];
  }

  /** Drain the buffer for a session and return the buffered messages. */
  drain(sessionId: string): AgentMessage[] {
    const list = this.bySession.get(sessionId) ?? [];
    this.bySession.delete(sessionId);
    this.tokensBySession.delete(sessionId);
    this.intentShiftsBySession.delete(sessionId);
    return list;
  }

  /** Whether any message in the session buffer triggered intent-shift detection. */
  hasIntentShift(sessionId: string): boolean {
    return (this.intentShiftsBySession.get(sessionId)?.size ?? 0) > 0;
  }

  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }

  tokens(sessionId: string): number {
    return this.tokensBySession.get(sessionId) ?? 0;
  }

  /** Aggregate buffered token count across all sessions held by this engine. */
  totalTokens(): number {
    let total = 0;
    for (const count of this.tokensBySession.values()) {
      total += count;
    }
    return total;
  }

  stats(sessionId: string): IngestStats {
    return { messages: this.size(sessionId), tokens: this.tokens(sessionId) };
  }

  /** Sessions that currently have at least one buffered message. */
  sessionIds(): string[] {
    return [...this.bySession.keys()];
  }
}
