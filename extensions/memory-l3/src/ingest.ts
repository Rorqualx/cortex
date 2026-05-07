import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { estimateMessageTokens } from "./token-estimate.js";

export type IngestStats = {
  messages: number;
  tokens: number;
};

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

  push(sessionId: string, message: AgentMessage): void {
    const list = this.bySession.get(sessionId);
    if (list) {
      list.push(message);
    } else {
      this.bySession.set(sessionId, [message]);
    }
    const cost = estimateMessageTokens(message);
    this.tokensBySession.set(sessionId, (this.tokensBySession.get(sessionId) ?? 0) + cost);
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
    return list;
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
