/**
 * SearchCompressor — compresses grep/glob/file-listing output.
 *
 * Detects `file:line:content` format (standard grep output) or plain file
 * path listings. Groups by file, keeps a representative subset per file,
 * preserves error matches, and adds a summary line.
 */
import type { CompressorOutput } from "./types.js";

/** Pattern: /path/to/file:123:matched text here */
const GREP_LINE = /^(.+?):(\d+):(.*)$/;
/** Pattern: /path/to/file:123-456:matched text (line ranges) */
const GREP_RANGE = /^(.+?):(\d+)-(\d+):(.*)$/;

export function compressSearchResults(content: string, targetRatio: number): CompressorOutput {
  const originalChars = content.length;
  const passthrough: CompressorOutput = {
    content,
    compressed: false,
    charsBefore: originalChars,
    charsAfter: originalChars,
    contentType: "passthrough",
  };

  const lines = content.split("\n");
  if (lines.length < 10) {
    return passthrough;
  }

  // Detect format
  const grepMatches = lines.map((line) => parseGrepLine(line));
  const grepCount = grepMatches.filter(Boolean).length;

  if (grepCount < lines.length * 0.6) {
    // Not enough grep-formatted lines — try as file listing
    return compressFileListing(content, targetRatio);
  }

  // Group by file
  const byFile = new Map<string, GrepEntry[]>();
  let totalMatches = 0;
  let errorMatches = 0;

  for (const match of grepMatches) {
    if (!match) {
      continue;
    }
    totalMatches++;
    const isErr = isErrorLine(match.text);
    if (isErr) {
      errorMatches++;
    }

    let entries = byFile.get(match.file);
    if (!entries) {
      entries = [];
      byFile.set(match.file, entries);
    }
    entries.push(match);
  }

  if (totalMatches === 0 || byFile.size === 0) {
    return passthrough;
  }

  // Select representative lines per file
  const maxPerFile = Math.max(2, Math.ceil(targetRatio * 10));
  const selected: GrepEntry[] = [];

  for (const [, entries] of byFile) {
    // Always include error matches
    const errors = entries.filter((e) => isErrorLine(e.text));
    const nonErrors = entries.filter((e) => !isErrorLine(e.text));

    // Take first, last, and fill with errors
    const fileSelected: GrepEntry[] = [];
    if (nonErrors.length > 0) {
      // Index 0 exists: length > 0 checked above.
      fileSelected.push(nonErrors[0]!); // first match
    }
    if (nonErrors.length > 1) {
      // Last index exists: length > 1 checked above.
      fileSelected.push(nonErrors[nonErrors.length - 1]!); // last match
    }

    // Add error matches (always kept)
    for (const err of errors) {
      if (!fileSelected.includes(err)) {
        fileSelected.push(err);
      }
    }

    // Trim to maxPerFile if needed (keep errors though)
    const trimmed = fileSelected.slice(0, maxPerFile);
    selected.push(...trimmed);
  }

  if (selected.length >= totalMatches * 0.9) {
    // Not enough savings
    return passthrough;
  }

  // Sort by original order
  selected.sort((a, b) => a.line - b.line || a.file.localeCompare(b.file));

  // Build output
  const summaryLine = `${totalMatches} matches across ${byFile.size} files (showing ${selected.length})${errorMatches > 0 ? `, ${errorMatches} errors` : ""}`;
  const resultLines = selected.map((e) => `${e.file}:${e.line}:${e.text}`);
  const result = summaryLine + "\n" + resultLines.join("\n");

  if (result.length >= originalChars * 0.7) {
    return passthrough; // not enough savings
  }

  return {
    content: result,
    compressed: true,
    charsBefore: originalChars,
    charsAfter: result.length,
    contentType: "search",
  };
}

// ---------------------------------------------------------------------------
// File listing compression
// ---------------------------------------------------------------------------

function compressFileListing(content: string, _targetRatio: number): CompressorOutput {
  const originalChars = content.length;
  const lines = content.split("\n").filter((l) => l.trim().length > 0);

  if (lines.length < 20) {
    return {
      content,
      compressed: false,
      charsBefore: originalChars,
      charsAfter: originalChars,
      contentType: "passthrough",
    };
  }

  // Group by directory
  const byDir = new Map<string, string[]>();
  for (const line of lines) {
    const parts = line.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    let list = byDir.get(dir);
    if (!list) {
      list = [];
      byDir.set(dir, list);
    }
    list.push(line);
  }

  // Keep first and last per directory, plus summary
  const kept: string[] = [];
  for (const [dir, files] of byDir) {
    // byDir lists are non-empty: each is created with an initial push above.
    kept.push(files[0]!);
    if (files.length > 1) {
      // Last index exists: length > 1 checked above.
      kept.push(files[files.length - 1]!);
    }
    if (files.length > 2) {
      kept.push(`  ... (${files.length - 2} more in ${dir})`);
    }
  }

  const summary = `${lines.length} files across ${byDir.size} directories (showing ${kept.length} entries)`;
  const result = summary + "\n" + kept.join("\n");

  return {
    content: result,
    compressed: true,
    charsBefore: originalChars,
    charsAfter: result.length,
    contentType: "search",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type GrepEntry = {
  file: string;
  line: number;
  text: string;
};

function parseGrepLine(line: string): GrepEntry | null {
  // Try range format first
  const rangeMatch = GREP_RANGE.exec(line);
  if (rangeMatch) {
    // GREP_RANGE capture groups 1-4 are non-optional, so always defined on a match.
    return {
      file: rangeMatch[1]!,
      line: Number.parseInt(rangeMatch[2]!, 10),
      text: rangeMatch[4]!,
    };
  }
  // Try standard format
  const match = GREP_LINE.exec(line);
  if (match) {
    // GREP_LINE capture groups 1-3 are non-optional, so always defined on a match.
    return { file: match[1]!, line: Number.parseInt(match[2]!, 10), text: match[3]! };
  }
  return null;
}

function isErrorLine(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("error") ||
    lower.includes("exception") ||
    lower.includes("fail") ||
    lower.includes("fatal") ||
    lower.includes("traceback")
  );
}
