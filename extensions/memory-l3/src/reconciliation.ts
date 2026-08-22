// Cross-brain reconciler — the prose↔typed bridge of the corpus callosum.
// Loads the active prose long-term facts (right brain) and the active typed
// long-term facts (left brain), asks an LLM which prose facts contradict
// which typed values, and marks contradicted prose facts with
// `supersededBy: <slot>`. Retrieval skips superseded facts, so stale prose
// like "balance is around $500" no longer surfaces once the canonical typed
// fact says `user:account_balance = 750.00`.
//
// Runs at the same epoch boundary as the two consolidation passes, but only
// when there's something new in the typed tier to reconcile against. Cost
// is bounded by the total number of long-term facts (small by design — the
// promotion thresholds keep the working set tight).

import { parseJsonResponse, type LlmCaller } from "./llm.js";
import { formatLongTermBody } from "./longterm.js";
import { jaccard, nearDuplicateSimilarity, tokenize } from "./scoring.js";
import type { Storage } from "./storage.js";
import type { LongTermFact, LongTermFrontmatter, LongTermTypedFact } from "./types.js";

export type ReconcileOutput = {
  proseFactsConsidered: number;
  typedFactsConsidered: number;
  /** Prose facts that gained a new supersededBy mark this pass. */
  newlyMarkedStale: number;
  /** Prose facts that had a supersededBy mark cleared this pass. */
  unmarkedNowAgreed: number;
  /** Prose facts marked stale by deterministic supersession ground truth
   * (superseded typed value still present in prose text) rather than by an
   * LLM verdict. Absent when zero for log-shape stability. */
  deterministicStale?: number;
};

const RECONCILE_SYSTEM_PROMPT = `You are a memory reconciler. Compare prose facts (LLM-distilled, possibly outdated) to typed facts (verbatim values, current). When a prose fact contradicts a typed fact, the prose fact is STALE — typed values are canonical.

Reconcile each prose fact independently:
- "stale" — contradicts at least one typed fact. Include the typed fact's slot in supersededBy.
- "agreed" — consistent with all relevant typed facts, OR unrelated to any typed fact.

Be conservative: only mark "stale" when there is a clear factual contradiction. Vague paraphrases that don't disagree on facts are "agreed".

Output strict JSON only, no surrounding prose. Schema:
{
  "decisions": [
    { "factId": "lt-xxx", "verdict": "stale", "supersededBy": "user:account_balance" },
    { "factId": "lt-yyy", "verdict": "agreed" }
  ]
}

Include a decision for every prose fact you were given. If unsure, default to "agreed".`;

type Decision = {
  verdict: "stale" | "agreed";
  supersededBy: string | null;
};

/**
 * Deterministic typed-supersession ground truth (StateMem-inspired).
 *
 * When a typed slot's value was superseded (non-empty `history`), any active
 * prose fact that still contains the OLD value verbatim — and not the new
 * one — is provably stale, no LLM verdict required. This is the explicit
 * ground truth `reconcileCrossBrain` was missing: its LLM pass can only
 * guess at contradictions, while this check follows directly from the typed
 * supersession trail written by `supersede()` in `longterm-typed.ts`.
 *
 * Conservative gates (false positives suppress valid facts, so we gate hard):
 * - old value must be ≥3 chars (skip trivial fragments like "v2"->"v3" noise)
 * - skipped when the old value is a substring of the current value
 *   (e.g. "1.2.3" → "1.2.34": containment is ambiguous)
 * - skipped when the prose fact contains BOTH old and new values (it is
 *   narrating the change, not asserting the stale value as current)
 * - containment is case-sensitive verbatim `includes` (typed values are
 *   verbatim by construction)
 *
 * Returns prose-fact-id → superseding typed slot.
 */
export function detectSupersededValueStaleness(
  proseFacts: ReadonlyArray<LongTermFact>,
  typedFacts: ReadonlyArray<LongTermTypedFact>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const typed of typedFacts) {
    if (typed.archived || typed.history.length === 0) {
      continue;
    }
    for (const h of typed.history) {
      const oldValue = h.value.trim();
      if (oldValue.length < 3 || typed.value.includes(oldValue)) {
        continue;
      }
      for (const prose of proseFacts) {
        if (prose.archived || out.has(prose.id)) {
          continue;
        }
        if (prose.text.includes(oldValue) && !prose.text.includes(typed.value)) {
          out.set(prose.id, typed.slot);
        }
      }
    }
  }
  return out;
}

/**
 * Run a cross-brain reconciliation pass. Idempotent — if no LLM verdicts
 * change marks, the file is left untouched and counts return zero.
 *
 * Skips silently when either tier is empty (nothing to compare against).
 */
export async function reconcileCrossBrain(params: {
  storage: Storage;
  caller: LlmCaller;
  agentId: string | null;
  now: number;
}): Promise<ReconcileOutput> {
  const longterm = await params.storage.readLongTerm();
  const longtermTyped = await params.storage.readLongTermTyped();

  const activeProse = longterm.facts.filter((f) => !f.archived);
  const activeTyped = longtermTyped.facts.filter((f) => !f.archived);

  if (activeProse.length === 0 || activeTyped.length === 0) {
    return {
      proseFactsConsidered: activeProse.length,
      typedFactsConsidered: activeTyped.length,
      newlyMarkedStale: 0,
      unmarkedNowAgreed: 0,
    };
  }

  const userPrompt = buildReconcileUserPrompt(activeProse, activeTyped);
  const raw = await params.caller({
    systemPrompt: RECONCILE_SYSTEM_PROMPT,
    userPrompt,
    thinking: false,
  });

  const validIds = new Set(activeProse.map((f) => f.id));
  const validSlots = new Set(activeTyped.map((t) => t.slot));
  const decisions = parseDecisions(raw, validIds, validSlots);
  // Deterministic supersession ground truth outranks LLM verdicts: a prose
  // fact that still carries a superseded typed value is stale regardless of
  // what the reconciler LLM says, and an LLM "agreed" cannot clear it.
  const deterministicStale = detectSupersededValueStaleness(activeProse, activeTyped);

  let newlyMarkedStale = 0;
  let unmarkedNowAgreed = 0;
  const updatedFacts = longterm.facts.map((fact) => {
    if (fact.archived) {
      return fact;
    }
    const detSlot = deterministicStale.get(fact.id);
    if (detSlot !== undefined) {
      if (fact.supersededBy === detSlot) {
        return fact;
      }
      if (fact.supersededBy === null) {
        newlyMarkedStale += 1;
      }
      return { ...fact, supersededBy: detSlot };
    }
    const decision = decisions.get(fact.id);
    if (!decision) {
      return fact;
    }
    const priorMark = fact.supersededBy ?? null;
    if (decision.verdict === "stale") {
      if (priorMark === decision.supersededBy) {
        return fact;
      }
      if (priorMark === null) {
        newlyMarkedStale += 1;
      }
      return { ...fact, supersededBy: decision.supersededBy };
    }
    if (priorMark !== null) {
      unmarkedNowAgreed += 1;
      return { ...fact, supersededBy: null };
    }
    return fact;
  });

  if (newlyMarkedStale === 0 && unmarkedNowAgreed === 0) {
    return {
      proseFactsConsidered: activeProse.length,
      typedFactsConsidered: activeTyped.length,
      newlyMarkedStale: 0,
      unmarkedNowAgreed: 0,
    };
  }

  const frontmatter: LongTermFrontmatter = {
    version: 1,
    agentId: params.agentId,
    lastConsolidatedAt: params.now,
    facts: updatedFacts,
  };
  await params.storage.writeLongTerm(frontmatter, formatLongTermBody(updatedFacts));

  return {
    proseFactsConsidered: activeProse.length,
    typedFactsConsidered: activeTyped.length,
    newlyMarkedStale,
    unmarkedNowAgreed,
    ...(deterministicStale.size > 0 ? { deterministicStale: deterministicStale.size } : {}),
  };
}

function buildReconcileUserPrompt(
  proseFacts: ReadonlyArray<LongTermFact>,
  typedFacts: ReadonlyArray<LongTermTypedFact>,
): string {
  const proseLines = proseFacts.map((f) => `- [${f.id}] ${f.text}`).join("\n");
  const typedLines = typedFacts
    .map((t) => `- ${t.slot} = ${t.value}${t.unit ? ` ${t.unit}` : ""}`)
    .join("\n");
  return `<prose-facts>\n${proseLines}\n</prose-facts>\n\n<typed-facts>\n${typedLines}\n</typed-facts>\n\nReconcile every prose fact.`;
}

// ---------------------------------------------------------------------------
// Prose↔prose interference detection (Microsoft "Forgetting Is the Fix")
// ---------------------------------------------------------------------------

/**
 * Output of a prose-prose interference detection pass.
 *
 * This is the algorithmic (no-LLM) complement to `reconcileCrossBrain`:
 * it detects pairs of prose facts that are topically similar (high jaccard)
 * but differ in detail — indicating the newer fact may supersede the older
 * one. Inspired by Microsoft's interference-based forgetting: "new fixes
 * supersede old bug reports."
 */
export type ProseInterferenceOutput = {
  /** Active prose facts considered for pairing. */
  factsConsidered: number;
  /** Older facts that gained a new supersededBy mark this pass. */
  newlySuperseded: number;
  /** Facts that had a prose-interference supersededBy mark cleared. */
  cleared: number;
};

/** Minimum jaccard similarity to consider two facts "topically similar". */
const INTERFERENCE_JACCARD_THRESHOLD = 0.4;

/**
 * Detect prose-prose interference: when two long-term prose facts are
 * topically similar (share many terms) but were confirmed at different
 * times, the older one is likely stale and should be suppressed from
 * retrieval.
 *
 * Unlike `reconcileCrossBrain`, this is purely algorithmic — no LLM call.
 * It uses jaccard similarity over tokenized fact texts. This is conservative:
 * it only fires when facts share enough vocabulary to be about the same topic
 * but are from different time periods.
 *
 * The `supersededBy` field is set to the newer fact's dedupKey (prefixed with
 * `prose:` to distinguish from typed-fact supersession). Retrieval should skip
 * facts with any non-null `supersededBy`.
 */
export async function reconcileProseInterference(params: {
  storage: Storage;
  agentId: string | null;
  now: number;
  /**
   * When set, fact pairs that carry comparable embeddings are compared by
   * cosine against this threshold (catching paraphrased drift that lexical
   * jaccard misses); pairs without vectors still fall back to the jaccard
   * threshold. `null`/undefined (default) preserves the historical
   * jaccard-only behavior so enabling cosine stays a measured, opt-in change.
   */
  interferenceCosineThreshold?: number | null;
}): Promise<ProseInterferenceOutput> {
  const longterm = await params.storage.readLongTerm();
  const active = longterm.facts.filter((f) => !f.archived && !f.supersededBy);

  if (active.length < 2) {
    return { factsConsidered: active.length, newlySuperseded: 0, cleared: 0 };
  }

  // Pre-tokenize all facts once
  const tokenized = new Map<string, Set<string>>();
  for (const f of active) {
    tokenized.set(f.id, tokenize(f.text));
  }

  // Find interference pairs: (older, newer) where jaccard > threshold
  // and they're from different days.
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const supersededByFactId = new Map<string, string>(); // olderId → newerDedupKey
  const cosineThreshold = params.interferenceCosineThreshold ?? null;

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (!a || !b) {
        continue;
      }
      // Prefer embedding cosine when enabled and both facts carry vectors;
      // otherwise lexical jaccard. Each metric uses its own scale-appropriate
      // threshold (cosine and jaccard are not comparable).
      let sim: number;
      let threshold: number;
      if (cosineThreshold !== null) {
        const r = nearDuplicateSimilarity(
          { embedding: a.embedding, tokens: tokenized.get(a.id)! },
          { embedding: b.embedding, tokens: tokenized.get(b.id)! },
        );
        sim = r.sim;
        threshold = r.metric === "cosine" ? cosineThreshold : INTERFERENCE_JACCARD_THRESHOLD;
      } else {
        sim = jaccard(tokenized.get(a.id)!, tokenized.get(b.id)!);
        threshold = INTERFERENCE_JACCARD_THRESHOLD;
      }
      if (sim < threshold) {
        continue;
      }

      // Determine older and newer
      const older = a.lastConfirmedAt <= b.lastConfirmedAt ? a : b;
      const newer = a.lastConfirmedAt <= b.lastConfirmedAt ? b : a;

      // Must be from different days to indicate drift
      const dayDiff = Math.abs(newer.lastConfirmedAt - older.lastConfirmedAt) / MS_PER_DAY;
      if (dayDiff < 1) {
        continue;
      }

      // Don't supersede a fact that was already superseded by something else
      if (supersededByFactId.has(older.id)) {
        continue;
      }

      supersededByFactId.set(older.id, `prose:${newer.dedupKey}`);
    }
  }

  // Apply marks
  let newlySuperseded = 0;
  let cleared = 0;
  const updatedFacts = longterm.facts.map((fact) => {
    if (fact.archived) {
      return fact;
    }

    // Check if this fact should gain a new mark
    const newMark = supersededByFactId.get(fact.id);
    if (newMark) {
      const priorMark = fact.supersededBy ?? null;
      if (priorMark === newMark) {
        return fact;
      } // already marked
      if (priorMark === null) {
        newlySuperseded += 1;
      }
      return { ...fact, supersededBy: newMark };
    }

    // Check if this fact had a prose-interference mark that should be cleared
    // (the pairing no longer meets the threshold, or the other fact was archived)
    if (fact.supersededBy?.startsWith("prose:")) {
      const otherDedupKey = fact.supersededBy.slice(6);
      const otherStillActive = active.some((f) => f.dedupKey === otherDedupKey);
      const stillSimilar = supersededByFactId.has(fact.id);
      if (!otherStillActive || !stillSimilar) {
        cleared += 1;
        return { ...fact, supersededBy: null };
      }
    }

    return fact;
  });

  if (newlySuperseded === 0 && cleared === 0) {
    return { factsConsidered: active.length, newlySuperseded: 0, cleared: 0 };
  }

  const frontmatter: LongTermFrontmatter = {
    version: 1,
    agentId: params.agentId,
    lastConsolidatedAt: longterm.lastConsolidatedAt,
    facts: updatedFacts,
  };
  await params.storage.writeLongTerm(frontmatter, formatLongTermBody(updatedFacts));

  return { factsConsidered: active.length, newlySuperseded, cleared };
}

function parseDecisions(
  raw: string,
  validIds: ReadonlySet<string>,
  validSlots: ReadonlySet<string>,
): Map<string, Decision> {
  const out = new Map<string, Decision>();
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object") {
    return out;
  }
  const decisions = (parsed as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions)) {
    return out;
  }
  for (const candidate of decisions) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const o = candidate as Record<string, unknown>;
    if (typeof o.factId !== "string") {
      continue;
    }
    if (!validIds.has(o.factId)) {
      continue;
    }
    if (o.verdict !== "stale" && o.verdict !== "agreed") {
      continue;
    }
    if (o.verdict === "stale") {
      const slot = typeof o.supersededBy === "string" ? o.supersededBy : null;
      if (!slot || !validSlots.has(slot)) {
        continue;
      }
      out.set(o.factId, { verdict: "stale", supersededBy: slot });
    } else {
      out.set(o.factId, { verdict: "agreed", supersededBy: null });
    }
  }
  return out;
}
