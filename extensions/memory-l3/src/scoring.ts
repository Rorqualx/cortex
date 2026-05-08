import type { L2Fact } from "./types.js";

export type ScoringConfig = {
  weightLexical: number;
  weightImportance: number;
  weightRecency: number;
  /** ε-weighted L3-epoch boost. Soft additive prior; default 0.1. */
  weightL3Boost: number;
  /**
   * Flat additive bonus applied to any long-term tier hit that has a
   * positive lexical match. Lets evergreen facts edge out fresh L2 facts
   * at similar scoring without dominating unrelated queries. Default 0.15.
   */
  weightLongTermTierBoost: number;
  /**
   * Multiplier applied to memory-core QMD result scores to bring them into
   * the same 0-0.7 range as our composite, so the cross-store tier
   * participates in unified top-K ranking instead of competing on a
   * different scale. Default 0.7.
   */
  weightMemoryCoreTierMultiplier: number;
  recencyHalfLifeDays: number;
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weightLexical: 0.6,
  weightImportance: 0.2,
  weightRecency: 0.1,
  weightL3Boost: 0.1,
  weightLongTermTierBoost: 0.15,
  weightMemoryCoreTierMultiplier: 0.7,
  recencyHalfLifeDays: 7,
};

export type Signals = {
  lexical: number;
  importance: number;
  recency: number;
  l3Boost: number;
};

// Match alphabetic words, multi-char numeric runs (preserving internal . and ,
// so "$1,234.56" and "192.168.50.128" survive as single tokens), and single
// digits. Anything else is treated as a separator.
const TOKEN_PATTERN = /[a-z]+|\d[\d.,]*\d|\d/g;

export function tokenize(text: string): Set<string> {
  const matches = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  // Drop single-letter alphabetic tokens ("a", "i") as noise; keep single
  // digits ("port 5", "v3") since they often carry signal.
  return new Set(matches.filter((t) => t.length > 1 || /^\d$/.test(t)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) {
    if (b.has(t)) intersect += 1;
  }
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export function recencyScore(ageMs: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  const ageDays = Math.max(0, ageMs) / MS_PER_DAY;
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

export function scoreFact(params: {
  queryTokens: Set<string>;
  fact: L2Fact;
  now: number;
  config: ScoringConfig;
  l3Boost?: number;
}): Signals {
  const factTokens = tokenize(params.fact.text);
  const lexical = jaccard(params.queryTokens, factTokens);
  const importance = params.fact.importance;
  const recency = recencyScore(
    params.now - params.fact.createdAt,
    params.config.recencyHalfLifeDays,
  );
  return { lexical, importance, recency, l3Boost: params.l3Boost ?? 0 };
}

export function composite(signals: Signals, config: ScoringConfig): number {
  return (
    signals.lexical * config.weightLexical +
    signals.importance * config.weightImportance +
    signals.recency * config.weightRecency +
    signals.l3Boost * config.weightL3Boost
  );
}
