/**
 * MemoType-inspired type-dispatched retrieval (QW3, 2026-10-09).
 *
 * arXiv MemoType's proof: on typed-fact corpora a single retrieval strategy
 * has a precision ceiling — different fact categories are best served by
 * different signal mixes (up to +16% Recall@1 when strategy follows type).
 * Following the established SCM intent-preset pattern in retrieval.ts
 * (INTENT_SCORING_PRESETS), each typed-fact category resolves to one of
 * three scoring presets:
 *
 * - **keyword-first** (rule-like, exact terms matter): infra, preference,
 *   project, environment, person — IPs, paths, names, commands. BM25-dominant;
 *   semantic kept as a low noise floor; recency near-zero (a correct IP does
 *   not get better with age); reliability boosted (confirmed > tentative).
 * - **semantic-first** (episodic, paraphrase-sensitive): attempt, diagnosis —
 *   prior attempts and root causes are remembered as narrative, rarely
 *   queried with the exact original phrasing. Semantic-dominant with
 *   importance/information-gain boosts; BM25 reduced to floor.
 * - **recency-weighted** (stateful): task, subgoal — open work whose CURRENT
 *   state matters most. Recency weight 5× default; balanced lexical/semantic
 *   so the live state is findable however it is phrased.
 *
 * Calibration: `scripts/optimize-weights.ts` / `sweep-weights.mjs` can sweep
 * these against the LongMemEval ~71% baseline; the presets below are the
 * MemoType-informed starting point.
 */
import { inferCategoryFromSlot, validateCategory, type TypedFactCategory } from "./categories.js";
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from "./scoring.js";

export type CategoryScoringGroup = "keyword-first" | "semantic-first" | "recency-weighted";

/** Category → preset group. Every canonical category maps to exactly one. */
export const CATEGORY_PRESET_GROUPS: Record<TypedFactCategory, CategoryScoringGroup> = {
  infra: "keyword-first",
  preference: "keyword-first",
  project: "keyword-first",
  environment: "keyword-first",
  person: "keyword-first",
  attempt: "semantic-first",
  diagnosis: "semantic-first",
  task: "recency-weighted",
  subgoal: "recency-weighted",
};

const GROUP_PRESETS: Record<CategoryScoringGroup, ScoringConfig> = {
  // Exact-term dominance for rule-like values; reliability surfaces confirmed
  // facts; recency near-floor so an old-but-correct value is not demoted.
  "keyword-first": {
    ...DEFAULT_SCORING_CONFIG,
    weightBm25: 0.5,
    weightLexical: 0.25,
    weightSemantic: 0.1,
    weightRecency: 0.02,
    weightReliability: 0.15,
  },
  // Paraphrase dominance for episodic facts; importance + information-gain
  // surface the most significant prior attempts/diagnoses.
  "semantic-first": {
    ...DEFAULT_SCORING_CONFIG,
    weightBm25: 0.15,
    weightLexical: 0.1,
    weightSemantic: 0.5,
    weightImportance: 0.15,
    weightInformationGain: 0.08,
  },
  // Current-state dominance for open work: recency 5× default so the live
  // task/subgoal state outranks stale-but-matching history.
  "recency-weighted": {
    ...DEFAULT_SCORING_CONFIG,
    weightBm25: 0.3,
    weightLexical: 0.2,
    weightSemantic: 0.25,
    weightRecency: 0.25,
    weightGoalRelevance: 0.1,
  },
};

/**
 * Scoring preset for a typed-fact category. Unknown/uncategorized values fall
 * back to the default scoring config (behavior unchanged).
 */
export function getCategoryScoringPreset(category: string): ScoringConfig {
  const valid = validateCategory(category);
  if (!valid) {
    return DEFAULT_SCORING_CONFIG;
  }
  return GROUP_PRESETS[CATEGORY_PRESET_GROUPS[valid as TypedFactCategory]];
}

/**
 * Resolve a typed fact's category for dispatch: prefer an explicit value,
 * fall back to slot-namespace inference (`infra:*`, `task:*`, …). Categories
 * are optional on stored facts, so inference keeps dispatch live for
 * pre-category facts at zero cost.
 */
export function resolveTypedFactCategory(slot: string, explicit?: string): string | undefined {
  return validateCategory(explicit) ?? inferCategoryFromSlot(slot);
}
