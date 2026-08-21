/**
 * Temporal preservation for the context compression pipeline.
 *
 * The compressors in this pipeline are deterministic (sampling, clustering,
 * truncation) — they never rewrite retained text, but they DO drop whole
 * items/lines. When elided content carried dates/times, the temporal anchors
 * vanished with it, silently degrading later time-based reasoning/retrieval.
 *
 * Rule (mirrors the memory-l3 TEMPORAL rule, llm.ts EXTRACT_SYSTEM_PROMPT):
 * preserve dates and times — retained content keeps them verbatim, and elided
 * content leaves behind a compact time-range anchor so the span stays
 * recoverable (exact values remain available via `ccr_retrieve`).
 */

/**
 * Linear-time ISO-8601-ish timestamp pattern (no nested quantifiers).
 * Matches: 2026-08-21T12:00:00Z, 2026-08-21 12:00:00.123+02:00, 2026/08/21 09:30:00
 */
const TIMESTAMP_RE =
  /\d{4}[-/]\d{2}[-/]\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?/g;

/**
 * Extract timestamp tokens from content, in order of appearance.
 * Used to compute the time range of elided content.
 */
export function extractTimestamps(content: string): string[] {
  const matches = content.match(TIMESTAMP_RE);
  return matches ?? [];
}

/**
 * Build a one-line time-range anchor for compressed output.
 * Returns null when there are fewer than 2 distinct timestamps (nothing to anchor).
 * Format: [time range of full output: <first> .. <last>]
 */
export function buildTimeRangeLine(timestamps: string[]): string | null {
  if (timestamps.length < 2) {
    return null;
  }
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  if (first === last) {
    return null;
  }
  return `[time range of full output: ${first} .. ${last}]`;
}

/**
 * Field-name heuristics for timestamp-like keys in JSON array items.
 * Matches exact common names and *_at/*At/*Time/*Date suffixes.
 */
const TIME_FIELD_EXACT = new Set([
  "timestamp",
  "time",
  "date",
  "at",
  "created_at",
  "updated_at",
  "logged_at",
  "modified_at",
  "occurred_at",
  "when",
]);

export function isTimestampField(key: string): boolean {
  if (TIME_FIELD_EXACT.has(key.toLowerCase())) {
    return true;
  }
  return /(_at|At|Time|Date)$/.test(key);
}

/**
 * Compute the [min, max] verbatim values of a timestamp-like string field
 * across items. Lexicographic comparison — correct for ISO-8601 strings,
 * the dominant encoding. Returns null when the field is absent/not stringly.
 */
export function fieldTimeRange(
  items: Record<string, unknown>[],
  field: string,
): [string, string] | null {
  let min: string | null = null;
  let max: string | null = null;
  for (const item of items) {
    const value = item[field];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    if (min === null || value < min) {
      min = value;
    }
    if (max === null || value > max) {
      max = value;
    }
  }
  if (min === null || max === null) {
    return null;
  }
  return [min, max];
}

/**
 * Find the first timestamp-like string field present across all items.
 * Returns null when no candidate field exists.
 */
export function findTimestampField(items: Record<string, unknown>[]): string | null {
  const first = items[0];
  if (!first) {
    return null;
  }
  for (const key of Object.keys(first)) {
    if (isTimestampField(key) && typeof first[key] === "string") {
      return key;
    }
  }
  return null;
}
