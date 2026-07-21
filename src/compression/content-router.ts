import { compressDiffOutput } from "./diff-compressor.js";
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
 * Route content to the appropriate compressor based on type detection.
 */
export function routeAndCompress(content: string, config: CompressionConfig): CompressorOutput {
  const contentType = detectContentType(content);

  switch (contentType) {
    case "json_array":
      if (!config.enabledTypes.jsonArrays) {
        break;
      }
      return crushJsonArray(content, config.maxArrayItems, config.targetRatio);

    case "search":
      if (!config.enabledTypes.searchResults) {
        break;
      }
      return compressSearchResults(content, config.targetRatio);

    case "diff":
      if (!config.enabledTypes.diffs) {
        break;
      }
      return compressDiffOutput(content, config.targetRatio);

    case "log":
      if (!config.enabledTypes.logs) {
        break;
      }
      return compressLogOutput(content, config.targetRatio);

    case "passthrough":
    default:
      break;
  }

  return {
    content,
    compressed: false,
    charsBefore: content.length,
    charsAfter: content.length,
    contentType: "passthrough",
  };
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
