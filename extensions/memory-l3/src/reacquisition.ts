/**
 * Reacquisition telemetry (2026-08-23 QW2, from finding 7).
 *
 * Compression loses detail; agents recover by re-asking the environment —
 * re-reading files, re-running tools, re-deriving state that was just
 * compacted away. Completion-rate metrics are blind to this hidden cost
 * because every reacquisition looks like legitimate work. This module makes
 * it measurable: around each L2 compaction boundary we compare the per-turn
 * tool-call rate in the N messages before the boundary against the N messages
 * after it. A sustained post-compaction increase is a `reacquisition_spike`
 * signal — evidence the agent is paying back compression with extra calls.
 *
 * Deliberately raw: counts every assistant tool-call block (no attempt to
 * classify "retrieval-shaped" calls yet) and changes no behavior. The signal
 * is persisted (storage.l3_reacquisition_events) so later work — doom-loop
 * guard wiring, retention-policy tuning, LongMemEval correlation — has a
 * data source to draw on.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

/** Messages sampled on each side of a compaction boundary. */
export const REACQUISITION_WINDOW_MESSAGES = 40;
/** Post-rate must exceed pre-rate * RATIO to count as a spike. */
export const REACQUISITION_SPIKE_RATIO = 1.5;
/** Minimum post-boundary tool calls before a spike can fire (noise floor). */
export const REACQUISITION_MIN_CALLS = 3;

/** Tool-call density over a message window. */
export type ToolCallWindowStats = {
  /** Total messages examined. */
  messages: number;
  /** Assistant messages in the window. */
  assistantMessages: number;
  /** Tool-call blocks across assistant messages. */
  toolCalls: number;
  /** Tool calls per assistant message (0 when no assistant messages). */
  toolCallRate: number;
};

/** In-memory compaction boundary marker; one per session, latest wins. */
export type ReacquisitionMarker = {
  sessionId: string;
  /** Message-array cursor at the compaction boundary. */
  cursor: number;
  /** Pre-boundary window stats, captured when the marker was set. */
  before: ToolCallWindowStats;
  /** Wall clock of the compaction that set this marker. */
  compactedAt: number;
};

/** Comparison outcome for one compaction boundary. */
export type ReacquisitionOutcome = {
  before: ToolCallWindowStats;
  after: ToolCallWindowStats;
  /** after / before rate ratio; null when the pre-rate is 0 (no baseline). */
  ratio: number | null;
  /** True when the post-boundary rate clears the spike condition. */
  spike: boolean;
};

/** Count assistant tool-call blocks in a message window. */
export function countToolCalls(messages: AgentMessage[]): number {
  let calls = 0;
  for (const message of messages) {
    const candidate = message as { role?: string; content?: unknown };
    if (candidate?.role !== "assistant" || !Array.isArray(candidate.content)) {
      continue;
    }
    for (const block of candidate.content) {
      if ((block as { type?: string } | null)?.type === "toolCall") {
        calls += 1;
      }
    }
  }
  return calls;
}

/** Summarize tool-call density over a message window. */
export function windowStats(messages: AgentMessage[]): ToolCallWindowStats {
  const assistantMessages = messages.filter(
    (message) => (message as { role?: string } | null)?.role === "assistant",
  ).length;
  const toolCalls = countToolCalls(messages);
  return {
    messages: messages.length,
    assistantMessages,
    toolCalls,
    toolCallRate: assistantMessages > 0 ? toolCalls / assistantMessages : 0,
  };
}

/**
 * Decide whether the post-compaction window shows a reacquisition spike.
 *
 * Spike requires enough post-boundary calls to clear the noise floor AND a
 * rate increase of at least REACQUISITION_SPIKE_RATIO over the pre-boundary
 * baseline. A zero pre-rate (pure-prose window before compaction) treats any
 * qualifying post-window activity as a spike — the ratio is undefined there.
 */
export function evaluateReacquisition(
  before: ToolCallWindowStats,
  after: ToolCallWindowStats,
  config: { minCalls?: number; spikeRatio?: number } = {},
): ReacquisitionOutcome {
  const minCalls = config.minCalls ?? REACQUISITION_MIN_CALLS;
  const spikeRatio = config.spikeRatio ?? REACQUISITION_SPIKE_RATIO;
  const ratio = before.toolCallRate > 0 ? after.toolCallRate / before.toolCallRate : null;
  const rateCleared =
    before.toolCallRate > 0
      ? after.toolCallRate > before.toolCallRate * spikeRatio
      : after.toolCallRate > 0;
  return {
    before,
    after,
    ratio,
    spike: after.toolCalls >= minCalls && rateCleared,
  };
}
