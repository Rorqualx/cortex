// REMORY compaction proxy metrics (QW2, 2026-10-09).
//
// REMORY (compaction-quality research) shows two cheap, deterministic signals
// track compaction damage in agentic session logs, without any extra judge
// calls: when compaction drops information the agent still needed, the agent
// tends to re-issue the same tool call (identical tool-output payloads recur)
// and to re-hit failures (tool errors recur). We compute both from the
// replayed session log and emit them alongside recall scores as secondary
// compaction-quality signals — measurement before optimization.
//
// Pure and dependency-free so the engine harness (run-longmemeval-engine.ts),
// the archive replay harness (replay-compaction.mjs), and unit tests all share
// one implementation. Shape-agnostic over message formats: OpenAI-style
// `role: "tool"` messages AND Anthropic-style `tool_result` content blocks.

/** Collapse whitespace so byte-level formatting noise doesn't split repeats. */
function normalizePayloadText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort text extraction from string | content-block[] tool payloads. */
function payloadToText(content) {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if (typeof block.text === "string") {
      parts.push(block.text);
    } else if (typeof block.content === "string") {
      // Nested tool_result content (Anthropic shape).
      parts.push(block.content);
    }
  }
  return parts.join("\n");
}

// Conservative error signatures checked against the head of the payload, so a
// successful output that merely CONTAINS the word "error" (e.g. grep hits)
// isn't counted. Structured flags (is_error / isError) always win.
const TOOL_ERROR_SIGNATURES = [
  /^error\b/im,
  /\bcommand not found\b/i,
  /\bexit code [1-9]\d*\b/i,
  /\benoent\b/i,
  /\bno such file or directory\b/i,
  /\bpermission denied\b/i,
  /\beconnrefused\b/i,
  /\betimedout\b/i,
  /\bcommandfailed\b/i,
  /^traceback \(most recent call last\)/im,
];

/** A tool message/block counts as an error via explicit flag or signature. */
export function isToolErrorToolResult(payloadText, flags) {
  if (flags?.isError === true || flags?.isError === "true" || flags?.is_error === true) {
    return true;
  }
  const head = normalizePayloadText(payloadText).slice(0, 240).toLowerCase();
  if (!head) {
    return false;
  }
  return TOOL_ERROR_SIGNATURES.some((re) => re.test(head));
}

/**
 * Compute REMORY-style compaction proxy metrics over a replayed session log.
 *
 * Counts tool outputs (OpenAI `role:"tool"` messages + Anthropic tool_result
 * blocks), repeated identical payloads (occurrences beyond the first, after
 * whitespace normalization), and tool errors (flag or signature). Rates are
 * 0 when there is no tool traffic (e.g. clean LongMemEval haystacks).
 */
export function computeCompactionProxyMetrics(messages) {
  let toolMessages = 0;
  let toolErrors = 0;
  const payloadCounts = new Map();

  const observePayload = (text, flags) => {
    toolMessages += 1;
    const normalized = normalizePayloadText(payloadToText(text));
    if (normalized.length > 0) {
      payloadCounts.set(normalized, (payloadCounts.get(normalized) ?? 0) + 1);
    }
    if (isToolErrorToolResult(payloadToText(text), flags)) {
      toolErrors += 1;
    }
  };

  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") {
      continue;
    }
    if (message.role === "tool") {
      observePayload(message.content, { isError: message.isError, is_error: message.is_error });
      continue;
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === "object" && block.type === "tool_result") {
          observePayload(block.content, { isError: block.isError, is_error: block.is_error });
        }
      }
    }
  }

  // Repeats = occurrences beyond the first of each identical payload. Empty
  // payloads (unparseable) are excluded from both distinct and repeat counts.
  let repeatedToolOutputs = 0;
  for (const count of payloadCounts.values()) {
    if (count > 1) {
      repeatedToolOutputs += count - 1;
    }
  }

  return {
    toolMessages,
    distinctToolOutputs: payloadCounts.size,
    repeatedToolOutputs,
    repeatedToolOutputRate: toolMessages > 0 ? repeatedToolOutputs / toolMessages : 0,
    toolErrors,
    toolErrorRate: toolMessages > 0 ? toolErrors / toolMessages : 0,
  };
}

/** Sum metrics across independently replayed logs (e.g. per-question haystacks). */
export function sumCompactionProxyMetrics(list) {
  const totals = {
    toolMessages: 0,
    distinctToolOutputs: 0,
    repeatedToolOutputs: 0,
    repeatedToolOutputRate: 0,
    toolErrors: 0,
    toolErrorRate: 0,
  };
  for (const m of list ?? []) {
    totals.toolMessages += m.toolMessages;
    totals.distinctToolOutputs += m.distinctToolOutputs;
    totals.repeatedToolOutputs += m.repeatedToolOutputs;
    totals.toolErrors += m.toolErrors;
  }
  totals.repeatedToolOutputRate =
    totals.toolMessages > 0 ? totals.repeatedToolOutputs / totals.toolMessages : 0;
  totals.toolErrorRate = totals.toolMessages > 0 ? totals.toolErrors / totals.toolMessages : 0;
  return totals;
}
