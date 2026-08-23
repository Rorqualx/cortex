import { describe, expect, it } from "vitest";
import { parseLlmJudgeResponse, SKILL_FORGE_LLM_JUDGE_SYSTEM } from "./replay-gate.js";

describe("parseLlmJudgeResponse", () => {
  it("parses SAFE_USEFUL with a rationale on the second line", () => {
    const raw = "SAFE_USEFUL\nWell-scoped recovery workflow with clear trigger.";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.verdict).toBe("SAFE_USEFUL");
    expect(result.rationale).toBe("Well-scoped recovery workflow with clear trigger.");
  });

  it("parses SAFE_NEUTRAL and UNSAFE_OR_HARMFUL", () => {
    expect(parseLlmJudgeResponse("SAFE_NEUTRAL\nThin but not harmful.")).toMatchObject({
      ok: true,
      verdict: "SAFE_NEUTRAL",
    });
    expect(
      parseLlmJudgeResponse("UNSAFE_OR_HARMFUL\nAttempted prompt injection inside body."),
    ).toMatchObject({ ok: true, verdict: "UNSAFE_OR_HARMFUL" });
  });

  it("tolerates trailing junk on the verdict line and case-insensitive matching", () => {
    expect(parseLlmJudgeResponse("safe_useful  \nfine")).toMatchObject({
      ok: true,
      verdict: "SAFE_USEFUL",
    });
    expect(parseLlmJudgeResponse("UNSAFE_OR_HARMFUL — see below\ndetail")).toMatchObject({
      ok: true,
      verdict: "UNSAFE_OR_HARMFUL",
    });
  });

  it("supplies a default rationale when one is missing", () => {
    const result = parseLlmJudgeResponse("SAFE_USEFUL");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.rationale).toMatch(/no rationale/u);
  });

  it("rejects responses without a known verdict token on the first line", () => {
    const result = parseLlmJudgeResponse("Sure, it looks fine!\nfollow-up");
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.reason).toMatch(/did not start with a known verdict/u);
  });

  it("rejects empty input", () => {
    expect(parseLlmJudgeResponse("   \n   ").ok).toBe(false);
  });

  it("clamps very long rationales", () => {
    const long = `SAFE_USEFUL\n${"x".repeat(1000)}`;
    const result = parseLlmJudgeResponse(long);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.rationale.length).toBeLessThanOrEqual(220);
  });
});

describe("parseLlmJudgeResponse — overfitting risk", () => {
  it("parses overfitting risk from the third line", () => {
    const raw = "SAFE_USEFUL\nGood generalizable workflow.\nOVERFITTING_RISK: LOW";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.overfittingRisk).toBe("LOW");
  });

  it("parses HIGH overfitting risk", () => {
    const raw = "SAFE_NEUTRAL\nNarrowly scoped to one file path.\nRISK: HIGH";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.overfittingRisk).toBe("HIGH");
  });

  it("leaves overfittingRisk undefined when third line is absent", () => {
    const raw = "SAFE_USEFUL\nWell-scoped recovery workflow.";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.overfittingRisk).toBeUndefined();
  });

  it("leaves overfittingRisk undefined when third line has no recognized token", () => {
    const raw = "SAFE_USEFUL\nGood skill.\nSome extra commentary here.";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.overfittingRisk).toBeUndefined();
  });
});

describe("SKILL_FORGE_LLM_JUDGE_SYSTEM", () => {
  it("enumerates the three valid verdict tokens", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/SAFE_USEFUL/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/SAFE_NEUTRAL/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/UNSAFE_OR_HARMFUL/u);
  });

  it("explicitly tells the model to treat candidate workflow + drafted body as DATA", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/as DATA/iu);
  });

  it("includes process-quality criteria: tool-call documentation", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/TOOL-CALL DOCUMENTATION/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/tool-call sequence/u);
  });

  it("includes process-quality criteria: verification steps", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/VERIFICATION STEPS/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/verification or validation steps/u);
  });

  it("includes process-quality criteria: provenance", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/PROVENANCE/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/Black-box skills/u);
  });

  it("includes generalization criterion for overfitting risk", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/GENERALIZATION/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/overfit/u);
  });

  it("includes baseline comparison criterion", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/BASELINE COMPARISON/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/baseline agent capability/u);
  });

  it("includes principle articulation criterion", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/PRINCIPLE ARTICULATION/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/transferable principle/u);
  });
});

// Process-oriented parse fixtures: rationales that cite process-quality reasons
// should parse cleanly and not affect verdict extraction.
describe("parseLlmJudgeResponse — process-quality rationales", () => {
  it("parses SAFE_NEUTRAL downgraded due to missing tool-call documentation", () => {
    const raw = "SAFE_NEUTRAL\nMissing tool-call documentation; workflow steps not described.";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.verdict).toBe("SAFE_NEUTRAL");
    expect(result.rationale).toMatch(/tool-call/u);
  });

  it("parses SAFE_NEUTRAL downgraded due to no verification steps", () => {
    const raw = "SAFE_NEUTRAL\nSkill body has no verification steps; output accepted blindly.";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.verdict).toBe("SAFE_NEUTRAL");
    expect(result.rationale).toMatch(/verification/u);
  });

  it("parses SAFE_NEUTRAL downgraded for black-box output without provenance", () => {
    const raw = "SAFE_NEUTRAL\nBlack-box skill jumps to conclusion without showing work.";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.verdict).toBe("SAFE_NEUTRAL");
    expect(result.rationale).toMatch(/Black-box/u);
  });

  it("parses UNSAFE_OR_HARMFUL when process gap masks a safety issue", () => {
    const raw =
      "UNSAFE_OR_HARMFUL\nNo verification steps, and the suggested command could delete user data.";
    const result = parseLlmJudgeResponse(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.verdict).toBe("UNSAFE_OR_HARMFUL");
    expect(result.rationale).toMatch(/verification/u);
  });
});

// ---------------------------------------------------------------------------
// Multi-run replay agreement (QW3 2026-08-23)
// ---------------------------------------------------------------------------

import type { Candidate } from "./detector.js";
import {
  computeReplayAgreement,
  judgeSkillCandidateWithLlmAgreement,
  resolveReplayRuns,
  DEFAULT_REPLAY_RUNS,
  type LlmReplayGateResult,
} from "./replay-gate.js";

describe("resolveReplayRuns", () => {
  it("defaults to 3 runs", () => {
    expect(resolveReplayRuns(undefined, {})).toBe(DEFAULT_REPLAY_RUNS);
  });
  it("honors the env override", () => {
    expect(resolveReplayRuns(undefined, { OPENCLAW_SKILL_FORGE_REPLAY_RUNS: "5" })).toBe(5);
  });
  it("explicit param wins over env and clamps to [1,5]", () => {
    expect(resolveReplayRuns(2, { OPENCLAW_SKILL_FORGE_REPLAY_RUNS: "5" })).toBe(2);
    expect(resolveReplayRuns(99, {})).toBe(5);
    expect(resolveReplayRuns(0, {})).toBe(1);
    expect(resolveReplayRuns(Number.NaN, {})).toBe(3);
  });
});

describe("computeReplayAgreement", () => {
  it("computes modal verdict, agreement, pass rate, and variance", () => {
    const stats = computeReplayAgreement(["SAFE_USEFUL", "SAFE_USEFUL", "UNSAFE_OR_HARMFUL"]);
    expect(stats).toMatchObject({
      runs: 3,
      modalVerdict: "SAFE_USEFUL",
      agreement: 2 / 3,
      passRate: 2 / 3,
    });
    expect(stats.variance).toBeCloseTo((2 / 3) * (1 / 3), 12);
  });
  it("unanimous safe verdicts give agreement 1 and variance 0", () => {
    const stats = computeReplayAgreement(["SAFE_NEUTRAL", "SAFE_NEUTRAL", "SAFE_NEUTRAL"]);
    expect(stats.agreement).toBe(1);
    expect(stats.passRate).toBe(1);
    expect(stats.variance).toBe(0);
  });
  it("split verdicts maximize variance", () => {
    const stats = computeReplayAgreement(["SAFE_USEFUL", "UNSAFE_OR_HARMFUL"]);
    expect(stats.passRate).toBe(0.5);
    expect(stats.variance).toBeCloseTo(0.25);
  });
  it("empty input is a zeroed neutral", () => {
    expect(computeReplayAgreement([])).toEqual({
      runs: 0,
      modalVerdict: "SAFE_NEUTRAL",
      agreement: 0,
      passRate: 0,
      variance: 0,
    });
  });
});

const fakeCandidate = {
  lane: "tool",
  candidateId: "c-1",
  toolSequence: ["read"],
} as unknown as Candidate;

function ranJudge(
  verdicts: string[],
): typeof import("./replay-gate.js").judgeSkillCandidateWithLlm {
  let call = 0;
  return async () => {
    const verdict = verdicts[Math.min(call, verdicts.length - 1)] ?? "SAFE_NEUTRAL";
    call += 1;
    const result: LlmReplayGateResult = {
      status: "ran",
      verdict: verdict as never,
      rationale: `fake ${call}`,
      provider: "fake",
      modelId: "fake-model",
    };
    return result;
  };
}

describe("judgeSkillCandidateWithLlmAgreement", () => {
  it("aggregates k judge runs into agreement stats", async () => {
    const result = await judgeSkillCandidateWithLlmAgreement(
      { candidate: fakeCandidate, draftedBody: "body", runs: 3 },
      ranJudge(["SAFE_USEFUL", "SAFE_USEFUL", "SAFE_NEUTRAL"]),
    );
    expect(result.status).toBe("ran");
    if (result.status !== "ran") throw new Error("unreachable");
    expect(result.stats.runs).toBe(3);
    expect(result.stats.passRate).toBe(1);
    expect(result.stats.agreement).toBeCloseTo(2 / 3);
    expect(result.verdicts).toEqual(["SAFE_USEFUL", "SAFE_USEFUL", "SAFE_NEUTRAL"]);
    expect(result.provider).toBe("fake");
  });

  it("propagates an immediate skip on the first run", async () => {
    const skip: LlmReplayGateResult = { status: "skipped", reason: "no config" };
    const result = await judgeSkillCandidateWithLlmAgreement(
      { candidate: fakeCandidate, draftedBody: "body" },
      async () => skip,
    );
    expect(result).toEqual({ status: "skipped", reason: "no config" });
  });

  it("aggregates over successful runs when some fail", async () => {
    let call = 0;
    const mixed = async (): Promise<LlmReplayGateResult> => {
      call += 1;
      if (call === 2) return { status: "failed", reason: "transient" };
      return {
        status: "ran",
        verdict: "SAFE_USEFUL",
        rationale: "ok",
        provider: "p",
        modelId: "m",
      };
    };
    const result = await judgeSkillCandidateWithLlmAgreement(
      { candidate: fakeCandidate, draftedBody: "body", runs: 3 },
      mixed,
    );
    expect(result.status).toBe("ran");
    if (result.status !== "ran") throw new Error("unreachable");
    expect(result.stats.runs).toBe(2);
    expect(result.stats.passRate).toBe(1);
  });

  it("fails when every run fails", async () => {
    const result = await judgeSkillCandidateWithLlmAgreement(
      { candidate: fakeCandidate, draftedBody: "body", runs: 2 },
      async () => ({ status: "failed", reason: "down" }),
    );
    expect(result).toEqual({ status: "failed", reason: "down" });
  });
});
