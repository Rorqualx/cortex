// Judge estimand & interface pins (ARCH-2, 2026-10-12): every LLM-judged
// metric in the fork states WHAT it measures (estimand) and HOW it resolves
// (verdict vs confidence), plus the evaluator stamp. Consumers: the
// LongMemEval scorer (stamp + robustness bar) and the skill-forge judge
// audit. This module is the CANONICAL owner of the type; src/skill-forge/
// judge-spec.ts carries a structural mirror kept honest by
// judge-spec-sync.test.ts (test-only crossing — no src→extensions runtime
// import exists, by seam-direction contract).

export type JudgeEstimand = "exposure" | "manifestation";
export type JudgeResolution = "verdict" | "confidence";

export type JudgeSpec = {
  /** Judge surface id, e.g. "longmemeval-scorer" | "skill-forge-judge-audit". */
  surface: string;
  estimand: JudgeEstimand;
  resolution: JudgeResolution;
  /** Stamped per-run: which model judged, under which prompt revision. */
  evaluator: { model: string; promptRevision: string };
};

export function describeJudgeSpec(spec: JudgeSpec): string {
  return `${spec.surface}: estimand=${spec.estimand} resolution=${spec.resolution} evaluator=${spec.evaluator.model}@${spec.evaluator.promptRevision}`;
}

// Partial constants (evaluator is stamped at run time).
export const LONGMEMEVAL_SCORER_SPEC_CORE = {
  surface: "longmemeval-scorer",
  estimand: "manifestation",
  resolution: "verdict",
} as const;

export const SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE = {
  surface: "skill-forge-judge-audit",
  estimand: "manifestation",
  resolution: "verdict",
} as const;

// Bump when any judge prompt changes (scorer templates, judge-audit rubric).
// Both the scorer (H1 stamp) and judge-audit stamp this single constant;
// the skill-forge mirror carries its own copy pinned by the sync test.
export const JUDGE_PROMPT_REVISION = "v1";
