/**
 * Schema-drift detection for Skill Forge (from ScrambleToolBench, finding #7).
 *
 * When a tool's response shape changes (API schema updated, new error format,
 * different key structure), cached skills that assume the old shape will keep
 * retrying with stale assumptions — "belief inertia." This module computes
 * lightweight tool-response signatures from trajectory events and detects
 * divergence against a stored baseline.
 *
 * Detection is conservative: high threshold, log-only by default. The goal is
 * to flag skills that need re-evaluation, not to aggressively retire them.
 */

import type { TrajectoryEvent } from "../trajectory/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Statistical fingerprint of a set of tool responses. */
export type ToolResponseSignature = {
  /** Median response length in characters (P50 of observed lengths). */
  medianLength: number;
  /** Interquartile range of response lengths (P75 - P25). */
  iqrLength: number;
  /** Fraction of responses that were errors [0–1]. */
  errorRate: number;
  /** Top-level JSON keys observed (when responses are JSON), capped at 20. */
  jsonKeys: readonly string[];
  /** Number of tool responses sampled. */
  sampleSize: number;
};

/** Result of comparing two signatures. */
export type DriftResult = {
  /** Divergence score [0–1]. Higher = more drifted. */
  divergence: number;
  /** Human-readable signals that contributed to the score. */
  signals: string[];
  /** Whether divergence exceeds the drift threshold. */
  isDrifted: boolean;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Minimum sample size for a meaningful signature. */
const MIN_SAMPLE_SIZE = 3;

/** Divergence threshold above which a skill is flagged as drift-suspected. */
export const DEFAULT_DRIFT_THRESHOLD = 0.5;

/** Maximum JSON keys to track in a signature. */
const MAX_JSON_KEYS = 20;

function extractContentLength(event: TrajectoryEvent): number | undefined {
  if (event.type !== "tool.result") {
    return undefined;
  }
  const content = event.data?.message?.content;
  if (typeof content === "string") {
    return content.length;
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const block of content) {
      if (block && typeof block === "object") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") {
          total += text.length;
        }
      }
    }
    return total;
  }
  return 0;
}

function isToolErrorResult(event: TrajectoryEvent): boolean {
  if (event.type !== "tool.result") {
    return false;
  }
  const message = event.data?.message;
  if (!message || typeof message !== "object") {
    return false;
  }
  if ((message as { isError?: unknown }).isError === true) {
    return true;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return /\b(error|failed|exception|traceback)\b/iu.test(content);
  }
  return false;
}

function extractJsonKeys(event: TrajectoryEvent): string[] {
  if (event.type !== "tool.result") {
    return [];
  }
  const content = event.data?.message?.content;
  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("\n");
  }
  if (!text || text.length === 0) {
    return [];
  }
  // Try to parse as JSON and extract top-level keys.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.keys(parsed).slice(0, MAX_JSON_KEYS);
    }
  } catch {
    // Not JSON — skip.
  }
  return [];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a tool-response signature from trajectory events.
 * Returns undefined when there are too few samples for a meaningful signature.
 */
export function computeToolResponseSignature(
  events: TrajectoryEvent[],
): ToolResponseSignature | undefined {
  const lengths: number[] = [];
  let errorCount = 0;
  let total = 0;
  const keySet = new Set<string>();

  for (const event of events) {
    if (event.type !== "tool.result") continue;
    const len = extractContentLength(event);
    if (len === undefined) continue;
    lengths.push(len);
    total += 1;
    if (isToolErrorResult(event)) {
      errorCount += 1;
    }
    for (const key of extractJsonKeys(event)) {
      keySet.add(key);
      if (keySet.size >= MAX_JSON_KEYS) break;
    }
  }

  if (total < MIN_SAMPLE_SIZE) {
    return undefined;
  }

  lengths.sort((a, b) => a - b);
  const p25 = percentile(lengths, 25);
  const p50 = percentile(lengths, 50);
  const p75 = percentile(lengths, 75);

  return {
    medianLength: p50,
    iqrLength: p75 - p25,
    errorRate: errorCount / total,
    jsonKeys: [...keySet].sort(),
    sampleSize: total,
  };
}

/**
 * Compare two tool-response signatures and compute a divergence score.
 *
 * The divergence is a weighted combination of:
 * - Length shift: how much the median response length changed (relative).
 * - Error-rate shift: absolute change in error rate.
 * - Key overlap: fraction of baseline keys missing from current.
 */
export function detectSchemaDrift(
  baseline: ToolResponseSignature,
  current: ToolResponseSignature,
  threshold: number = DEFAULT_DRIFT_THRESHOLD,
): DriftResult {
  const signals: string[] = [];
  let divergence = 0;

  // Length shift (weight: 0.35)
  if (baseline.medianLength > 0) {
    const lengthRatio =
      Math.abs(current.medianLength - baseline.medianLength) / baseline.medianLength;
    // Cap at 1.0 — a 2x+ change is fully drifted for this signal.
    const lengthSignal = Math.min(1, lengthRatio);
    divergence += lengthSignal * 0.35;
    if (lengthSignal > 0.3) {
      signals.push(
        `median length shifted ${current.medianLength} vs baseline ${baseline.medianLength} (${(lengthRatio * 100).toFixed(0)}% change)`,
      );
    }
  }

  // Error-rate shift (weight: 0.35)
  const errorDelta = Math.abs(current.errorRate - baseline.errorRate);
  divergence += errorDelta * 0.35;
  if (errorDelta > 0.2) {
    signals.push(
      `error rate shifted from ${(baseline.errorRate * 100).toFixed(0)}% to ${(current.errorRate * 100).toFixed(0)}%`,
    );
  }

  // Key overlap (weight: 0.30)
  if (baseline.jsonKeys.length > 0) {
    const baselineKeys = new Set(baseline.jsonKeys);
    const currentKeys = new Set(current.jsonKeys);
    const missing = [...baselineKeys].filter((k) => !currentKeys.has(k));
    const missingFraction = missing.length / baseline.jsonKeys.length;
    divergence += missingFraction * 0.3;
    if (missingFraction > 0.3) {
      signals.push(`missing JSON keys vs baseline: ${missing.join(", ")}`);
    }
  }

  // Clamp divergence to [0, 1].
  divergence = Math.min(1, divergence);

  return {
    divergence,
    signals,
    isDrifted: divergence >= threshold,
  };
}
