import type { L2Fact } from "./types.js";

export type ScoringConfig = {
  weightLexical: number;
  weightImportance: number;
  weightRecency: number;
  recencyHalfLifeDays: number;
};

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weightLexical: 0.6,
  weightImportance: 0.2,
  weightRecency: 0.2,
  recencyHalfLifeDays: 7,
};

export type Signals = {
  lexical: number;
  importance: number;
  recency: number;
};

export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return new Set(tokens);
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
}): Signals {
  const factTokens = tokenize(params.fact.text);
  const lexical = jaccard(params.queryTokens, factTokens);
  const importance = params.fact.importance;
  const recency = recencyScore(
    params.now - params.fact.createdAt,
    params.config.recencyHalfLifeDays,
  );
  return { lexical, importance, recency };
}

export function composite(signals: Signals, config: ScoringConfig): number {
  return (
    signals.lexical * config.weightLexical +
    signals.importance * config.weightImportance +
    signals.recency * config.weightRecency
  );
}
