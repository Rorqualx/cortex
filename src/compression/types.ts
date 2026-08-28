/**
 * Context Compression Pipeline — types and defaults.
 *
 * Phase 1: pure TypeScript, zero dependencies. Only tool-result content is
 * compressed; user messages, system prompts, and assistant responses pass
 * through untouched.
 */
import type { AgentMessage } from "../agents/runtime/index.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type CompressionConfig = {
  /** Enable the compression pipeline. Default: false. */
  enabled: boolean;
  /** Minimum content length (chars) to consider for compression. Default: 800. */
  minContentChars: number;
  /** Target compression ratio. 0.3 = keep 30% of content. Default: 0.3. */
  targetRatio: number;
  /** Maximum items to keep in any JSON array. Default: 20. */
  maxArrayItems: number;
  /** Content types to compress. */
  enabledTypes: {
    jsonArrays: boolean;
    searchResults: boolean;
    logs: boolean;
    diffs: boolean;
  };
  /** CCR reversible cache (Phase 2). */
  ccr: {
    enabled: boolean;
    dbPath?: string;
    maxEntries: number;
    ttlSeconds: number;
  };
};

export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  enabled: false,
  minContentChars: 800,
  targetRatio: 0.3,
  maxArrayItems: 20,
  enabledTypes: {
    jsonArrays: true,
    searchResults: true,
    logs: true,
    diffs: true,
  },
  ccr: {
    enabled: false,
    maxEntries: 1000,
    ttlSeconds: 3600,
  },
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type CompressionStats = {
  messagesCompressed: number;
  totalSavingsPercent: number;
  byType: Record<
    string,
    {
      count: number;
      savingsPercent: number;
      /** F8: fraction of source referents (entities/defined terms) that lost
       * their last textual anchor in this compressor type's output. */
      danglingRate?: number;
    }
  >;
  /** F8: aggregate dangling-reference rate across all compressed messages.
   * High values are the trigger for a hard definition-pull mechanism. */
  danglingReferenceRate?: number;
};

export type CompressionResult = {
  messages: AgentMessage[];
  charsBefore: number;
  charsAfter: number;
  stats: CompressionStats;
};

// ---------------------------------------------------------------------------
// Per-compressor result
// ---------------------------------------------------------------------------

export type CompressorOutput = {
  /** Compressed text (or original if not compressible). */
  content: string;
  /** Was the content actually compressed? */
  compressed: boolean;
  /** Original character count. */
  charsBefore: number;
  /** Compressed character count. */
  charsAfter: number;
  /** Detected content type (json_array, search, log, diff, passthrough). */
  contentType: string;
};

// ---------------------------------------------------------------------------
// CCR (Phase 2 stubs)
// ---------------------------------------------------------------------------

export type CCREntry = {
  hash: string;
  originalContent: string;
  messageIndex: number;
  compressedAt: number;
  contentType: string;
  originalChars: number;
  compressedChars: number;
};
