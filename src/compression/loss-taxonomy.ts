/**
 * Loss-taxonomy anchor detection for the compression pipeline.
 *
 * Deterministic counterpart of the memory-l3 LOSS-TAXONOMY prompt rule
 * (PROMPT_VERSION=21, Sleeping-Agent loss taxonomy, arXiv:2608.11775):
 * entity–attribute bindings, quantities with units, and negations are the
 * three detail classes most frequently lost under compression. Text carrying
 * them is preferentially retained so those classes survive compression and
 * can drive later retrieval.
 *
 * All patterns run in linear time (no nested or overlapping quantifiers).
 */

/** Quantities: a number attached to a unit (size, duration, count, money).
 * `\s*` so compact forms ("250ms", "85%") match alongside spaced ones ("4 TB").
 * Trailing `(?![a-z0-9])` instead of `\b` — `\b` never holds after `%`. */
const QUANTITY_RE =
  /\b\d+(?:\.\d+)?\s*(?:tb|gb|mb|kb|b|km|mi|m|cm|ft|in|kg|g|ms|s|h|hr|hrs|min|days?|weeks?|months?|years?|usd|eur|gbp|dollars|cents|%|x)(?![a-z0-9])/i;

/** Negation markers: dropping one inverts the meaning of the statement. */
const NEGATION_RE =
  /\b(?:not|never|no longer|cannot|can't|don't|doesn't|didn't|won't|wouldn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't)\b/i;

/** Entity–attribute bindings: a proper-noun possessor attached to an attribute
 * (any-case: "Huey's disk", "Maria's Laptop") — the binding is what compression loses. */
const ENTITY_BINDING_RE = /\b[A-Z][A-Za-z0-9]*'s\s+[A-Za-z][a-zA-Z0-9-]+/;

/** True when the text contains a quantity with an explicit unit. */
export function hasQuantity(text: string): boolean {
  return text.length > 0 && QUANTITY_RE.test(text);
}

/** True when the text contains an explicit negation marker. */
export function hasNegation(text: string): boolean {
  return text.length > 0 && NEGATION_RE.test(text);
}

/** True when the text contains a proper-noun entity–attribute binding. */
export function hasEntityBinding(text: string): boolean {
  return text.length > 0 && ENTITY_BINDING_RE.test(text);
}

/**
 * True when the text carries any loss-taxonomy anchor: an entity–attribute
 * binding, a quantity with unit, or a negation. These are the details whose
 * loss corrupts memory (reattached values, rounded numbers, inverted
 * meaning), so compression prefers keeping them at the margin.
 */
export function hasLossTaxonomyAnchor(text: string): boolean {
  return text.length > 0 && (hasQuantity(text) || hasNegation(text) || hasEntityBinding(text));
}
