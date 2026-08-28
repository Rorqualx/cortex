/**
 * Context Compression Pipeline — main entry point.
 *
 * Post-processing layer that runs after context engine assemble() returns.
 * Compresses tool-result content to reduce token usage without touching
 * user messages, system prompts, or assistant responses.
 *
 * Phase 2: CCR (Content Cache & Retrieval) stores originals in SQLite and
 * injects compression markers so the model can retrieve full data via
 * the `ccr_retrieve` tool.
 *
 * Usage:
 *   const raw = await assembleHarnessContextEngine(params);
 *   if (compressionConfig.enabled) {
 *     const result = await compressAssembledContext(raw.messages, compressionConfig);
 *     raw.messages = result.messages;
 *   }
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "../agents/runtime/index.js";
import { ContextTracker } from "./ccr/context-tracker.js";
import { buildCompressionMarker } from "./ccr/retrieval-tool.js";
import { CCRStore } from "./ccr/store.js";
import { routeAndCompress } from "./content-router.js";
import { danglingReferenceStats } from "./dangling-metric.js";
import { enforceTokenBudget } from "./token-budget-enforcer.js";
import type { CompressionConfig, CompressionResult, CompressionStats } from "./types.js";
import { DEFAULT_COMPRESSION_CONFIG } from "./types.js";
import { applyVerbatimGuard } from "./verbatim-guard.js";

export type { CompressionConfig, CompressionResult, CompressionStats };
export { DEFAULT_COMPRESSION_CONFIG };
export { CCRStore } from "./ccr/store.js";
export { ContextTracker } from "./ccr/context-tracker.js";
export {
  ccrRetrieveToolDefinition,
  CCR_RETRIEVE_TOOL_NAME,
  buildCompressionMarker,
  extractHashesFromContent,
} from "./ccr/retrieval-tool.js";
export { createCCRRetrieveTool } from "./ccr/retrieval-tool-executor.js";

/**
 * Extended compression result including CCR manifest.
 */
export type CompressionResultWithCCR = CompressionResult & {
  /** Hashes stored in CCR during this compression pass. */
  ccrHashes: string[];
};

/**
 * Compress tool-result content in an assembled message array.
 *
 * Pipeline stages:
 *  1. CacheAligner — stabilize prompt prefix (Phase 3 stub)
 *  2. ContentRouter — detect type, dispatch to compressor
 *  2b. CCR Store — store originals when CCR is enabled
 *  3. TokenBudgetEnforcer — trim to budget if needed
 */
export async function compressAssembledContext(
  messages: AgentMessage[],
  config: CompressionConfig,
  tokenBudget?: number,
  ccrStore?: CCRStore,
  contextTracker?: ContextTracker,
): Promise<CompressionResultWithCCR> {
  // Stage 1: Compress tool-result content + optional CCR storage.
  // (System-prompt cache-prefix stabilization lives in agents/system-prompt-cache-boundary.ts,
  // which operates on the system prompt — not the message array — so no alignment step here.)
  const compressed = compressToolResults(messages, config, ccrStore, contextTracker);

  // Stage 3: Token budget enforcement
  let finalMessages = compressed.messages;
  if (tokenBudget && tokenBudget > 0) {
    finalMessages = enforceTokenBudget(finalMessages, tokenBudget, config);
  }

  // Compute final stats
  const charsAfter = estimateTotalChars(finalMessages);
  const charsBefore = estimateTotalChars(messages);

  return {
    messages: finalMessages,
    charsBefore,
    charsAfter,
    stats: compressed.stats,
    ccrHashes: compressed.ccrHashes,
  };
}

// ---------------------------------------------------------------------------
// Internal: compress tool results in message array
// ---------------------------------------------------------------------------

function compressToolResults(
  messages: AgentMessage[],
  config: CompressionConfig,
  ccrStore?: CCRStore,
  contextTracker?: ContextTracker,
): { messages: AgentMessage[]; stats: CompressionStats; ccrHashes: string[] } {
  const byType: Record<
    string,
    {
      count: number;
      savingsPercent: number;
      danglingRate?: number;
    }
  > = {};
  let messagesCompressed = 0;
  let totalSavingsChars = 0;
  let totalOriginalChars = 0;
  // F8 dangling-reference metric: aggregate referent survival across every
  // compressed message so the pipeline reports one comparable number.
  let totalReferents = 0;
  let totalDangling = 0;
  const ccrHashes: string[] = [];

  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) {
      continue; // index bounded by messages.length; guard for noUncheckedIndexedAccess only
    }

    // Only compress toolResult messages
    if (msg.role !== "toolResult") {
      result.push(msg);
      continue;
    }

    // Extract text content
    const textContent = extractTextContent(msg);
    if (!textContent || textContent.length < config.minContentChars) {
      result.push(msg);
      continue;
    }

    // Route to appropriate compressor
    const compressed = routeAndCompress(textContent, config);

    if (!compressed.compressed) {
      result.push(msg);
      continue;
    }

    let finalContent = compressed.content;

    // F3 extractive-span guard: deterministic pass that re-attaches unique
    // verbatim-critical spans (paths, hex/ioctl constants, config keys,
    // versioned identifiers) the compressor dropped while paraphrasing.
    finalContent = applyVerbatimGuard(textContent, finalContent);

    // Stage 2b: CCR — store original and add retrieval marker
    if (ccrStore && config.ccr.enabled) {
      const hash = sha256(textContent);
      ccrStore.store(textContent, {
        messageIndex: i,
        compressedAt: Date.now(),
        contentType: compressed.contentType,
        originalChars: compressed.charsBefore,
        compressedChars: compressed.charsAfter,
      });
      ccrHashes.push(hash);

      // Append retrieval marker to compressed content
      const originalItems = estimateItemCount(textContent);
      const compressedItems = estimateItemCount(compressed.content);
      finalContent += buildCompressionMarker(hash, originalItems, compressedItems);

      // Track for cross-turn awareness
      if (contextTracker) {
        contextTracker.trackCompression({
          hash,
          originalContent: textContent,
          messageIndex: i,
          compressedAt: Date.now(),
          contentType: compressed.contentType,
          originalChars: compressed.charsBefore,
          compressedChars: compressed.charsAfter,
        });
      }
    }

    // Replace content in the message
    const newMsg = replaceToolResultContent(msg, finalContent);
    result.push(newMsg);

    // Track stats
    messagesCompressed++;
    totalSavingsChars += compressed.charsBefore - compressed.charsAfter;
    totalOriginalChars += compressed.charsBefore;

    const type = compressed.contentType;
    if (!byType[type]) {
      byType[type] = { count: 0, savingsPercent: 0 };
    }
    byType[type].count++;
    byType[type].savingsPercent = Math.round(
      ((compressed.charsBefore - compressed.charsAfter) / compressed.charsBefore) * 100,
    );

    // F8: per-type dangling-reference rate (referents that lost their anchor).
    const dangling = danglingReferenceStats(textContent, finalContent);
    totalReferents += dangling.referentCount;
    totalDangling += dangling.danglingCount;
    byType[type].danglingRate = dangling.referentCount > 0 ? dangling.rate : 0;
  }

  const totalSavingsPercent =
    totalOriginalChars > 0 ? Math.round((totalSavingsChars / totalOriginalChars) * 100) : 0;

  return {
    messages: result,
    stats: {
      messagesCompressed,
      totalSavingsPercent,
      byType,
      // F8: aggregate referent-survival rate across compressed messages.
      danglingReferenceRate:
        totalReferents > 0 ? Math.round((totalDangling / totalReferents) * 100) / 100 : 0,
    },
    ccrHashes,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractTextContent(msg: AgentMessage): string | null {
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

type ToolResultMsg = Extract<AgentMessage, { role: "toolResult" }>;

// Only ever called on toolResult messages (the compress loop filters by role).
// ToolResult content is always a content-block array, so we rebuild it as a
// single text block holding the compressed payload.
function replaceToolResultContent(msg: ToolResultMsg, newContent: string): ToolResultMsg {
  return { ...msg, content: [{ type: "text" as const, text: newContent }] };
}

function estimateTotalChars(messages: AgentMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    const text = extractTextContent(msg);
    if (text) {
      total += text.length;
    }
  }
  return total;
}

/**
 * Rough estimate of "items" in content (JSON array items, grep lines, etc.)
 */
function estimateItemCount(content: string): number {
  const trimmed = content.trim();
  // Try JSON array
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.length;
      }
    } catch {
      /* not json */
    }
  }
  // Fall back to line count
  return content.split("\n").filter((l) => l.trim().length > 0).length;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Resolve the effective compression config from openclaw.json config.
 * Falls back to defaults for any missing fields.
 */
export function resolveCompressionConfig(
  userConfig?: Partial<CompressionConfig>,
): CompressionConfig {
  if (!userConfig) {
    return { ...DEFAULT_COMPRESSION_CONFIG };
  }

  return {
    enabled: userConfig.enabled ?? DEFAULT_COMPRESSION_CONFIG.enabled,
    minContentChars: userConfig.minContentChars ?? DEFAULT_COMPRESSION_CONFIG.minContentChars,
    targetRatio: userConfig.targetRatio ?? DEFAULT_COMPRESSION_CONFIG.targetRatio,
    maxArrayItems: userConfig.maxArrayItems ?? DEFAULT_COMPRESSION_CONFIG.maxArrayItems,
    enabledTypes: {
      jsonArrays:
        userConfig.enabledTypes?.jsonArrays ?? DEFAULT_COMPRESSION_CONFIG.enabledTypes.jsonArrays,
      searchResults:
        userConfig.enabledTypes?.searchResults ??
        DEFAULT_COMPRESSION_CONFIG.enabledTypes.searchResults,
      logs: userConfig.enabledTypes?.logs ?? DEFAULT_COMPRESSION_CONFIG.enabledTypes.logs,
      diffs: userConfig.enabledTypes?.diffs ?? DEFAULT_COMPRESSION_CONFIG.enabledTypes.diffs,
    },
    ccr: {
      enabled: userConfig.ccr?.enabled ?? DEFAULT_COMPRESSION_CONFIG.ccr.enabled,
      dbPath: userConfig.ccr?.dbPath,
      maxEntries: userConfig.ccr?.maxEntries ?? DEFAULT_COMPRESSION_CONFIG.ccr.maxEntries,
      ttlSeconds: userConfig.ccr?.ttlSeconds ?? DEFAULT_COMPRESSION_CONFIG.ccr.ttlSeconds,
    },
  };
}

/**
 * Create a CCRStore from config. Returns undefined if CCR is disabled
 * or if node:sqlite is unavailable.
 */
export function createCCRStore(config: CompressionConfig, agentDir: string): CCRStore | undefined {
  if (!config.ccr.enabled) {
    return undefined;
  }

  const dbPath = config.ccr.dbPath ?? `${agentDir}/compression-cache.db`;
  try {
    return new CCRStore(dbPath, config.ccr.maxEntries, config.ccr.ttlSeconds);
  } catch {
    // CCR is optional — degrade gracefully if SQLite is unavailable
    return undefined;
  }
}
