import { describe, expect, it } from "vitest";
import {
  describeJudgeSpec,
  JUDGE_PROMPT_REVISION,
  LONGMEMEVAL_SCORER_SPEC_CORE,
  SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE,
  type JudgeSpec,
} from "./judge-estimand.js";

// Judge estimand & interface pins (ARCH-2, 2026-10-12): canonical type owner.
// The render format is load-bearing — the scorer prints it (H3) and the
// skill-forge mirror must render byte-identically (sync contract).

describe("describeJudgeSpec", () => {
  it("renders verbatim: surface: estimand=… resolution=… evaluator=model@revision", () => {
    const spec: JudgeSpec = {
      surface: "longmemeval-scorer",
      estimand: "manifestation",
      resolution: "verdict",
      evaluator: { model: "glm-5.2", promptRevision: "v1" },
    };
    expect(describeJudgeSpec(spec)).toBe(
      "longmemeval-scorer: estimand=manifestation resolution=verdict evaluator=glm-5.2@v1",
    );
  });

  it("exposure + confidence render through the same shape", () => {
    const spec: JudgeSpec = {
      surface: "s",
      estimand: "exposure",
      resolution: "confidence",
      evaluator: { model: "m", promptRevision: "r2" },
    };
    expect(describeJudgeSpec(spec)).toBe(
      "s: estimand=exposure resolution=confidence evaluator=m@r2",
    );
  });
});

describe("spec cores", () => {
  it("LONGMEMEVAL_SCORER_CORE: manifestation judged by verdict", () => {
    expect(LONGMEMEVAL_SCORER_SPEC_CORE).toEqual({
      surface: "longmemeval-scorer",
      estimand: "manifestation",
      resolution: "verdict",
    });
  });

  it("SKILL_FORGE_JUDGE_AUDIT_CORE: manifestation judged by verdict", () => {
    expect(SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE).toEqual({
      surface: "skill-forge-judge-audit",
      estimand: "manifestation",
      resolution: "verdict",
    });
  });

  it("both surfaces measure manifestation (not exposure)", () => {
    expect(LONGMEMEVAL_SCORER_SPEC_CORE.estimand).toBe("manifestation");
    expect(SKILL_FORGE_JUDGE_AUDIT_SPEC_CORE.estimand).toBe("manifestation");
  });
});

describe("confidence flip (scorer stamp composition, H1)", () => {
  it("resolution flips to confidence when dimension scoring is on", () => {
    const spec: JudgeSpec = {
      ...LONGMEMEVAL_SCORER_SPEC_CORE,
      resolution: "confidence",
      evaluator: { model: "glm-5.2", promptRevision: JUDGE_PROMPT_REVISION },
    };
    expect(spec.resolution).toBe("confidence");
    expect(describeJudgeSpec(spec)).toBe(
      "longmemeval-scorer: estimand=manifestation resolution=confidence evaluator=glm-5.2@v1",
    );
  });
});
