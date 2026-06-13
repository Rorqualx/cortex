import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

/**
 * Converter from Claude Code session transcripts (~/.claude/projects/<proj>/
 * <session-id>.jsonl) into the AgentMessage[] shape the memory-l3 pipeline
 * ingests. Only conversational signal survives: user prompts and assistant
 * text. Tool calls/results, thinking, harness bookkeeping entries, and
 * injected <system-reminder> context are dropped — the fact extractor only
 * reads role + text, and tool noise would inflate token spend without
 * adding memorable content.
 */
export type ClaudeCodeSession = {
  sessionId: string;
  messages: AgentMessage[];
  /** ms timestamp of the first kept message (0 when none). */
  firstTimestamp: number;
  /** ms timestamp of the last kept message (0 when none). */
  lastTimestamp: number;
};

type TranscriptEntry = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  timestamp?: string;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
  };
};

/** Harness-generated user strings that carry no conversational signal. */
const NOISE_MARKERS = [
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-caveat>",
  "<task-notification>",
  "[Request interrupted",
];

/** Injected context blocks identified by prefix (may legitimately appear mid-text). */
const NOISE_PREFIXES = ["<system-reminder>", "<event>"];

const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function parseClaudeCodeTranscript(params: {
  jsonl: string;
  sessionId: string;
}): ClaudeCodeSession {
  const messages: AgentMessage[] = [];
  // Claude Code splits one assistant API message into one transcript entry
  // per content block, all sharing message.id. Merge adjacent entries with
  // the same id back into a single assistant message so the extractor sees
  // whole turns instead of fragmented "assistant:" lines.
  let lastAssistantId: string | null = null;
  let lastTimestamp = 0;

  for (const line of params.jsonl.split("\n")) {
    const entry = parseLine(line);
    if (!entry) {
      continue;
    }
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
    const timestamp = Number.isFinite(ts) ? ts : lastTimestamp;

    if (entry.type === "user") {
      const text = extractUserText(entry.message?.content);
      if (!text) {
        continue;
      }
      messages.push({ role: "user", content: text, timestamp });
      lastAssistantId = null;
      lastTimestamp = timestamp;
      continue;
    }

    // assistant
    if (entry.isApiErrorMessage) {
      continue;
    }
    const text = extractAssistantText(entry.message?.content);
    if (!text) {
      continue;
    }
    const id = entry.message?.id ?? null;
    const prev = messages[messages.length - 1];
    if (id && id === lastAssistantId && prev?.role === "assistant") {
      const block = prev.content.find((b) => b.type === "text");
      if (block && block.type === "text") {
        block.text = `${block.text}\n${text}`;
        lastTimestamp = timestamp;
        continue;
      }
    }
    messages.push({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: entry.message?.model ?? "unknown",
      usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
      stopReason: "stop",
      timestamp,
    });
    lastAssistantId = id;
    lastTimestamp = timestamp;
  }

  const first = messages[0]?.timestamp;
  const last = messages[messages.length - 1]?.timestamp;
  return {
    sessionId: params.sessionId,
    messages,
    firstTimestamp: typeof first === "number" ? first : 0,
    lastTimestamp: typeof last === "number" ? last : 0,
  };
}

/** Returns the entry when it is a kept conversational row, else null. */
function parseLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const entry = parsed as TranscriptEntry;
  if (entry.type !== "user" && entry.type !== "assistant") {
    return null;
  }
  // isMeta rows are slash-command expansions; sidechains are subagent
  // transcripts — neither is the user's own conversation.
  if (entry.isMeta === true || entry.isSidechain === true) {
    return null;
  }
  if (!entry.message || typeof entry.message !== "object") {
    return null;
  }
  return entry;
}

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") {
    return cleanUserText(content);
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    // tool_result blocks are tool output echoed back to the model, not
    // something the user said.
    if (b?.type !== "text" || typeof b.text !== "string") {
      continue;
    }
    const cleaned = cleanUserText(b.text);
    if (cleaned) {
      parts.push(cleaned);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function cleanUserText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  // Harness-injected context, not user speech.
  if (NOISE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return null;
  }
  if (NOISE_MARKERS.some((marker) => trimmed.includes(marker))) {
    return null;
  }
  return trimmed;
}

function extractAssistantText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    // thinking and tool_use blocks are dropped: thinking balloons extraction
    // spend on internal monologue; tool_use args are operational noise.
    if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
      parts.push(b.text.trim());
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}
