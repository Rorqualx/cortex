import { describe, expect, it } from "vitest";
import {
  JUDGE_ANCHORS,
  JUDGE_ANCHOR_SET_VERSION,
  evaluateJudgeAnchorCompliance,
  type JudgeAnchorResultInput,
} from "./judge-anchors.js";

function resultsFor(
  overrides: Partial<Record<string, Partial<JudgeAnchorResultInput>>> = {},
): JudgeAnchorResultInput[] {
  return JUDGE_ANCHORS.map((anchor) => ({
    anchorId: anchor.id,
    ran: true,
    verdict: anchor.expectedVerdict,
    ...(anchor.expectedConsistency ? { consistency: anchor.expectedConsistency } : {}),
    ...(overrides[anchor.id] ?? {}),
  }));
}

describe("judge anchored reference set (QW-D)", () => {
  it("freezes a tiny, versioned set covering both judge lanes", () => {
    expect(JUDGE_ANCHORS.length).toBeGreaterThanOrEqual(5);
    expect(JUDGE_ANCHORS.length).toBeLessThanOrEqual(10);
    const lanes = new Set(JUDGE_ANCHORS.map((anchor) => anchor.lane));
    expect(lanes.has("outcome")).toBe(true);
    expect(lanes.has("step-rubric")).toBe(true);
    // Unique ids, and step-rubric anchors pin their consistency expectation.
    const ids = JUDGE_ANCHORS.map((anchor) => anchor.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const anchor of JUDGE_ANCHORS) {
      if (anchor.lane === "step-rubric") {
        expect(anchor.expectedConsistency).toBeDefined();
      }
    }
    expect(JUDGE_ANCHOR_SET_VERSION).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}\./u);
  });

  it("passes when observed verdicts reproduce the frozen expectations", () => {
    const report = evaluateJudgeAnchorCompliance(resultsFor());
    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.checked).toBe(JUDGE_ANCHORS.length);
    expect(report.anchorVersion).toBe(JUDGE_ANCHOR_SET_VERSION);
  });

  it("fails with the drifted anchor id and field on a verdict mismatch", () => {
    const report = evaluateJudgeAnchorCompliance(
      resultsFor({ "anchor-generic-advice": { verdict: "SAFE_USEFUL" } }),
    );
    expect(report.passed).toBe(false);
    expect(report.failures).toContainEqual({
      anchorId: "anchor-generic-advice",
      field: "verdict",
      expected: "SAFE_NEUTRAL",
      actual: "SAFE_USEFUL",
    });
  });

  it("treats a lane that never produced a verdict as a failure", () => {
    const report = evaluateJudgeAnchorCompliance(
      resultsFor({ "anchor-injection-override": { ran: false, verdict: undefined } }),
    );
    expect(report.passed).toBe(false);
    expect(report.failures[0]).toMatchObject({
      anchorId: "anchor-injection-override",
      field: "verdict",
    });
  });

  it("checks consistency expectations on step-rubric anchors", () => {
    const mismatch = evaluateJudgeAnchorCompliance(
      resultsFor({ "anchor-rubric-consistency-fail": { consistency: "PASS" } }),
    );
    expect(mismatch.passed).toBe(false);
    expect(mismatch.failures).toContainEqual({
      anchorId: "anchor-rubric-consistency-fail",
      field: "consistency",
      expected: "FAIL",
      actual: "PASS",
    });

    const missing = evaluateJudgeAnchorCompliance(
      resultsFor({ "anchor-rubric-clean": { consistency: undefined } }),
    );
    expect(missing.passed).toBe(false);
    expect(missing.failures).toContainEqual({
      anchorId: "anchor-rubric-clean",
      field: "consistency",
      expected: "PASS",
      actual: "missing",
    });
  });

  it("flags anchors with no observed result at all", () => {
    const report = evaluateJudgeAnchorCompliance([]);
    expect(report.passed).toBe(false);
    expect(report.failures.length).toBe(JUDGE_ANCHORS.length);
  });
});
