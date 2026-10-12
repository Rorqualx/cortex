// STRUCTURAL MIRROR of extensions/memory-l3/src/judge-estimand.ts — kept
// byte-identical in shape by src/skill-forge/judge-spec-sync.test.ts (a
// test-only import crossing; there is NO src→extensions runtime import by
// seam-direction contract). Change BOTH files in the same commit; the sync
// test fails loudly otherwise.

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

export const SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE = {
  surface: "skill-forge-judge-audit",
  estimand: "manifestation",
  resolution: "verdict",
} as const;

// Mirror copy of the canonical JUDGE_PROMPT_REVISION — pinned equal by the
// sync test; bump both together when any judge prompt changes.
export const JUDGE_PROMPT_REVISION = "v1";
