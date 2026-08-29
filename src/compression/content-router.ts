import { compressDiffOutput } from "./diff-compressor.js";
import { estimateEntropy } from "./entropy-estimator.js";
import type { EntropyBucket } from "./entropy-estimator.js";
import { compressLogOutput } from "./log-compressor.js";
import { compressSearchResults } from "./search-compressor.js";
import { crushJsonArray } from "./smart-crusher.js";
/**
 * ContentRouter — detects content type and dispatches to the right compressor.
 *
 * Detection priority:
 *  1. JSON array   → SmartCrusher
 *  2. Search/grep  → SearchCompressor
 *  3. Diff         → DiffCompressor
 *  4. Log/build    → LogCompressor
 *  5. Unknown      → Passthrough
 */
import type { CompressorOutput, CompressionConfig } from "./types.js";

/**
 * ARCH-3 bucket-specific compression ratios (fraction of content kept):
 *   low    — information-dense (ttur > 0.6)       → keep 70%
 *   medium — standard (0.3 < ttur ≤ 0.6)           → keep 30% (global default)
 *   high   — repetitive (ttur ≤ 0.3)               → keep 15%
 */
export const BUCKET_RATIOS: Record<EntropyBucket, number> = {
  low: 0.7,
  medium: 0.3,
  high: 0.15,
};

/**
 * Route content to the appropriate compressor based on type detection.
 *
 * `ratioOverride` is the composition seam shared with plan-protection
 * (ARCH-2): an explicit override always beats the entropy bucket, which in
 * turn beats the global `config.targetRatio` — deterministic precedence
 * `ratioOverride ?? BUCKET_RATIOS[bucket] ?? config.targetRatio`.
 */
export function routeAndCompress(
  content: string,
  config: CompressionConfig,
  ratioOverride?: number,
): CompressorOutput {
  const contentType = detectContentType(content);

  // ARCH-3 entropy-guided budget (opt-in). Disabled ⇒ effectiveRatio stays
  // the global targetRatio and no entropyBucket is attached (byte parity).
  let effectiveRatio = config.targetRatio;
  let entropyBucket: EntropyBucket | undefined;
  if (config.entropyGuidedBudget) {
    const estimate = estimateEntropy(content);
    entropyBucket = estimate.bucket;
    effectiveRatio = ratioOverride ?? BUCKET_RATIOS[estimate.bucket] ?? config.targetRatio;
  }

  let output: CompressorOutput | undefined;
  switch (contentType) {
    case "json_array":
      if (!config.enabledTypes.jsonArrays) {
        break;
      }
      output = crushJsonArray(content, config.maxArrayItems, effectiveRatio);
      break;

    case "search":
      if (!config.enabledTypes.searchResults) {
        break;
      }
      output = compressSearchResults(content, effectiveRatio);
      break;

    case "diff":
      if (!config.enabledTypes.diffs) {
        break;
      }
      output = compressDiffOutput(content, effectiveRatio);
      break;

    case "log":
      if (!config.enabledTypes.logs) {
        break;
      }
      output = compressLogOutput(content, effectiveRatio);
      break;

    case "passthrough":
    default:
      break;
  }

  const result: CompressorOutput = output ?? {
    content,
    compressed: false,
    charsBefore: content.length,
    charsAfter: content.length,
    contentType: "passthrough",
  };

  if (entropyBucket !== undefined) {
    return { ...result, entropyBucket };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Type detection
// ---------------------------------------------------------------------------

type ContentType = "json_array" | "search" | "diff" | "log" | "passthrough";

function detectContentType(content: string): ContentType {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return "passthrough";
  }

  // 1. JSON array
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return "json_array";
      }
    } catch {
      // Not valid JSON — check other types
    }
  }

  // 2. Diff output
  if (isDiffContent(trimmed)) {
    return "diff";
  }

  // 3. Search/grep output
  if (isSearchContent(trimmed)) {
    return "search";
  }

  // 4. Log/build output
  if (isLogContent(trimmed)) {
    return "log";
  }

  return "passthrough";
}

function isDiffContent(content: string): boolean {
  const lines = content.split("\n");
  let diffMarkers = 0;
  for (const line of lines.slice(0, 20)) {
    if (line.startsWith("diff --git")) {
      diffMarkers++;
    }
    if (line.startsWith("@@")) {
      diffMarkers++;
    }
    if (line.startsWith("---")) {
      diffMarkers++;
    }
    if (line.startsWith("+++")) {
      diffMarkers++;
    }
  }
  return diffMarkers >= 3;
}

function isSearchContent(content: string): boolean {
  const lines = content.split("\n");
  let grepLines = 0;
  const sampleSize = Math.min(lines.length, 30);
  for (let i = 0; i < sampleSize; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    // file:line:content format
    if (/^\/?\S+:\d+:/.test(line)) {
      grepLines++;
    }
    // Just file paths
    else if (/^\/?\S+\.\w{1,10}$/.test(line.trim())) {
      grepLines++;
    }
  }
  return grepLines > sampleSize * 0.5;
}

function isLogContent(content: string): boolean {
  const lines = content.split("\n");
  let logLines = 0;
  const sampleSize = Math.min(lines.length, 20);
  for (let i = 0; i < sampleSize; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue;
    }
    // Timestamp patterns
    if (/^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(line)) {
      logLines++;
    }
    // Log levels
    else if (/\b(ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\b/.test(line)) {
      logLines++;
    }
    // Build tool output
    else if (/^\s*\[(ERROR|WARN|INFO)\]/.test(line)) {
      logLines++;
    } else if (/\b(passed|failed|skipped)\s*\d*\b/i.test(line)) {
      logLines++;
    } else if (/npm (warn|error|info)/i.test(line)) {
      logLines++;
    }
  }
  return logLines > sampleSize * 0.4;
}
