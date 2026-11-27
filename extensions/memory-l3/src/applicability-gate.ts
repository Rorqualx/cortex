/**
 * QW-1 (2026-11-25): Scope-enforced retrieval — Engram-style applicability
 * gating at the injection surface.
 *
 * Gated Memory (PROMPT_VERSION=19) lets the extraction LLM tag typed facts
 * whose value only holds within a scope — a specific host, device, project,
 * or environment — with 1-5 short scope tokens taken VERBATIM from the
 * conversation (e.g. ["duckie"]). Those tokens are threaded through
 * promotion/supersession (`longterm-typed.ts`) and export, but retrieval
 * never enforced them: scoped facts were injected unconditionally, letting
 * host- or project-bound values fire out of scope.
 *
 * This module implements the v1 enforcement predicate. Strict by design:
 * a scope token "holds" iff it matches the current retrieval context
 * EXACTLY — either equal (case-insensitive) to the current agent identity,
 * or present verbatim at word boundaries in the current query text. No
 * fuzzy interpretation, no substring matches inside larger words. A fact
 * with no applicability tokens is unconstrained and always passes.
 *
 * Dropped ≠ deleted: gating only affects injection. The underlying fact
 * stays canonical in the store for forensics and re-retrieval in a
 * matching context.
 */

export type ApplicabilityContext = {
  /** Identity of the agent whose context is being assembled (e.g. "main").
   * Matched exactly (case-insensitive) against scope tokens — a fact scoped
   * to a token equal to the current agent id holds. Null/absent = no agent
   * identity available (only query-text matching applies). */
  agentId?: string | null;
  /** The current retrieval query text. A scope token that appears verbatim
   * at word boundaries in this text holds — the conversation is currently
   * in that scope. Absent = no query text available. */
  queryText?: string;
};

/** Escape regex metacharacters so a scope token is matched literally. */
function escapeRegExp(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cached compiled word-boundary matchers per scope token (per-process). */
const boundaryMatcherCache = new Map<string, RegExp>();

/** Case-insensitive matcher for `token` occurring at word boundaries in text.
 * Uses lookarounds (not \b) so tokens with non-word edges (e.g. ".env",
 * "192.168.50.0/24") still anchor correctly. */
function boundaryMatcher(token: string): RegExp {
  const key = token.toLowerCase();
  const cached = boundaryMatcherCache.get(key);
  if (cached) {
    return cached;
  }
  const re = new RegExp(`(?<!\\w)${escapeRegExp(token)}(?!\\w)`, "i");
  if (boundaryMatcherCache.size > 500) {
    boundaryMatcherCache.clear();
  }
  boundaryMatcherCache.set(key, re);
  return re;
}

/**
 * Does a single scope token hold in the given context?
 * Strict exact-match semantics:
 * - token equals the current agent id (case-insensitive) → holds
 * - token appears verbatim at word boundaries in the query text → holds
 * - otherwise → does not hold
 */
export function scopeTokenHolds(token: string, ctx: ApplicabilityContext): boolean {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    // Pathological empty token (normalizeApplicability drops these) —
    // treat as unconstrained so a bad token can never wedge a fact.
    return true;
  }
  if (
    ctx.agentId &&
    ctx.agentId.length > 0 &&
    trimmed.toLowerCase() === ctx.agentId.toLowerCase()
  ) {
    return true;
  }
  if (ctx.queryText && ctx.queryText.length > 0) {
    return boundaryMatcher(trimmed).test(ctx.queryText);
  }
  return false;
}

/**
 * Does a fact's applicability scope hold in the given context?
 * Unscoped facts (undefined/empty applicability) always hold.
 * Scoped facts hold iff ANY scope token holds (Engram OR-semantics:
 * a fact valid on multiple models holds if any match applies).
 */
export function scopeHolds(
  applicability: readonly string[] | undefined,
  ctx: ApplicabilityContext,
): boolean {
  if (!applicability || applicability.length === 0) {
    return true;
  }
  return applicability.some((token) => scopeTokenHolds(token, ctx));
}

/**
 * Filter retrieval results to facts whose applicability scope holds.
 * Generic over the result shape so it can gate `RetrievedFact[]` or any
 * wrapper around an `L2Fact`-shaped payload. Returns a new array (the
 * input is untouched); order is preserved.
 */
export function filterApplicabilityScoped<T extends { fact: { applicability?: string[] } }>(
  results: readonly T[],
  ctx: ApplicabilityContext,
): T[] {
  return results.filter((r) => scopeHolds(r.fact.applicability, ctx));
}
