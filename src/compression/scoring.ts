/**
 * Importance scoring for JSON array items.
 *
 * Each item is scored on four dimensions:
 *   1. Error signals  — does it contain error/exception keywords?
 *   2. Uniqueness     — how many unique values does it carry vs. the dataset?
 *   3. Position       — start and end items are more informative than the middle.
 *   4. Temporal anchor — does it carry dates/times? Temporal grounding drives
 *      later retrieval, so anchored items are preferentially retained when
 *      sampling (deterministic counterpart of the memory-l3 temporal rule).
 *
 * Scores are normalised to [0, 1].
 */

import { hasTemporalAnchor } from "./temporal.js";

const ERROR_KEYWORDS = [
  "error",
  "exception",
  "fail",
  "fatal",
  "crash",
  "timeout",
  "refused",
  "denied",
  "abort",
  "panic",
  "corrupt",
  "invalid",
  "warning",
  "warn",
] as const;

/**
 * Score a single JSON item and return a [0, 1] importance value.
 *
 * @param item     — The parsed JSON object (or primitive).
 * @param index    — Position in the original array.
 * @param total    — Total items in the array.
 * @param fieldStats — Pre-computed per-field unique-value counts and total.
 */
export function scoreItem(
  item: unknown,
  index: number,
  total: number,
  fieldStats: Map<string, { unique: number; total: number }>,
): number {
  if (typeof item !== "object" || item === null) {
    // Primitives: just positional score
    return positionalScore(index, total);
  }

  const obj = item as Record<string, unknown>;
  const values = Object.values(obj);

  // 1. Error signal (0 or 1)
  const hasError = values.some((v) => {
    const s = typeof v === "string" ? v.toLowerCase() : "";
    return ERROR_KEYWORDS.some((kw) => s.includes(kw));
  });
  const errorScore = hasError ? 1 : 0;

  // 2b. Temporal anchor (0 or 1) — items carrying explicit dates/times are
  //     preferentially retained when sampling (temporal grounding survives
  //     compression and drives later retrieval).
  const hasTemporal = values.some((v) => typeof v === "string" && hasTemporalAnchor(v));
  const temporalScore = hasTemporal ? 1 : 0;

  // 2. Uniqueness (0–1) — fraction of this item's fields that have low-unique-ratio
  //    Items with high-entropy fields are more informative to keep.
  let uniquenessSum = 0;
  let fieldCount = 0;
  for (const key of Object.keys(obj)) {
    const stats = fieldStats.get(key);
    if (stats && stats.total > 0) {
      const uniqueRatio = stats.unique / stats.total;
      // High unique ratio = high entropy = valuable
      uniquenessSum += uniqueRatio;
      fieldCount++;
    }
  }
  const uniquenessScore = fieldCount > 0 ? uniquenessSum / fieldCount : 0.5;

  // 3. Positional score (0–1)
  const posScore = positionalScore(index, total);

  // Weighted combination: errors dominate, then uniqueness, then position,
  // with a small temporal-anchor preference.
  return 0.45 * errorScore + 0.3 * uniquenessScore + 0.15 * posScore + 0.1 * temporalScore;
}

/**
 * Build per-field statistics for a JSON array.
 * Returns a map from field name → { unique values, total values }.
 */
export function buildFieldStats(
  items: Record<string, unknown>[],
): Map<string, { unique: number; total: number; values: Set<string> }> {
  const map = new Map<string, { unique: number; total: number; values: Set<string> }>();

  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      let entry = map.get(key);
      if (!entry) {
        entry = { unique: 0, total: 0, values: new Set() };
        map.set(key, entry);
      }
      entry.total++;
      const serialized = typeof value === "object" ? JSON.stringify(value) : String(value);
      if (!entry.values.has(serialized)) {
        entry.values.add(serialized);
        entry.unique++;
      }
    }
  }

  return map;
}

/**
 * Identify fields whose values are constant across all items.
 * These can be factored out into a header.
 */
export function findConstantFields(
  fieldStats: Map<string, { unique: number; total: number; values: Set<string> }>,
): string[] {
  const constants: string[] = [];
  for (const [key, stats] of fieldStats) {
    if (stats.unique === 1 && stats.total > 1) {
      constants.push(key);
    }
  }
  return constants;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function positionalScore(index: number, total: number): number {
  if (total <= 2) {
    return 1;
  }
  const relativePos = index / (total - 1); // 0 = first, 1 = last
  // Peaks at start (0) and end (1), lowest in middle (0.5)
  // |x - 0.5| is 0.5 at edges, 0 in middle → multiply by 2 to get 1 at edges, 0 in middle
  return 2 * Math.abs(relativePos - 0.5);
}
