import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

// Cheap heuristic: ~4 chars/token + 1 token of overhead per content block to
// amortize role markers and serialization framing. Ported byte-for-byte from
// the Rust reference (`estimate_message_tokens` in claw-code's runtime/usage.rs)
// so behavior is consistent with the regression-test corpus.
const CHARS_PER_TOKEN = 4;
const PER_BLOCK_OVERHEAD = 1;

export function estimateMessageTokens(message: AgentMessage): number {
  const m = message as { role?: string; content?: unknown };
  if (typeof m.content === "string") {
    return Math.ceil(m.content.length / CHARS_PER_TOKEN) + PER_BLOCK_OVERHEAD;
  }
  if (Array.isArray(m.content)) {
    return m.content.reduce(
      (sum: number, block: unknown) => sum + estimateBlockTokens(block),
      PER_BLOCK_OVERHEAD,
    );
  }
  return PER_BLOCK_OVERHEAD;
}

export function estimateTotalTokens(messages: ReadonlyArray<AgentMessage>): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

function estimateBlockTokens(block: unknown): number {
  if (!block || typeof block !== "object") {
    return PER_BLOCK_OVERHEAD;
  }
  const b = block as {
    type?: string;
    text?: string;
    thinking?: string;
    signature?: string;
    arguments?: unknown;
    name?: string;
  };
  switch (b.type) {
    case "text":
      return Math.ceil((b.text?.length ?? 0) / CHARS_PER_TOKEN) + PER_BLOCK_OVERHEAD;
    case "thinking":
      return (
        Math.ceil((b.thinking?.length ?? 0) / CHARS_PER_TOKEN) +
        Math.ceil((b.signature?.length ?? 0) / CHARS_PER_TOKEN) +
        PER_BLOCK_OVERHEAD
      );
    case "toolCall": {
      const argLen = JSON.stringify(b.arguments ?? {}).length;
      return Math.ceil(((b.name?.length ?? 0) + argLen) / CHARS_PER_TOKEN) + PER_BLOCK_OVERHEAD;
    }
    default:
      return PER_BLOCK_OVERHEAD;
  }
}
