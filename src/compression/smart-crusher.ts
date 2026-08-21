import { buildFieldStats, findConstantFields, scoreItem } from "./scoring.js";
import { fieldTimeRange, findTimestampField } from "./temporal.js";
/**
 * SmartCrusher — JSON array statistical sampling compressor.
 *
 * Handles the highest-token tool outputs: API responses, grep JSON results,
 * file listings, and any JSON array content.
 *
 * Algorithm:
 *  1. Try JSON.parse on tool result content
 *  2. If it's an array of objects:
 *     a. Compute per-field stats
 *     b. Score each item (error keywords + unique values + position)
 *     c. Select top N items using 30/15/55 split
 *     d. Factor out constant fields into a header
 *     e. Reconstruct compact JSON with _stats summary
 *  3. If parse fails or not an array → passthrough
 */
import type { CompressorOutput } from "./types.js";

export function crushJsonArray(
  content: string,
  maxItems: number,
  targetRatio: number,
): CompressorOutput {
  const originalChars = content.length;
  const passthrough: CompressorOutput = {
    content,
    compressed: false,
    charsBefore: originalChars,
    charsAfter: originalChars,
    contentType: "passthrough",
  };

  // Quick reject: must look like JSON array
  const trimmed = content.trim();
  if (!trimmed.startsWith("[")) {
    return passthrough;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return passthrough;
  }

  if (!Array.isArray(parsed)) {
    return passthrough;
  }

  // Not enough items to compress
  if (parsed.length <= maxItems) {
    return passthrough;
  }

  // Only compress arrays of objects (not primitives)
  const objectItems = parsed.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );

  if (objectItems.length < maxItems) {
    return passthrough;
  }

  // Build field statistics
  const fieldStats = buildFieldStats(objectItems);
  const constantFields = findConstantFields(fieldStats);

  // Score all items
  const scored = objectItems.map((item, index) => ({
    item,
    score: scoreItem(item, index, objectItems.length, fieldStats),
    index,
  }));

  // Select items using 30/15/55 split
  const selected = selectItems(scored, maxItems);

  // Build header with constant fields
  const header: Record<string, unknown> = {};
  const firstSelected = selected[0];
  if (constantFields.length > 0 && firstSelected) {
    const firstItem = firstSelected.item;
    for (const field of constantFields) {
      if (field in firstItem) {
        header[field] = firstItem[field];
      }
    }
  }

  // Build compact items — strip constant fields
  const compactItems = selected.map((entry) => {
    const compact: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry.item)) {
      if (!constantFields.includes(key)) {
        compact[key] = value;
      }
    }
    return compact;
  });

  // Detect errors in original
  const errorCount = objectItems.filter((item) =>
    Object.values(item).some((v) => {
      const s = typeof v === "string" ? v.toLowerCase() : "";
      return s.includes("error") || s.includes("exception") || s.includes("fail");
    }),
  ).length;

  // Unique files (if there's a file/path field)
  const fileField = Object.keys(objectItems[0] || {}).find(
    (k) => k === "file" || k === "path" || k === "filename" || k === "filePath",
  );
  const uniqueFiles = fileField
    ? new Set(objectItems.map((item) => String(item[fileField] ?? ""))).size
    : undefined;

  // Temporal preservation: sampled-out items may have carried the extremes of
  // the time span — record the full range in _stats so it survives sampling.
  const timeField = findTimestampField(objectItems);
  const timeRange = timeField ? fieldTimeRange(objectItems, timeField) : null;

  // Build output
  const output: Record<string, unknown> = {};
  if (Object.keys(header).length > 0) {
    output._constant_fields = header;
  }
  output._stats = {
    total: objectItems.length,
    ...(errorCount > 0 ? { errors: errorCount } : {}),
    ...(uniqueFiles ? { files: uniqueFiles } : {}),
    ...(timeRange ? { timeRange } : {}),
    showing: compactItems.length,
  };
  output.items = compactItems;

  const compressed = JSON.stringify(output, null, 2);

  // Check if compression actually saves enough
  if (compressed.length >= originalChars * targetRatio * 1.5) {
    // Not enough savings to justify compression — passthrough
    return passthrough;
  }

  return {
    content: compressed,
    compressed: true,
    charsBefore: originalChars,
    charsAfter: compressed.length,
    contentType: "json_array",
  };
}

// ---------------------------------------------------------------------------
// Selection algorithm
// ---------------------------------------------------------------------------

type ScoredItem = {
  item: Record<string, unknown>;
  score: number;
  index: number;
};

/**
 * Select representative items using 30/15/55 split:
 *   - 30% from the start of the array (gives model context about structure)
 *   - 15% from the end of the array (gives model the most recent results)
 *   - 55% by importance score (highest-scoring items)
 */
function selectItems(scored: ScoredItem[], maxItems: number): ScoredItem[] {
  const headCount = Math.max(1, Math.round(maxItems * 0.3));
  const tailCount = Math.max(1, Math.round(maxItems * 0.15));
  const meritCount = maxItems - headCount - tailCount;

  // Take head items (first N)
  const head = scored.slice(0, headCount);
  // Take tail items (last N)
  const tail = scored.slice(-tailCount);

  // Indices already taken
  const taken = new Set([...head, ...tail].map((s) => s.index));

  // Sort remaining by score descending, take top meritCount
  const remaining = scored
    .filter((s) => !taken.has(s.index))
    .toSorted((a, b) => b.score - a.score)
    .slice(0, Math.max(0, meritCount));

  // Merge and restore original order
  return [...head, ...remaining, ...tail].toSorted((a, b) => a.index - b.index);
}
