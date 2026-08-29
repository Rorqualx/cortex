/**
 * Entropy Estimator — token-type uniqueness ratio (TTUR) classification.
 *
 * ARCH-3 entropy-guided compression budget (SeKV-style resolution adaptivity):
 * information density varies across tool-result content. Low-entropy spans
 * (logs, repetitive JSON arrays) tolerate aggressive compression; high-
 * uniqueness spans (diverse prose, plans) should be preserved.
 *
 * Metric: TTUR = unique normalized token types / total tokens.
 * Pure string statistics — O(n) in content length, no model required.
 *
 * Tokenizer (probe amendment 2026-08-17): split on non-word boundaries after
 * lowercasing, keeping [a-z0-9_]. Whitespace-only splitting false-classified
 * minified JSON as low-entropy (whole payload = one token); the amended
 * tokenizer splits punctuation runs so compact JSON is scored correctly while
 * snake_case identifiers stay whole.
 */

export type EntropyBucket = "low" | "medium" | "high";

export interface EntropyEstimate {
  bucket: EntropyBucket;
  /** 0.0–1.0 — higher = more unique token types = lower entropy. */
  ttur: number;
  uniqueTokens: number;
  totalTokens: number;
}

/** Split text into normalized token types: lowercase, keep [a-z0-9_]. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter(Boolean);
}

/**
 * Estimate the entropy bucket of a content string.
 *
 * Thresholds (SeKV empirical calibration):
 *   ttur > 0.6      → low  (information-dense, preserve — bucket ratio 0.7)
 *   0.3 < ttur ≤ 0.6 → medium (standard compression — bucket ratio 0.3)
 *   ttur ≤ 0.3      → high (repetitive, compress hard — bucket ratio 0.15)
 *
 * Strings with fewer than 10 tokens are treated as low-entropy
 * (preserve-by-default): too short to estimate reliably.
 */
export function estimateEntropy(text: string): EntropyEstimate {
  const tokens = tokenize(text);
  if (tokens.length < 10) {
    return {
      bucket: "low",
      ttur: 1.0,
      uniqueTokens: new Set(tokens).size,
      totalTokens: tokens.length,
    };
  }

  const tokenTypes = new Set<string>();
  for (const token of tokens) {
    tokenTypes.add(token);
  }

  const ttur = tokenTypes.size / tokens.length;

  let bucket: EntropyBucket;
  if (ttur > 0.6) {
    bucket = "low";
  } else if (ttur > 0.3) {
    bucket = "medium";
  } else {
    bucket = "high";
  }

  return {
    bucket,
    ttur,
    uniqueTokens: tokenTypes.size,
    totalTokens: tokens.length,
  };
}
