// F8 (2026-08-28): dangling-reference metric for the compression pipeline.
// A "dangling reference" is a capitalized entity / defined term that had a
// textual anchor in the pre-compression content but lost it after
// compression — the compressed output (or its neighbors) can then mention a
// term whose antecedent is gone. This module is the cheap, deterministic
// measure-first half: report the rate per compressor type, and only build a
// hard definition-pull mechanism if real traffic shows meaningful dangling.
//
// Heuristics are deliberately conservative:
// - multi-word capitalized entities ("Pi-hole Gateway", "Huey The Destroyer")
// - ALL-CAPS acronyms of 2-8 letters ("QMD", "MTU", "CCR")
// - a small stoplist filters sentence-leading function words.

export const DANGLING_STOPWORDS = new Set([
  "The",
  "This",
  "That",
  "These",
  "Those",
  "And",
  "But",
  "For",
  "With",
  "From",
  "Into",
  "Over",
  "Under",
  "Then",
  "When",
  "Also",
  "Note",
  "Error",
  "Warning",
  "Failed",
  "Success",
  "Response",
  "Request",
]);

// Linear-time patterns: separator-led repetitions, no nested quantifiers
// over an ambiguous alphabet (kept ReDoS-safe per skill-forge gate history).
const MULTI_WORD_ENTITY = /\b[A-Z][a-z0-9]+(?:[ -][A-Z][a-z0-9]+)+\b/g;
const ACRONYM = /\b[A-Z]{2,8}\b/g;

/** Candidate referents (entities / defined terms) appearing in `text`. */
export function extractReferents(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) {
    return out;
  }
  for (const m of text.matchAll(MULTI_WORD_ENTITY)) {
    const value = m[0];
    if (value && !DANGLING_STOPWORDS.has(value.split(/[ -]/)[0]!)) {
      out.add(value);
    }
  }
  for (const m of text.matchAll(ACRONYM)) {
    if (m[0]) {
      out.add(m[0]);
    }
  }
  return out;
}

export type DanglingReferenceStats = {
  /** Distinct referents seen in the source content (denominator). */
  referentCount: number;
  /** Referents with no anchor left after compression. */
  danglingCount: number;
  /** danglingCount / referentCount, rounded to 2dp. 0 when nothing to measure. */
  rate: number;
  /** Dropped referents themselves (sorted, capped for reporting). */
  dangling: string[];
};

/**
 * Compare pre- and post-compression text and report which referents lost
 * their last textual anchor. A rate near 0 means compression preserved the
 * entities it kept mentioning; a high rate means definitions are being
 * crushed — the trigger condition for a definition-pull mechanism.
 */
export function danglingReferenceStats(before: string, after: string): DanglingReferenceStats {
  const beforeRefs = extractReferents(before);
  const afterRefs = extractReferents(after);
  const dangling: string[] = [];
  for (const ref of beforeRefs) {
    if (!afterRefs.has(ref)) {
      dangling.push(ref);
    }
  }
  dangling.sort();
  return {
    referentCount: beforeRefs.size,
    danglingCount: dangling.length,
    rate: beforeRefs.size > 0 ? Math.round((dangling.length / beforeRefs.size) * 100) / 100 : 0,
    dangling: dangling.slice(0, 20),
  };
}
