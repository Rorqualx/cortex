import { buildTimeRangeLine, extractTimestamps } from "./temporal.js";
/**
 * LogCompressor — pattern clustering for build/test/log output.
 *
 * Always keeps error lines, warnings, and stack traces.
 * Collapses repeated/sequential identical lines into a count marker.
 * Keeps first and last N lines of any continuous block.
 */
import type { CompressorOutput } from "./types.js";
const PYTEST_RE = /^\s*(PASSED|FAILED|ERROR|SKIP|XFAIL|XPASS)/;
const NPM_RE = /^\s*(npm|yarn|pnpm)\s+(warn|error|info)/;
const TEST_FRAMEWORK_RE = /^\s*(✓|✗|✔|✘|PASS|FAIL|PASSING|FAILING|ok|not ok)\b/i;

export function compressLogOutput(content: string, targetRatio: number): CompressorOutput {
  const originalChars = content.length;
  const passthrough: CompressorOutput = {
    content,
    compressed: false,
    charsBefore: originalChars,
    charsAfter: originalChars,
    contentType: "passthrough",
  };

  const lines = content.split("\n");
  if (lines.length < 15) {
    return passthrough;
  }

  // Classify and compress
  const result: string[] = [];
  let consecutiveCount = 0;
  let lastLine: string | null = null;
  let keptLines = 0;
  let errorLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) {
      continue; // index bounded by lines.length; guard for noUncheckedIndexedAccess only
    }
    const isErr = isErrorOrWarning(line);
    const isStackTrace = isStackLine(line);
    const isImportant = isErr || isStackTrace || isTestResult(line);

    if (isErr) {
      errorLines++;
    }

    // Check for repeated lines
    const normalized = normalizeForComparison(line);
    if (normalized === lastLine && !isImportant) {
      consecutiveCount++;
      continue;
    }

    // Flush accumulated identical lines
    if (consecutiveCount > 0 && lastLine !== null) {
      if (consecutiveCount > 2) {
        result.push(`... (${consecutiveCount} identical lines omitted) ...`);
      } else {
        // Keep small repeats
        for (let j = 0; j < consecutiveCount; j++) {
          result.push(lines[i - 1 - consecutiveCount + j] || "");
        }
      }
      consecutiveCount = 0;
    }

    if (isImportant) {
      // Always keep important lines
      result.push(line);
      keptLines++;
    } else {
      // Keep first 3 and last 3 lines of any block
      const distFromStart = i;
      const distFromEnd = lines.length - i;
      if (distFromStart < 3 || distFromEnd <= 3) {
        result.push(line);
        keptLines++;
      } else {
        // Sample: keep every Nth non-important line
        const sampleRate = Math.max(1, Math.floor(1 / targetRatio));
        if (i % sampleRate === 0) {
          result.push(line);
          keptLines++;
        }
      }
    }

    lastLine = normalized;
  }

  // Flush trailing identical lines
  if (consecutiveCount > 0) {
    if (consecutiveCount > 2) {
      result.push(`... (${consecutiveCount} identical lines omitted) ...`);
    }
  }

  let compressed = result.join("\n");

  // Temporal preservation: elided lines may have carried timestamps — leave a
  // time-range anchor so the span of the full log survives compression.
  const timeRange = buildTimeRangeLine(extractTimestamps(content));
  if (timeRange) {
    compressed += `\n${timeRange}`;
  }

  if (compressed.length >= originalChars * 0.7) {
    return passthrough;
  }

  return {
    content: compressed,
    compressed: true,
    charsBefore: originalChars,
    charsAfter: compressed.length,
    contentType: "log",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isErrorOrWarning(line: string): boolean {
  const lower = line.toLowerCase().trim();
  if (lower.length === 0) {
    return false;
  }

  // Log-level patterns
  if (/\b(error|fatal|critical|panic)\b/i.test(lower)) {
    return true;
  }
  if (/\b(warn(ing)?)\b/i.test(lower) && !lower.startsWith("#")) {
    return true;
  }

  // Build tool patterns
  if (NPM_RE.test(lower)) {
    return true;
  }
  if (PYTEST_RE.test(line)) {
    return true;
  }
  if (/\bmake\b.*\*\*/i.test(lower)) {
    return true;
  } // make error
  if (/^>\s/.test(line)) {
    return true;
  } // TypeScript/tsconfig error prefix

  // Stack traces
  if (/^\s+at\s/.test(line)) {
    return true;
  } // JS/TS stack
  if (/^\s+File\s+"/.test(line)) {
    return true;
  } // Python stack
  if (line.includes("Traceback")) {
    return true;
  }

  return false;
}

function isStackLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^\s+at\s+\S+/.test(trimmed) || // JS/TS stack frame
    /^\s+File\s+"/.test(trimmed) || // Python stack frame
    /^\s+at\s/.test(trimmed) ||
    /^\s+by\s/.test(trimmed) // Rust panic
  );
}

function isTestResult(line: string): boolean {
  return (
    PYTEST_RE.test(line) ||
    TEST_FRAMEWORK_RE.test(line) ||
    /\b(tests?\s+\d+\s+passed)/i.test(line) ||
    /\b(tests?\s+\d+\s+failed)/i.test(line) ||
    /\d+\s+(passing|failing|pending)/i.test(line)
  );
}

function normalizeForComparison(line: string): string {
  // Strip timestamps, line numbers, and durations for comparison
  return line
    .replace(/\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/, "<ts>")
    .replace(/\d+ms/g, "<dur>")
    .replace(/:\d+:\d+/g, ":<ln>")
    .trim();
}
