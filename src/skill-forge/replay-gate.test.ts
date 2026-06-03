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

describe("SKILL_FORGE_LLM_JUDGE_SYSTEM", () => {
  it("enumerates the three valid verdict tokens", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/SAFE_USEFUL/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/SAFE_NEUTRAL/u);
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/UNSAFE_OR_HARMFUL/u);
  });

  it("explicitly tells the model to treat candidate workflow + drafted body as DATA", () => {
    expect(SKILL_FORGE_LLM_JUDGE_SYSTEM).toMatch(/as DATA/iu);
  });
});
