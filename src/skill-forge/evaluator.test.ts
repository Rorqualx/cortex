import { describe, expect, it } from "vitest";
import type { HindsightCandidate } from "./detector.js";
import { evaluateProcessVsOutcome } from "./evaluator.js";

const hindsightCandidate = (
  hypothesisKind: HindsightCandidate["hypothesisKind"],
  toolSequence: string[] = ["read_file", "edit_file", "deploy"],
): HindsightCandidate => ({
  lane: "hindsight",
  candidateId: "hind-0001",
  captureDir: "/tmp/cap",
  toolSequence,
  skillHypothesis: "Preflight config checks before deploy",
  hypothesisKind,
  rationale: "Checking config first caught the bad port.",
  successScore: 1,
});

describe("evaluateProcessVsOutcome — hindsight lane (A2 pin, 2026-11-07)", () => {
  it('case "hindsight" exists and scores — workflow hypotheses are process-focused', () => {
    // A2 (probe): the lane switch is NOT exhaustiveness-checked; without this
    // explicit arm a hindsight candidate silently falls through to the 0.5
    // defaults. This pin FAILS if the arm goes missing.
    const rubric = evaluateProcessVsOutcome(hindsightCandidate("workflow"));
    expect(rubric.processFocus).toBeGreaterThan(0.6);
    expect(rubric.sequentialSteps).toBe(true);
    expect(rubric.errorHandling).toBe(false);
  });

  it("failure-avoidance hypotheses carry error handling; decisive observations are outcome-leaning", () => {
    const avoidance = evaluateProcessVsOutcome(hindsightCandidate("failure-avoidance"));
    expect(avoidance.errorHandling).toBe(true);
    expect(avoidance.processFocus).toBeLessThan(0.6);

    const observation = evaluateProcessVsOutcome(hindsightCandidate("decisive-observation"));
    expect(observation.reusability).toBe(false);
    expect(observation.sequentialSteps).toBe(false);
  });
});
