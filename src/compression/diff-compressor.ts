/**
 * DiffCompressor — unified diff format compression.
 *
 * Keeps context lines, summarizes large additions, preserves removals
 * (they show what changed — most important part of a diff).
 */
import type { CompressorOutput } from "./types.js";

/** Matches a diff hunk header: @@ -a,b +c,d @@ */
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function compressDiffOutput(content: string, targetRatio: number): CompressorOutput {
  const originalChars = content.length;
  const passthrough: CompressorOutput = {
    content,
    compressed: false,
    charsBefore: originalChars,
    charsAfter: originalChars,
    contentType: "passthrough",
  };

  const lines = content.split("\n");
  if (lines.length < 20) {
    return passthrough;
  }

  // Parse into hunks
  const hunks = parseHunks(lines);
  if (hunks.length === 0) {
    return passthrough;
  }

  const result: string[] = [];
  let additionsCompressed = 0;
  let removalsKept = 0;

  for (const hunk of hunks) {
    // Keep hunk header
    result.push(hunk.header);

    for (const segment of hunk.segments) {
      if (segment.type === "context") {
        // Keep all context lines
        result.push(...segment.lines);
      } else if (segment.type === "removal") {
        // Always keep removals — they show what changed
        result.push(...segment.lines);
        removalsKept += segment.lines.length;
      } else if (segment.type === "addition") {
        if (segment.lines.length <= 6) {
          // Keep short additions in full
          result.push(...segment.lines);
        } else {
          // Keep first 3 and last 3 lines of large additions
          result.push(...segment.lines.slice(0, 3));
          const omitted = segment.lines.length - 6;
          result.push(`+... (${omitted} lines added) ...`);
          result.push(...segment.lines.slice(-3));
          additionsCompressed += omitted;
        }
      }
    }
  }

  if (additionsCompressed === 0) {
    return passthrough;
  }

  const compressed = result.join("\n");
  if (compressed.length >= originalChars * 0.7) {
    return passthrough;
  }

  return {
    content: compressed,
    compressed: true,
    charsBefore: originalChars,
    charsAfter: compressed.length,
    contentType: "diff",
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type DiffSegment = {
  type: "context" | "addition" | "removal";
  lines: string[];
};

type DiffHunk = {
  header: string;
  segments: DiffSegment[];
};

function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let currentSegment: DiffSegment | null = null;

  // Accumulate header lines before first hunk
  let headerDone = false;

  for (const line of lines) {
    const hunkMatch = HUNK_HEADER.exec(line);

    if (hunkMatch) {
      headerDone = true;
      // Start new hunk
      currentHunk = { header: line, segments: [] };
      hunks.push(currentHunk);
      currentSegment = null;
      continue;
    }

    if (!headerDone || !currentHunk) {
      // Diff header lines (diff --git, index, ---, +++) — keep them
      // These aren't hunks, we'll handle them separately
      continue;
    }

    const type = line.startsWith("+") ? "addition" : line.startsWith("-") ? "removal" : "context";

    if (!currentSegment || currentSegment.type !== type) {
      currentSegment = { type, lines: [] };
      currentHunk.segments.push(currentSegment);
    }

    currentSegment.lines.push(line);
  }

  return hunks;
}
