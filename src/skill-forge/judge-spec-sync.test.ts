import { describe, expect, it } from "vitest";
// Test-only crossing of the src/extensions seam — this is the CONTRACT: the
// mirror in src/skill-forge/judge-spec.ts must stay structurally identical to
// the canonical extensions/memory-l3/src/judge-estimand.ts. There is no
// src→extensions RUNTIME import anywhere; this suite is the only bridge, and
// the import specifier itself is the alarm: if the canonical file moves or is
// renamed, this suite fails loudly (probe amendment A1: exactly TWO ../).
import {
  describeJudgeSpec as describeCanonical,
  JUDGE_PROMPT_REVISION as CANONICAL_REVISION,
  LONGMEMEVAL_SCORER_SPEC_CORE,
  SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE as CANONICAL_FORGE_CORE,
  type JudgeSpec as CanonicalJudgeSpec,
} from "../../extensions/memory-l3/src/judge-estimand.js";
import {
  describeJudgeSpec as describeMirror,
  JUDGE_PROMPT_REVISION as MIRROR_REVISION,
  SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE,
  type JudgeSpec as MirrorJudgeSpec,
} from "./judge-spec.js";

describe("judge-spec sync contract (skill-forge mirror ↔ memory-l3 canonical)", () => {
  const representative = {
    surface: "longmemeval-scorer",
    estimand: "manifestation",
    resolution: "verdict",
    evaluator: { model: "glm-5.2", promptRevision: "v1" },
  } as const;

  it("a representative JudgeSpec is typeable as BOTH the mirror and canonical type", () => {
    const asCanonical: CanonicalJudgeSpec = representative;
    const asMirror: MirrorJudgeSpec = representative;
    expect(asCanonical).toEqual(asMirror);
  });

  it("describeJudgeSpec renders byte-identically from both implementations", () => {
    expect(describeMirror({ ...representative })).toBe(describeCanonical({ ...representative }));
    expect(
      describeMirror({ ...CANONICAL_FORGE_CORE, evaluator: { model: "m", promptRevision: "v1" } }),
    ).toBe(
      describeCanonical({
        ...CANONICAL_FORGE_CORE,
        evaluator: { model: "m", promptRevision: "v1" },
      }),
    );
  });

  it("both forge cores agree on surface/estimand/resolution", () => {
    expect(SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE).toEqual(CANONICAL_FORGE_CORE);
    expect(SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE.surface).toBe("skill-forge-judge-audit");
    expect(SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE.estimand).toBe("manifestation");
    expect(SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE.resolution).toBe("verdict");
  });

  it("prompt revisions are pinned equal (bump both in the same commit)", () => {
    expect(MIRROR_REVISION).toBe(CANONICAL_REVISION);
  });
});
