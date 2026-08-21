import { randomUUID } from "node:crypto";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { dedupWithinChunk, dropAlreadyKnown, liftToL2Fact } from "./dedup.js";
import type { EmbeddingProvider } from "./engine.js";
import { extractEntitiesFromFacts, mergeEntities, findTopicLinks } from "./entities.js";
import { maybeWriteEpoch } from "./epoch.js";
import { groundAndDedupTypedFacts } from "./grounding.js";
import { extractEdges, mergeEdges, type HebbianEdge } from "./hebbian.js";
import type { IngestBuffer } from "./ingest.js";
import type { ExtractedFact } from "./llm.js";
import {
  extractFacts,
  extractFactsNative,
  type ExtractResult,
  type ExtractedDecision,
  type ExtractedActionItem,
  type ExtractedActiveConstraint,
  type ExtractedTypedFact,
  formatTranscriptForPrompt,
  type LlmCaller,
} from "./llm.js";
import { cosineSimilarity } from "./scoring.js";
import { buildMessageChunks, detectTopicBoundaries, splitByBoundaries } from "./segmentation.js";
import type { Storage } from "./storage.js";
import type {
  L2ChunkFrontmatter,
  L2DeterministicExtraction,
  L2Fact,
  L3State,
  TypedFact,
} from "./types.js";
import type { FactCertainty } from "./types.js";

const DEBUG_ENABLED = process.env.OPENCLAW_MEMORY_L3_DEBUG === "1";
function l3debug(msg: string): void {
  if (DEBUG_ENABLED) {
    console.error(`[memory-l3/compaction] ${msg}`);
  }
}

export type CompactionResult = {
  chunkId: string | null;
  factsAdded: number;
  typedFactsAdded: number;
  tokensBefore: number;
  messagesIngested: number;
  epochId: string | null;
};

/**
 * Certainty rank for conservative propagation during compaction.
 * Lower rank = weaker certainty. When facts are merged or abstracted,
 * the result inherits the WEAKEST certainty from its inputs so that
 * a single tentative fact cannot be laundered to "confirmed" by being
 * grouped with confirmed facts.
 */
const CERTAINTY_RANK: Record<FactCertainty, number> = {
  tentative: 0,
  instructional: 1,
  confirmed: 2,
};

/**
 * Return the most conservative (weakest) certainty from a set of facts.
 * If any input is tentative, the result is tentative. Absent certainty
 * is treated as "confirmed" (the type-system default for pre-existing facts).
 */
function conservativeCertainty(facts: ReadonlyArray<ExtractedFact>): FactCertainty | undefined {
  if (facts.length === 0) return undefined;
  let weakest: FactCertainty = "confirmed";
  let any = false;
  for (const f of facts) {
    if (f.certainty) {
      any = true;
      if (CERTAINTY_RANK[f.certainty] < CERTAINTY_RANK[weakest]) {
        weakest = f.certainty;
      }
    }
  }
  return any ? weakest : undefined;
}

const RECENT_DEDUP_KEYS_LIMIT = 200;
const RECENT_CHUNKS_TO_SCAN = 50;

// --- Category-capped L2 state budget ---
// Groups facts by their dedupKey namespace prefix (e.g. `user_preference:`,
// `infra:`, `failure:`) and enforces a per-category token cap by dropping the
// lowest-importance facts over budget. Prevents a single chatty category from
// crowding out diverse signal in long sessions. Default off (0 = no cap).
//
// Token estimate: ~4 chars/token (matching token-estimate.ts heuristic).
const CHARS_PER_TOKEN = 4;

function extractCategory(dedupKey: string): string {
  const colonIdx = dedupKey.indexOf(":");
  return colonIdx > 0 ? dedupKey.slice(0, colonIdx) : "uncategorized";
}

function estimateFactTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN) + 1;
}

/**
 * Apply a per-category token budget to extracted facts. Facts within each
 * category are sorted by importance (descending); the lowest-importance facts
 * are dropped until the category is under budget.
 */
export function applyCategoryBudget(
  facts: ReadonlyArray<ExtractedFact>,
  maxTokensPerCategory: number,
): ExtractedFact[] {
  if (maxTokensPerCategory <= 0) return [...facts];

  // Group by category prefix.
  const groups = new Map<string, ExtractedFact[]>();
  for (const fact of facts) {
    const cat = extractCategory(fact.dedupKey);
    const list = groups.get(cat);
    if (list) {
      list.push(fact);
    } else {
      groups.set(cat, [fact]);
    }
  }

  const result: ExtractedFact[] = [];
  for (const [, group] of groups) {
    // Sort by importance descending — keep the most important facts.
    const sorted = [...group].sort((a, b) => b.importance - a.importance);
    let tokenSum = 0;
    for (const fact of sorted) {
      const cost = estimateFactTokens(fact.text);
      if (tokenSum + cost > maxTokensPerCategory) {
        break;
      }
      tokenSum += cost;
      result.push(fact);
    }
  }

  return result;
}

// --- Budget-aware L2 operator selection (Kang et al. inspired) ---
//
// When budget pressure is high, instead of just dropping facts, apply
// progressive operators that compress more aggressively but preserve
// more information than simple dropping:
//   - Low pressure (<30%): Retain — keep important facts, drop the rest
//     (same as applyCategoryBudget above).
//   - Moderate pressure (30-60%): Merge — concatenate textually similar
//     overflow facts into a single merged fact, preserving their content.
//   - High pressure (>60%): Abstract — when even merging can't fit, the
//     caller may optionally provide an LLM to summarize overflow facts
//     into one concise abstract fact.
//
// Gate: enabled via `budgetAwareCompaction` param or
// OPENCLAW_MEMORY_L3_BUDGET_AWARE=1 env flag. Default off — existing
// `applyCategoryBudget` behavior is unchanged.

/** Thresholds for budget-pressure operator selection. */
const LOW_PRESSURE_THRESHOLD = 0.3;
const HIGH_PRESSURE_THRESHOLD = 0.6;

/**
 * Compute budget pressure ratio for a category group.
 * Returns overflow / totalBudget (0 = no pressure, 1+ = severe overflow).
 */
function computePressureRatio(
  facts: ReadonlyArray<ExtractedFact>,
  maxTokens: number,
): { totalTokens: number; overflowTokens: number; pressure: number } {
  let totalTokens = 0;
  for (const f of facts) {
    totalTokens += estimateFactTokens(f.text);
  }
  const overflowTokens = Math.max(0, totalTokens - maxTokens);
  return { totalTokens, overflowTokens, pressure: maxTokens > 0 ? overflowTokens / maxTokens : 0 };
}

/**
 * Merge multiple fact texts by extracting common words/phrases and
 * combining unique suffixes. Produces a shorter text than raw
 * concatenation. Example:
 *   ["alpha system config", "alpha system params"] → "alpha system: config; params"
 */
function compactMerge(texts: string[]): string {
  if (texts.length === 1) return texts[0]!;
  const wordsPerText = texts.map((t) => t.split(/\s+/));
  // Find common prefix words.
  const first = wordsPerText[0]!;
  let prefixLen = 0;
  for (let i = 0; i < first.length; i++) {
    const word = first[i];
    if (!wordsPerText.every((ws) => ws[i] === word)) break;
    prefixLen = i + 1;
  }
  const commonPrefix = first.slice(0, prefixLen).join(" ");
  // Extract unique tails.
  const tails = wordsPerText.map((ws) => ws.slice(prefixLen).join(" ")).filter((t) => t.length > 0);
  if (commonPrefix && tails.length > 0) {
    return `${commonPrefix}: ${tails.join("; ")}`;
  }
  // No common prefix — join with semicolons.
  return texts.join("; ");
}

/**
 * Merge textually similar overflow facts into a single fact. Each merged
 * fact takes the highest importance and combines text with semicolons.
 * Only facts that share a sub-category (after the first colon) are merged.
 */
function mergeOverflowFacts(overflow: ReadonlyArray<ExtractedFact>): ExtractedFact[] {
  if (overflow.length <= 1) return [...overflow];

  // Group by sub-category (the part after the category prefix).
  const subGroups = new Map<string, ExtractedFact[]>();
  for (const f of overflow) {
    const subKey = f.dedupKey.split(":").slice(1).join(":") || "default";
    const list = subGroups.get(subKey);
    if (list) {
      list.push(f);
    } else {
      subGroups.set(subKey, [f]);
    }
  }

  const merged: ExtractedFact[] = [];
  for (const [, group] of subGroups) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    // Merge: combine texts with shared-content extraction.
    const sorted = [...group].sort((a, b) => b.importance - a.importance);
    const head = sorted[0]!;
    const texts = sorted.map((f) => f.text);
    // Deduplicate identical texts.
    const uniqueTexts = [...new Set(texts)];
    const mergedText = compactMerge(uniqueTexts);
    // QW-1: propagate the most conservative certainty from inputs so a
    // tentative fact can't be laundered to "confirmed" by merging.
    const mergedCertainty = conservativeCertainty(sorted);
    merged.push({
      ...head,
      text: mergedText,
      reasoning: `merged:${group.length}`,
      ...(mergedCertainty ? { certainty: mergedCertainty } : {}),
    });
  }
  return merged;
}

/**
 * Apply budget-aware operator selection to facts across all categories.
 * When pressure is low, behaves identically to `applyCategoryBudget`.
 * At moderate pressure, merges similar overflow facts. At high pressure
 * with an LLM caller, summarizes overflow into an abstract fact.
 */
export async function applyCategoryBudgetWithOperators(params: {
  facts: ReadonlyArray<ExtractedFact>;
  maxTokensPerCategory: number;
  /** Optional LLM caller for the abstraction operator (high pressure). */
  caller?: LlmCaller;
}): Promise<ExtractedFact[]> {
  const { facts, maxTokensPerCategory } = params;
  if (maxTokensPerCategory <= 0) return [...facts];

  // Group by category prefix.
  const groups = new Map<string, ExtractedFact[]>();
  for (const fact of facts) {
    const cat = extractCategory(fact.dedupKey);
    const list = groups.get(cat);
    if (list) {
      list.push(fact);
    } else {
      groups.set(cat, [fact]);
    }
  }

  const result: ExtractedFact[] = [];
  for (const [, group] of groups) {
    const sorted = [...group].sort((a, b) => b.importance - a.importance);
    const { pressure } = computePressureRatio(sorted, maxTokensPerCategory);

    if (pressure < LOW_PRESSURE_THRESHOLD) {
      // Low pressure: simple retain/drop (same as applyCategoryBudget).
      let tokenSum = 0;
      for (const fact of sorted) {
        const cost = estimateFactTokens(fact.text);
        if (tokenSum + cost > maxTokensPerCategory) break;
        tokenSum += cost;
        result.push(fact);
      }
    } else {
      // Moderate or high pressure: retain what fits, then merge overflow.
      const retained: ExtractedFact[] = [];
      const overflow: ExtractedFact[] = [];
      let tokenSum = 0;
      for (const fact of sorted) {
        const cost = estimateFactTokens(fact.text);
        if (tokenSum + cost <= maxTokensPerCategory) {
          tokenSum += cost;
          retained.push(fact);
        } else {
          overflow.push(fact);
        }
      }

      if (overflow.length === 0) {
        result.push(...retained);
        continue;
      }

      // Merge overflow facts (textual merge, no LLM call).
      const merged = mergeOverflowFacts(overflow);

      // Accept merged facts within the budget. Genuinely merged facts
      // (reasoning starts with "merged:") get the full category budget as
      // allowance since they replace multiple facts. Unmerged passthrough
      // facts (no merge partner found) are held to the remaining budget.
      const remainingBudget = maxTokensPerCategory - tokenSum;
      const fitsAfterMerge: ExtractedFact[] = [];
      const stillOverflowing: ExtractedFact[] = [];
      for (const f of merged) {
        const cost = estimateFactTokens(f.text);
        const isMerged = f.reasoning?.startsWith("merged:");
        const allowance = isMerged ? maxTokensPerCategory : remainingBudget;
        if (cost <= allowance) {
          fitsAfterMerge.push(f);
        } else {
          stillOverflowing.push(f);
        }
      }

      result.push(...retained, ...fitsAfterMerge);

      // High pressure with LLM: abstract the still-overflowing facts.
      if (stillOverflowing.length > 0 && pressure >= HIGH_PRESSURE_THRESHOLD && params.caller) {
        try {
          const abstractFact = await abstractOverflow(stillOverflowing, params.caller);
          if (abstractFact) {
            result.push(abstractFact);
          }
        } catch {
          // LLM abstraction failure is non-fatal — just drop the overflow.
        }
      }
    }
  }

  return result;
}

/**
 * Use an LLM to abstract a set of overflow facts into a single concise fact.
 *
 * QW-3 (certainty-as-labelled-field): the LLM input and output now use
 * structured JSON with certainty as a separate field rather than inline
 * bracket notation. Research (arXiv:2608.06953) shows structured fields
 * survive compression ~15% better than prose qualifiers. The output
 * certainty is parsed from the LLM response but always clamped by the
 * conservative (weakest) certainty of the inputs so a tentative fact
 * can never be laundered to "confirmed".
 */
async function abstractOverflow(
  facts: ReadonlyArray<ExtractedFact>,
  caller: LlmCaller,
): Promise<ExtractedFact | null> {
  if (facts.length === 0) return null;
  if (facts.length === 1) return facts[0]!;

  // Structured JSON input: each fact is an object with separate text and
  // certainty fields, so the model sees certainty as a first-class signal.
  const structuredFacts = facts.map((f) => ({
    text: f.text,
    certainty: f.certainty ?? "confirmed",
  }));
  const prompt = `Compress these facts into a single concise statement that preserves the key information.

Input facts (JSON):
${JSON.stringify(structuredFacts, null, 2)}

Output strict JSON only: {"text": "the combined statement", "certainty": "tentative|confirmed|instructional"}
- Preserve dates and times verbatim; do not abbreviate or drop temporal expressions from the input facts.
- If any input fact has certainty "tentative", the output certainty must be "tentative".
- If any input fact has certainty "instructional" (and none are tentative), the output certainty must be "instructional".
- Otherwise, output "confirmed".`;

  let raw: string;
  try {
    raw = await caller({
      systemPrompt:
        "You are a fact compressor. Combine multiple related facts into one concise statement. Preserve dates and times verbatim — never abbreviate or drop temporal expressions. Output strict JSON with 'text' and 'certainty' fields. The 'certainty' field must be the most conservative (weakest) certainty from the inputs.",
      userPrompt: prompt,
      thinking: false,
    });
  } catch {
    return null;
  }

  // Parse the response: try JSON first, fall back to plain text.
  let text: string;
  let llmCertainty: FactCertainty | undefined;
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed && typeof parsed === "object" && typeof parsed.text === "string") {
      text = parsed.text.trim();
      llmCertainty =
        parsed.certainty === "tentative" ||
        parsed.certainty === "confirmed" ||
        parsed.certainty === "instructional"
          ? parsed.certainty
          : undefined;
    } else {
      text = raw.trim();
    }
  } catch {
    // Non-JSON response — use raw text as fallback.
    text = raw.trim();
  }

  if (!text || text.length < 5) return null;

  // Use the highest-importance fact as the template.
  const head = [...facts].sort((a, b) => b.importance - a.importance)[0]!;
  // QW-1: propagate the most conservative certainty from inputs so a
  // tentative fact can't be laundered to "confirmed" by abstraction.
  // QW-3: the LLM now returns certainty as a structured field, but we
  // still clamp to the conservative floor — the LLM cannot upgrade
  // certainty beyond what the inputs support.
  const abstractCertainty = conservativeCertainty(facts);
  // If the LLM returned a more conservative certainty than the computed
  // floor, trust the LLM (it may have detected nuance). If it returned a
  // less conservative one, use the floor.
  const finalCertainty =
    abstractCertainty && llmCertainty
      ? CERTAINTY_RANK[llmCertainty] < CERTAINTY_RANK[abstractCertainty]
        ? llmCertainty
        : abstractCertainty
      : (abstractCertainty ?? llmCertainty);

  return {
    ...head,
    text,
    reasoning: `abstract:${facts.length}`,
    ...(finalCertainty ? { certainty: finalCertainty } : {}),
  };
}

// -----------------------------------------------------------------------
// QW-3 (DeepSeek-Reasonix-inspired): Prune stale tool outputs before
// L2 compaction extraction. Large or duplicate tool results dilute fact
// quality and waste extraction tokens. Guarded behind
// OPENCLAW_MEMORY_L3_PRUNE_TOOL_OUTPUT=1.
// -----------------------------------------------------------------------

/**
 * Maximum character length of a single tool-result message before it becomes
 * a pruning candidate. Tool outputs shorter than this are kept as-is.
 */
const PRUNE_TOOL_OUTPUT_MAX_CHARS = 2000;

/**
 * Extract text length from a message's content (works for both string and
 * structured content arrays).
 */
function messageTextLength(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    return content.reduce((sum: number, part) => {
      if (part && typeof part === "object" && "text" in part) {
        return sum + String((part as { text: string }).text).length;
      }
      return sum;
    }, 0);
  }
  return 0;
}

/**
 * Check if a message is a tool-result message.
 */
function isToolResultMessage(msg: AgentMessage): boolean {
  return (msg as { role?: string }).role === "toolResult";
}

/**
 * Check if an assistant message contains tool calls.
 */
function hasToolCalls(msg: AgentMessage): boolean {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      (part as { type: string }).type === "toolCall",
  );
}

/**
 * Prune stale, large, or duplicate tool outputs from the message buffer
 * before extraction. Keeps the first occurrence of each tool output,
 * prunes large outputs (>PRUNE_TOOL_OUTPUT_MAX_CHARS) that have already
 * been seen in a prior compaction pass, and always keeps tool errors.
 *
 * This is a lossy filter — the facts from these tool outputs were likely
 * already extracted in prior compaction rounds. The risk of missing a fact
 * is mitigated by keeping the first occurrence of each tool output.
 */
export function pruneStaleToolOutputs(messages: ReadonlyArray<AgentMessage>): AgentMessage[] {
  const result: AgentMessage[] = [];
  /** Track toolCallIds we've already seen to detect duplicates. */
  const seenToolCallIds = new Set<string>();
  /** Track large tool output hashes to detect near-duplicates. */
  const seenLargeOutputs = new Set<string>();

  for (const msg of messages) {
    if (!isToolResultMessage(msg)) {
      result.push(msg);
      continue;
    }

    const toolMsg = msg as unknown as {
      role: string;
      toolCallId: string;
      toolName: string;
      content: unknown;
      isError: boolean;
      timestamp: number;
    };

    // Always keep tool errors — they carry diagnostic signal.
    if (toolMsg.isError) {
      result.push(msg);
      continue;
    }

    // Keep first occurrence of each toolCallId.
    if (!seenToolCallIds.has(toolMsg.toolCallId)) {
      seenToolCallIds.add(toolMsg.toolCallId);
      result.push(msg);
      continue;
    }

    // Duplicate toolCallId — skip it.
    l3debug(`pruneStaleToolOutputs: skipping duplicate tool result for ${toolMsg.toolCallId}`);
  }

  // Second pass: for large tool outputs, check if the content has been seen.
  // We only prune large outputs that exceed the threshold, and only if a
  // fingerprint (first 200 chars) matches a prior one.
  const finalResult: AgentMessage[] = [];
  for (const msg of result) {
    if (!isToolResultMessage(msg)) {
      finalResult.push(msg);
      continue;
    }

    const textLen = messageTextLength(msg);
    if (textLen <= PRUNE_TOOL_OUTPUT_MAX_CHARS) {
      finalResult.push(msg);
      continue;
    }

    // Compute a fingerprint from the first 200 chars of content.
    const content = (msg as { content?: unknown }).content;
    let fingerprint = "";
    if (typeof content === "string") {
      fingerprint = content.slice(0, 200);
    } else if (Array.isArray(content)) {
      fingerprint = content
        .map((p) =>
          p && typeof p === "object" && "text" in p ? String((p as { text: string }).text) : "",
        )
        .join("")
        .slice(0, 200);
    }

    if (seenLargeOutputs.has(fingerprint)) {
      l3debug(`pruneStaleToolOutputs: pruning large duplicate tool output (${textLen} chars)`);
      continue;
    }

    seenLargeOutputs.add(fingerprint);
    finalResult.push(msg);
  }

  return finalResult;
}

// --- Pre-compaction low-information filter (QW-1: aggressive L1→L2 early compaction) ---

/**
 * Maximum character length of an assistant message (no tool calls) to be
 * considered "low-information" and eligible for pre-compaction pruning.
 * Messages at or below this threshold that also match ack patterns are
 * dropped before the expensive LLM extraction call.
 */
const LOW_INFO_ASSISTANT_MAX_CHARS = 80;

/**
 * Patterns that identify pure-acknowledgment assistant turns with no
 * substantive content. These carry no extractable facts.
 */
const ACK_PATTERNS: readonly RegExp[] = [
  /^(?:great?|nice|cool|awesome|perfect|got it|understood|sure|ok(?:ay)?|done|will do|roger|acknowledged|noted|right|exactly|makes sense|sounds good|looks good|agreed)[.!?]?$/i,
  /^(?:i (?:see|agree|understand|think so too)|that(?:'s| is) (?:right|correct|good|fine|great))[.!?]?$/i,
  /^(?:thank you|thanks|ty|appreciated?)[.!?]?$/i,
  /^\+1$/,
];

/**
 * Extract plain text from a message for heuristic checks.
 */
function extractText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        p && typeof p === "object" && "text" in p ? String((p as { text: string }).text) : "",
      )
      .join("");
  }
  return "";
}

/**
 * Check if an assistant message is a low-information turn: short, no tool
 * calls, and matches an acknowledgment pattern or is trivially short.
 */
function isLowInformationAssistant(msg: AgentMessage): boolean {
  const role = (msg as { role?: string }).role;
  if (role !== "assistant") return false;
  // Any assistant message with tool calls carries actionable signal.
  if (hasToolCalls(msg)) return false;
  const text = extractText(msg).trim();
  if (text.length === 0) return true; // empty assistant turn
  if (text.length > LOW_INFO_ASSISTANT_MAX_CHARS) return false;
  // Check ack patterns
  for (const pattern of ACK_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  // Very short non-ack assistant turns (under 20 chars, no punctuation
  // suggesting a question or instruction) are also low-signal.
  if (text.length < 20 && !/[?!]/.test(text)) return true;
  return false;
}

/**
 * Check if a user message is a low-information turn: trivially short with
 * no actionable content (e.g., "ok", "yes", "continue", standalone emoji).
 */
function isLowInformationUser(msg: AgentMessage): boolean {
  const role = (msg as { role?: string }).role;
  if (role !== "user") return false;
  const text = extractText(msg).trim();
  if (text.length === 0) return true;
  if (text.length > 30) return false;
  // Short acknowledgments or continuations with no new information
  if (
    /^(?:ok(?:ay)?|sure|yes|no|continue|go ahead|proceed|cool|nice|great|fine|done|next|k|kk|👍|✅|❤️|😂|💯)\.?$/i.test(
      text,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Pre-compaction heuristic pass: drop low-information messages before the
 * expensive LLM extraction call. Targets:
 * - Pure acks / filler ("OK", "Great!", "Thanks")
 * - Short assistant turns with no tool calls or substantive content
 * - Trivially short user acknowledgments ("ok", "yes", "continue")
 *
 * This is a lossy filter — these messages rarely produce extractable facts.
 * The risk of missing a fact is negligible because the substantive context
 * is carried by surrounding messages.
 *
 * Gated behind OPENCLAW_MEMORY_L3_PRE_COMPACT_FILTER=1 (default: off).
 *
 * Inspired by Marginal Value Estimation (arXiv:2608.08389): early-stage
 * pruning of low-value content yields disproportionate token savings.
 */
export function filterLowInformationMessages(
  messages: ReadonlyArray<AgentMessage>,
): AgentMessage[] {
  const result: AgentMessage[] = [];
  let dropped = 0;

  for (const msg of messages) {
    const role = (msg as { role?: string }).role;

    if (role === "assistant" && isLowInformationAssistant(msg)) {
      dropped++;
      continue;
    }

    if (role === "user" && isLowInformationUser(msg)) {
      dropped++;
      continue;
    }

    result.push(msg);
  }

  if (dropped > 0) {
    l3debug(
      `filterLowInformationMessages: dropped ${dropped} low-info messages from ${messages.length} total`,
    );
  }

  return result;
}

// --- Deterministic zero-model extraction (PROMPT_VERSION=12) ---

const FILE_PATH_REGEX = /(?:\/|[A-Za-z]:[\\/])+(?:[\w.-]+[\\/])+[\w.-]+/g;

/**
 * Extract deterministic metadata from conversation messages without any LLM
 * call. These structured facts (tool names, file paths, turn count, time span)
 * serve as cache keys and an auditable complement to inference-tier
 * extraction.
 */
function extractDeterministic(messages: ReadonlyArray<AgentMessage>): L2DeterministicExtraction {
  const toolNames = new Set<string>();
  const filePaths = new Set<string>();
  let firstTs = Number.POSITIVE_INFINITY;
  let lastTs = 0;

  for (const msg of messages) {
    const m = msg as {
      role?: string;
      toolName?: string;
      content?: unknown;
      timestamp?: number;
    };
    if (m.role === "toolResult" && typeof m.toolName === "string" && m.toolName) {
      toolNames.add(m.toolName);
    }
    if (typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) {
      firstTs = Math.min(firstTs, m.timestamp);
      lastTs = Math.max(lastTs, m.timestamp);
    }
    // Extract file paths from text content
    const text =
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((c: { text?: string }) => (typeof c?.text === "string" ? c.text : ""))
              .join("")
          : "";
    if (text) {
      const matches = text.match(FILE_PATH_REGEX);
      if (matches) {
        for (const fp of matches) {
          // Filter out common false positives (version strings, URLs without paths)
          if (fp.length >= 3 && !fp.includes("://")) {
            filePaths.add(fp);
          }
        }
      }
    }
  }

  return {
    toolNames: [...toolNames].sort(),
    filePaths: [...filePaths].sort(),
    turnCount: messages.length,
    timeSpan: {
      start: Number.isFinite(firstTs) ? firstTs : 0,
      end: lastTs,
    },
  };
}

export async function compactSession(params: {
  sessionId: string;
  buffer: IngestBuffer;
  storage: Storage;
  caller: LlmCaller;
  state: L3State;
  /** Override the wall clock (for deterministic regression tests). */
  now?: number;
  /** Embedding provider for message-level chunk embeddings. Optional. */
  embeddingProvider?: EmbeddingProvider;
  /**
   * Per-topic extraction (C-DIC-style): segment the buffer at embedding
   * topic boundaries and run one extraction call per segment. Defaults to
   * the OPENCLAW_MEMORY_L3_SEGMENTED_COMPACTION=1 env flag. Costs one LLM
   * call per segment instead of one per tick — keep flagged until the
   * fact-quality gain is measured against that spend.
   */
  segmentedCompaction?: boolean;
  /**
   * Native compaction (BabelTele-style): use a dense, token-efficient
   * extraction prompt that drops articles/filler and abbreviates where
   * possible. Flag-gated A/B test; defaults to the
   * OPENCLAW_MEMORY_L3_NATIVE_COMPACTION=1 env flag.
   */
  nativeCompaction?: boolean;
  /**
   * Per-category token budget for L2 facts. After extraction + dedup,
   * facts are grouped by dedupKey prefix (e.g. `user_preference:`,
   `infra:`) and the lowest-importance facts over budget are dropped.
   * 0 = no cap (default). Set via
   * OPENCLAW_MEMORY_L3_CATEGORY_BUDGET env var or directly.
   */
  categoryBudget?: number;
  /**
   * Budget-aware L2 operator selection (Kang et al.). When enabled, budget
   * pressure triggers progressive operators (merge, abstract) instead of
   * simple dropping. Defaults to the
   * OPENCLAW_MEMORY_L3_BUDGET_AWARE=1 env flag.
   */
  budgetAwareCompaction?: boolean;
}): Promise<CompactionResult> {
  const rawMessages = [...params.buffer.peek(params.sessionId)];
  // QW-3: Prune stale/duplicate/large tool outputs before extraction to save
  // LLM tokens and reduce fact dilution. Gated behind env flag.
  const afterToolPrune =
    process.env.OPENCLAW_MEMORY_L3_PRUNE_TOOL_OUTPUT === "1"
      ? pruneStaleToolOutputs(rawMessages)
      : rawMessages;
  // QW-1: Drop low-information messages (pure acks, short filler) before
  // the expensive LLM extraction call. Gated behind env flag.
  const messages =
    process.env.OPENCLAW_MEMORY_L3_PRE_COMPACT_FILTER === "1"
      ? filterLowInformationMessages(afterToolPrune)
      : afterToolPrune;
  const tokensBefore = params.buffer.tokens(params.sessionId);
  if (messages.length === 0) {
    return {
      chunkId: null,
      factsAdded: 0,
      typedFactsAdded: 0,
      tokensBefore: 0,
      messagesIngested: 0,
      epochId: null,
    };
  }

  const alreadyKnownSet = new Set(await readRecentDedupKeys(params.storage));

  const { extracted, topicSegments } = await extractWithOptionalSegmentation({
    messages,
    caller: params.caller,
    embeddingProvider: params.embeddingProvider,
    segmentedCompaction: params.segmentedCompaction,
    nativeCompaction: params.nativeCompaction,
  });

  const filtered = dropAlreadyKnown(extracted.facts, alreadyKnownSet);
  const deduped = dedupWithinChunk(filtered);

  // Apply per-category token budget if configured (QW-1). Prevents a single
  // chatty category from crowding out diverse signal in long sessions.
  // When budgetAwareCompaction is enabled, budget pressure triggers
  // progressive operators (merge, abstract) instead of simple dropping.
  const categoryBudget =
    params.categoryBudget ?? Number(process.env.OPENCLAW_MEMORY_L3_CATEGORY_BUDGET ?? "0");
  const budgetAware =
    params.budgetAwareCompaction ?? process.env.OPENCLAW_MEMORY_L3_BUDGET_AWARE === "1";
  let budgeted: ExtractedFact[];
  if (categoryBudget > 0 && budgetAware) {
    budgeted = await applyCategoryBudgetWithOperators({
      facts: deduped,
      maxTokensPerCategory: categoryBudget,
      caller: params.caller,
    });
  } else if (categoryBudget > 0) {
    budgeted = applyCategoryBudget(deduped, categoryBudget);
  } else {
    budgeted = deduped;
  }

  // Verbatim source-grounding for typed facts: the LLM's claimed values
  // must appear inside the original transcript character-for-character.
  // Anything that fails grounding is hallucinated and dropped silently.
  const transcript = formatTranscriptForPrompt(messages);
  const groundedTyped = groundAndDedupTypedFacts(extracted.typedFacts, transcript);

  const now = params.now ?? Date.now();
  const eventTime = (messages[0] as { timestamp?: number })?.timestamp ?? now;
  const participants = [
    ...new Set(
      messages.map((m) => (m as { role?: string }).role).filter((r): r is string => Boolean(r)),
    ),
  ];
  const chunkId = nextChunkId(params.state);
  const intentShift = params.buffer.hasIntentShift(params.sessionId);
  const facts: L2Fact[] = budgeted.map((f) =>
    liftToL2Fact(f, now, {
      ...(intentShift ? { forceSignificant: true } : undefined),
      sessionId: params.sessionId,
    }),
  );
  const typedFacts: TypedFact[] = groundedTyped.map((t) =>
    liftToTypedFact(t, now, {
      eventTime,
      sessionId: params.sessionId,
      participants,
      mentionTime: now,
    }),
  );

  // One chunk embedding serves both the information-gain metric (persisted
  // on the chunk frontmatter) and cross-session topic linking below.
  // Non-fatal: any failure here just means the chunk persists without them.
  let chunkEmbedding: number[] | undefined;
  let linkCandidates: Array<{ chunkId: string; embedding: number[] }> = [];
  let informationGain: number | undefined;
  if (params.embeddingProvider && facts.length > 0) {
    try {
      const chunkText = facts.map((f) => f.text).join(" ");
      [chunkEmbedding] = await params.embeddingProvider.embedBatch([chunkText]);
      if (chunkEmbedding && chunkEmbedding.length > 0) {
        const longterm = await params.storage.readLongTerm();
        const withEmbeddings = longterm.facts.filter(
          (f) => !f.archived && f.embedding && f.embedding.length > 0,
        );
        linkCandidates = withEmbeddings.map((f) => ({
          chunkId: f.sourceChunkIds[0] ?? f.id,
          embedding: f.embedding!,
        }));
        // Novelty vs long-term memory: an empty long-term tier means the
        // session covered entirely new ground (gain = 1).
        const maxSimilarity = withEmbeddings.reduce(
          (max, f) => Math.max(max, cosineSimilarity(chunkEmbedding!, f.embedding!)),
          0,
        );
        informationGain = 1 - maxSimilarity;
      }
    } catch (gainErr) {
      if (DEBUG_ENABLED) {
        console.error(`[memory-l3] information-gain embedding failed: ${String(gainErr)}`);
      }
    }
  }

  // Zero-model deterministic extraction: tool names, file paths, turn count,
  // time span. Runs alongside the LLM extraction as an auditable complement
  // and potential cache key (PROMPT_VERSION=12).
  const deterministic = extractDeterministic(messages);

  const frontmatter: L2ChunkFrontmatter = {
    id: chunkId,
    agentId: params.state.agentId,
    startTurnIndex: 0,
    endTurnIndex: messages.length,
    createdAt: now,
    facts,
    typedFacts,
    dedupKeys: facts.map((f) => f.dedupKey),
    decisions: extracted.decisions.length > 0 ? extracted.decisions : undefined,
    actionItems: extracted.actions.length > 0 ? extracted.actions : undefined,
    activeConstraints:
      extracted.activeConstraints && extracted.activeConstraints.length > 0
        ? extracted.activeConstraints
        : undefined,
    informationGain,
    contextWindow: messages.length,
    topicSegments,
    deterministic,
  };

  await params.storage.writeL2Chunk(
    frontmatter,
    formatChunkBody(
      messages,
      facts,
      typedFacts,
      extracted.decisions,
      extracted.actions,
      extracted.activeConstraints,
    ),
  );

  // Hebbian co-occurrence: extract edges from facts in this chunk and
  // merge with existing edge map.
  if (facts.length >= 2) {
    try {
      const newEdges = extractEdges(facts);
      if (newEdges.length > 0) {
        const existingEdges = (await params.storage.readEdgeMap()) as HebbianEdge[];
        const merged = mergeEdges(existingEdges, newEdges);
        await params.storage.writeEdgeMap(merged);
      }
    } catch (edgeErr) {
      // Edge extraction failures are non-fatal — the chunk is already written.
      if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
        console.error(`[memory-l3] hebbian edge extraction failed: ${(edgeErr as Error).message}`);
      }
    }
  }

  for (const message of messages) {
    await params.storage.appendL1Archive(chunkId, message);
  }

  // Build and store message-level embedding chunks for raw conversation
  // retrieval. Non-fatal: failures just mean no message-level index.
  if (params.embeddingProvider && messages.length >= 4) {
    try {
      const msgChunks = await buildMessageChunks({
        messages,
        embeddingProvider: params.embeddingProvider,
        chunkId,
        now,
      });
      if (msgChunks.length > 0) {
        await params.storage.writeMessageChunks(msgChunks);
        l3debug(`compactSession: wrote ${msgChunks.length} message-level chunks for ${chunkId}`);
      }
    } catch (msgChunkErr) {
      if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
        console.error(
          `[memory-l3] message chunk building failed: ${(msgChunkErr as Error).message}`,
        );
      }
    }
  }

  // Entity extraction — heuristic extraction from facts (zero LLM cost)
  try {
    const extractedEntities = extractEntitiesFromFacts({
      facts,
      typedFacts,
      agentId: params.state.agentId,
      chunkId,
      now,
    });
    if (extractedEntities.length > 0) {
      const existingEntities = await params.storage.readEntityIndex();
      const merged = mergeEntities(existingEntities, extractedEntities);
      await params.storage.writeEntityIndex(merged);
      l3debug(
        `compactSession: extracted ${extractedEntities.length} entities, index now ${merged.length} total`,
      );
    }
  } catch (entityErr) {
    if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
      console.error(`[memory-l3] entity extraction failed: ${(entityErr as Error).message}`);
    }
  }

  // Cross-session topic linking — reuses the chunk embedding and long-term
  // candidates computed for the information-gain metric above.
  if (chunkEmbedding && chunkEmbedding.length > 0 && linkCandidates.length > 0) {
    try {
      const links = await findTopicLinks({
        chunkId,
        chunkEmbedding,
        existingChunks: linkCandidates,
      });
      if (links.length > 0) {
        await params.storage.appendTopicLinks(links);
      }
    } catch (linkErr) {
      if (process.env.OPENCLAW_MEMORY_L3_DEBUG === "1") {
        console.error(`[memory-l3] topic linking failed: ${(linkErr as Error).message}`);
      }
    }
  }

  params.buffer.drain(params.sessionId);
  params.state.l2ChunkIndex += 1;
  params.state.lastChunkId = chunkId;
  params.state.bufferTokenCount = params.buffer.totalTokens();

  const epochId = await maybeWriteEpoch({
    storage: params.storage,
    state: params.state,
    now,
  });

  return {
    chunkId,
    factsAdded: facts.length,
    typedFactsAdded: typedFacts.length,
    tokensBefore,
    messagesIngested: messages.length,
    epochId,
  };
}

function liftToTypedFact(
  extracted: ExtractedTypedFact,
  createdAt: number,
  episodic?: {
    eventTime?: number;
    sessionId?: string;
    participants?: string[];
    mentionTime?: number;
  },
): TypedFact {
  return {
    id: `tf-${randomUUID().slice(0, 8)}`,
    slot: extracted.slot,
    value: extracted.value,
    sourceSpan: extracted.sourceSpan,
    unit: extracted.unit,
    confidence: extracted.confidence,
    createdAt,
    lastVerifiedAt: createdAt,
    eventTime: episodic?.eventTime,
    sessionId: episodic?.sessionId,
    participants: episodic?.participants,
    mentionTime: episodic?.mentionTime,
    // QW5 (PROMPT_VERSION=15): first-class temporal + affect grounding.
    temporalSpan: extracted.temporalSpan,
    affect: extracted.affect,
  };
}

async function readRecentDedupKeys(storage: Storage): Promise<string[]> {
  const paths = await storage.listL2ChunkPaths();
  if (paths.length === 0) {
    return [];
  }
  const tail = paths.slice(-RECENT_CHUNKS_TO_SCAN);
  const keys: string[] = [];
  for (const filePath of tail) {
    const doc = await storage.readL2ChunkAtPath(filePath);
    if (!doc) {
      continue;
    }
    for (const key of doc.frontmatter.dedupKeys) {
      keys.push(key);
    }
  }
  return keys.slice(-RECENT_DEDUP_KEYS_LIMIT);
}

function nextChunkId(state: L3State): string {
  const seq = String(state.l2ChunkIndex).padStart(6, "0");
  return `chunk-${seq}-${randomUUID().slice(0, 8)}`;
}

function formatChunkBody(
  messages: ReadonlyArray<AgentMessage>,
  facts: ReadonlyArray<L2Fact>,
  typedFacts: ReadonlyArray<TypedFact>,
  decisions?: ReadonlyArray<ExtractedDecision>,
  actions?: ReadonlyArray<ExtractedActionItem>,
  constraints?: ReadonlyArray<ExtractedActiveConstraint>,
): string {
  const factSection =
    facts.length > 0
      ? `## Facts\n${facts.map((f) => `- [${f.importance.toFixed(2)}] ${f.text}`).join("\n")}`
      : "## Facts\n(none extracted)";
  const typedSection =
    typedFacts.length > 0
      ? `## Typed facts (verbatim)\n${typedFacts
          .map(
            (t) =>
              `- \`${t.slot}\` = \`${t.value}\`${t.unit ? ` ${t.unit}` : ""} (conf ${t.confidence.toFixed(2)})`,
          )
          .join("\n")}`
      : "";
  const decisionsSection =
    decisions && decisions.length > 0
      ? `## Decisions\n${decisions.map((d) => `- (${d.maker}) ${d.text}`).join("\n")}`
      : "";
  const actionsSection =
    actions && actions.length > 0
      ? `## Action Items\n${actions.map((a) => `- (${a.owner}) ${a.text}${a.deadline ? ` [${a.deadline}]` : ""}`).join("\n")}`
      : "";
  const constraintsSection =
    constraints && constraints.length > 0
      ? `## Active Constraints\n${constraints.map((c) => `- [${c.status}] ${c.text}`).join("\n")}`
      : "";
  const summarySection = `## Conversation\n${messages.length} message(s) compacted.`;
  return [
    factSection,
    typedSection,
    decisionsSection,
    actionsSection,
    constraintsSection,
    summarySection,
  ]
    .filter((s) => s.length > 0)
    .join("\n\n");
}

// -----------------------------------------------------------------
// Segmented (per-topic) extraction — C-DIC-style incremental step
// -----------------------------------------------------------------

/** Bound on extraction calls per tick so a boundary-happy session cannot multiply LLM spend unbounded. */
const MAX_COMPACTION_SEGMENTS = 4;

/** Merge trailing ranges into one so capping never drops messages. */
function capSegmentRanges(
  ranges: Array<{ start: number; end: number }>,
  max: number,
): Array<{ start: number; end: number }> {
  if (ranges.length <= max) {
    return ranges;
  }
  const head = ranges.slice(0, max - 1);
  const tail = ranges.slice(max - 1);
  const first = tail[0];
  const last = tail[tail.length - 1];
  if (!first || !last) {
    return ranges;
  }
  return [...head, { start: first.start, end: last.end }];
}

/**
 * Run fact extraction either monolithically (default) or per topic segment
 * when segmented compaction is enabled and an embedding provider is present.
 * Boundary-detection failures fall back to the monolithic path — extraction
 * must never fail because segmentation did.
 */
async function extractWithOptionalSegmentation(params: {
  messages: ReadonlyArray<AgentMessage>;
  caller: LlmCaller;
  embeddingProvider?: EmbeddingProvider;
  segmentedCompaction?: boolean;
  nativeCompaction?: boolean;
}): Promise<{
  extracted: ExtractResult;
  topicSegments?: Array<{ startMsgIndex: number; endMsgIndex: number }>;
}> {
  const enabled =
    params.segmentedCompaction ?? process.env.OPENCLAW_MEMORY_L3_SEGMENTED_COMPACTION === "1";
  const native =
    params.nativeCompaction ?? process.env.OPENCLAW_MEMORY_L3_NATIVE_COMPACTION === "1";
  const extractFn = native ? extractFactsNative : extractFacts;
  if (enabled && params.embeddingProvider) {
    try {
      const boundaries = await detectTopicBoundaries({
        messages: params.messages,
        embeddingProvider: params.embeddingProvider,
      });
      const ranges = capSegmentRanges(
        splitByBoundaries(params.messages.length, boundaries),
        MAX_COMPACTION_SEGMENTS,
      );
      if (ranges.length > 1) {
        const merged: ExtractResult = { facts: [], typedFacts: [], decisions: [], actions: [] };
        for (const range of ranges) {
          const segmentMessages = params.messages.slice(range.start, range.end);
          if (segmentMessages.length === 0) {
            continue;
          }
          const segment = await extractFn({ messages: segmentMessages, caller: params.caller });
          merged.facts.push(...segment.facts);
          merged.typedFacts.push(...segment.typedFacts);
          merged.decisions.push(...segment.decisions);
          merged.actions.push(...segment.actions);
          if (segment.activeConstraints) {
            merged.activeConstraints ??= [];
            merged.activeConstraints.push(...segment.activeConstraints);
          }
        }
        l3debug(
          `extractWithOptionalSegmentation: ${ranges.length} topic segments over ${params.messages.length} messages`,
        );
        return {
          extracted: merged,
          topicSegments: ranges.map((r) => ({ startMsgIndex: r.start, endMsgIndex: r.end })),
        };
      }
    } catch (segErr) {
      if (DEBUG_ENABLED) {
        console.error(`[memory-l3] segmented extraction failed: ${String(segErr)}`);
      }
    }
  }
  return { extracted: await extractFn({ messages: params.messages, caller: params.caller }) };
}
