// Verbatim source-grounding for typed facts. The LLM extractor emits
// {value, sourceSpan} pairs; we reject any pair where the value or its
// surrounding span doesn't appear in the original transcript character-for-
// character. This is the cheap defense against hallucinated digits — Nature
// 2025 reports it closes ~10-20% of numeric extraction errors at near-zero
// cost. No regex magic; just two indexOf checks.

import type { ExtractedTypedFact } from "./llm.js";

export type GroundingFailureReason =
  | "value_empty"
  | "span_empty"
  | "value_not_in_span"
  | "span_not_in_transcript";

export type GroundingResult = { ok: true } | { ok: false; reason: GroundingFailureReason };

export function groundTypedFact(
  fact: { value: string; sourceSpan: string },
  transcript: string,
): GroundingResult {
  if (fact.value.length === 0) {
    return { ok: false, reason: "value_empty" };
  }
  if (fact.sourceSpan.length === 0) {
    return { ok: false, reason: "span_empty" };
  }
  if (!fact.sourceSpan.includes(fact.value)) {
    return { ok: false, reason: "value_not_in_span" };
  }
  if (!transcript.includes(fact.sourceSpan)) {
    return { ok: false, reason: "span_not_in_transcript" };
  }
  return { ok: true };
}

/**
 * Filter typed facts to only those that pass grounding, AND drop later
 * duplicates by slot (first occurrence wins — matches `dedupWithinChunk`'s
 * convention for prose facts).
 */
export function groundAndDedupTypedFacts(
  facts: ReadonlyArray<ExtractedTypedFact>,
  transcript: string,
): ExtractedTypedFact[] {
  const seenSlots = new Set<string>();
  const out: ExtractedTypedFact[] = [];
  for (const fact of facts) {
    if (seenSlots.has(fact.slot)) {
      continue;
    }
    const result = groundTypedFact(fact, transcript);
    if (!result.ok) {
      continue;
    }
    seenSlots.add(fact.slot);
    out.push(fact);
  }
  return out;
}
