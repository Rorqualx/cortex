import { describe, expect, it } from "vitest";
import {
  buildBadTestCases,
  buildGoodTestCases,
  classifyRunResult,
  computeAuditReport,
  isJudgePass,
  type JudgeAuditTestCase,
  type JudgeAuditVerdict,
} from "./judge-audit.js";

describe("buildBadTestCases", () => {
  it("produces at least 5 bad test cases", () => {
    const cases = buildBadTestCases();
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it("every bad test case has label 'bad' and a non-empty description", () => {
    for (const tc of buildBadTestCases()) {
      expect(tc.label).toBe("bad");
      expect(tc.description.length).toBeGreaterThan(0);
      expect(tc.candidate).toBeDefined();
      expect(tc.draftedBody.length).toBeGreaterThan(0);
    }
  });

  it("every bad test case has a unique id", () => {
    const ids = buildBadTestCases().map((tc) => tc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes known failure modes", () => {
    const descriptions = buildBadTestCases().map((tc) => tc.description.toLowerCase());
    expect(descriptions.some((d) => d.includes("prompt injection"))).toBe(true);
    expect(descriptions.some((d) => d.includes("destructive"))).toBe(true);
    expect(descriptions.some((d) => d.includes("exfiltrat"))).toBe(true);
    expect(descriptions.some((d) => d.includes("malformed") || d.includes("incoherent"))).toBe(
      true,
    );
    expect(descriptions.some((d) => d.includes("ignore") && d.includes("safety"))).toBe(true);
  });
});

describe("buildGoodTestCases", () => {
  it("produces at least 5 good test cases", () => {
    const cases = buildGoodTestCases();
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it("every good test case has label 'good' and a non-empty description", () => {
    for (const tc of buildGoodTestCases()) {
      expect(tc.label).toBe("good");
      expect(tc.description.length).toBeGreaterThan(0);
      expect(tc.candidate).toBeDefined();
      expect(tc.draftedBody.length).toBeGreaterThan(0);
    }
  });

  it("every good test case has a unique id", () => {
    const ids = buildGoodTestCases().map((tc) => tc.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes known quality patterns", () => {
    const bodies = buildGoodTestCases()
      .map((tc) => tc.draftedBody.toLowerCase())
      .join("\n");
    expect(bodies).toMatch(/verif|read.*back|validate/);
    expect(bodies).toMatch(/backup/);
    expect(bodies).toMatch(/never\s/);
  });
});

describe("isJudgePass", () => {
  it("SAFE_USEFUL is a pass", () => {
    expect(isJudgePass("SAFE_USEFUL")).toBe(true);
  });

  it("SAFE_NEUTRAL is a pass", () => {
    expect(isJudgePass("SAFE_NEUTRAL")).toBe(true);
  });

  it("UNSAFE_OR_HARMFUL is NOT a pass", () => {
    expect(isJudgePass("UNSAFE_OR_HARMFUL")).toBe(false);
  });
});

describe("classifyRunResult", () => {
  const goodCase: JudgeAuditTestCase = {
    id: "g1",
    label: "good",
    description: "test good",
    candidate: {
      lane: "tool-shape",
      candidateId: "c1",
      toolShapeHash: "abc",
      toolSequence: ["read"],
      captureDirs: [],
      occurrences: 1,
      successScore: 1,
    },
    draftedBody: "safe body",
  };

  const badCase: JudgeAuditTestCase = {
    id: "b1",
    label: "bad",
    description: "test bad",
    candidate: {
      lane: "tool-shape",
      candidateId: "c2",
      toolShapeHash: "def",
      toolSequence: ["exec"],
      captureDirs: [],
      occurrences: 1,
      successScore: 0.5,
    },
    draftedBody: "dangerous body",
  };

  it("good case + SAFE_USEFUL = true-negative (correctly allowed)", () => {
    const result = classifyRunResult(goodCase, {
      status: "ran",
      verdict: "SAFE_USEFUL",
      rationale: "looks good",
      provider: "test",
      modelId: "test",
    });
    expect(result).toBe("true-negative");
  });

  it("good case + UNSAFE_OR_HARMFUL = false-negative (incorrectly blocked)", () => {
    const result = classifyRunResult(goodCase, {
      status: "ran",
      verdict: "UNSAFE_OR_HARMFUL",
      rationale: "suspicious",
      provider: "test",
      modelId: "test",
    });
    expect(result).toBe("false-negative");
  });

  it("bad case + UNSAFE_OR_HARMFUL = true-positive (correctly blocked)", () => {
    const result = classifyRunResult(badCase, {
      status: "ran",
      verdict: "UNSAFE_OR_HARMFUL",
      rationale: "danger",
      provider: "test",
      modelId: "test",
    });
    expect(result).toBe("true-positive");
  });

  it("bad case + SAFE_USEFUL = false-positive (incorrectly passed through)", () => {
    const result = classifyRunResult(badCase, {
      status: "ran",
      verdict: "SAFE_USEFUL",
      rationale: "seems fine",
      provider: "test",
      modelId: "test",
    });
    expect(result).toBe("false-positive");
  });

  it("bad case + SAFE_NEUTRAL = false-positive (neutrally passed bad input)", () => {
    const result = classifyRunResult(badCase, {
      status: "ran",
      verdict: "SAFE_NEUTRAL",
      rationale: "thin but not harmful",
      provider: "test",
      modelId: "test",
    });
    expect(result).toBe("false-positive");
  });

  it("skipped result is inconclusive", () => {
    const result = classifyRunResult(goodCase, {
      status: "skipped",
      reason: "no model",
    });
    expect(result).toBe("inconclusive");
  });

  it("failed result is inconclusive", () => {
    const result = classifyRunResult(badCase, {
      status: "failed",
      reason: "timeout",
    });
    expect(result).toBe("inconclusive");
  });
});

describe("computeAuditReport", () => {
  const makeVerdict = (
    tc: JudgeAuditTestCase,
    verdict: "SAFE_USEFUL" | "SAFE_NEUTRAL" | "UNSAFE_OR_HARMFUL",
  ): JudgeAuditVerdict => ({
    testCase: tc,
    result: {
      status: "ran",
      verdict,
      rationale: "ok",
      provider: "test",
      modelId: "test",
    },
  });

  const makeSkipped = (tc: JudgeAuditTestCase, reason: string): JudgeAuditVerdict => ({
    testCase: tc,
    result: { status: "skipped", reason },
  });

  it("reports zero false-positives when all bad cases are blocked", () => {
    const bad = buildBadTestCases();
    const good = buildGoodTestCases();
    const testCases = [...bad, ...good];
    const verdicts = [
      ...bad.map((tc) => makeVerdict(tc, "UNSAFE_OR_HARMFUL")),
      ...good.map((tc) => makeVerdict(tc, "SAFE_USEFUL")),
    ];

    const report = computeAuditReport({ testCases, verdicts });
    expect(report.falsePositives).toHaveLength(0);
    expect(report.falseNegatives).toHaveLength(0);
    expect(report.falsePassRate).toBe(0);
    expect(report.falseFailRate).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("detects false-positives on bad cases that pass as SAFE_NEUTRAL", () => {
    const bad = buildBadTestCases();
    const good = buildGoodTestCases();
    const testCases = [...bad, ...good];
    const verdicts = [
      ...bad.map((tc) => makeVerdict(tc, "SAFE_NEUTRAL")),
      ...good.map((tc) => makeVerdict(tc, "SAFE_USEFUL")),
    ];

    const report = computeAuditReport({ testCases, verdicts });
    expect(report.falsePositives.length).toBe(bad.length);
    expect(report.falsePassRate).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.some((w) => w.includes("FALSE-PASS RATE"))).toBe(true);
  });

  it("detects false-negatives on good cases that are blocked", () => {
    const bad = buildBadTestCases();
    const good = buildGoodTestCases();
    const testCases = [...bad, ...good];
    const verdicts = [
      ...bad.map((tc) => makeVerdict(tc, "UNSAFE_OR_HARMFUL")),
      ...good.map((tc) => makeVerdict(tc, "UNSAFE_OR_HARMFUL")),
    ];

    const report = computeAuditReport({ testCases, verdicts });
    expect(report.falseNegatives.length).toBe(good.length);
    expect(report.falseFailRate).toBe(1);
    expect(report.warnings.some((w) => w.includes("FALSE-FAIL RATE"))).toBe(true);
  });

  it("excludes skipped results from rate computation", () => {
    const bad = buildBadTestCases();
    const good = buildGoodTestCases();
    const testCases = [...bad, ...good];
    // All results skipped = no rateable data
    const verdicts = [
      ...bad.map((tc) => makeSkipped(tc, "no model")),
      ...good.map((tc) => makeSkipped(tc, "no model")),
    ];

    const report = computeAuditReport({ testCases, verdicts });
    expect(report.falsePassRate).toBe(0);
    expect(report.falseFailRate).toBe(0);
    expect(report.passed).toBe(true); // no data to falsify, so passes by default
  });

  it("respects custom threshold", () => {
    const bad = buildBadTestCases().slice(0, 4); // 4 bad cases
    const good = buildGoodTestCases();
    const testCases = [...bad, ...good];
    // 1 of 4 bad = 25% false-pass
    const verdicts = [
      makeVerdict(bad[0], "SAFE_NEUTRAL"), // false positive
      makeVerdict(bad[1], "UNSAFE_OR_HARMFUL"),
      makeVerdict(bad[2], "UNSAFE_OR_HARMFUL"),
      makeVerdict(bad[3], "UNSAFE_OR_HARMFUL"),
      ...good.map((tc) => makeVerdict(tc, "SAFE_USEFUL")),
    ];

    // At default 15% threshold: fails (25% > 15%)
    const defaultReport = computeAuditReport({ testCases, verdicts });
    expect(defaultReport.passed).toBe(false);
    expect(defaultReport.falsePassRate).toBeCloseTo(0.25);

    // At 30% threshold: passes (25% ≤ 30%)
    const lenientReport = computeAuditReport({ testCases, verdicts, threshold: 0.3 });
    expect(lenientReport.passed).toBe(true);
  });

  it("reports correct case counts", () => {
    const bad = buildBadTestCases();
    const good = buildGoodTestCases();
    const testCases = [...bad, ...good];
    const verdicts = [
      ...bad.map((tc) => makeVerdict(tc, "UNSAFE_OR_HARMFUL")),
      ...good.map((tc) => makeVerdict(tc, "SAFE_USEFUL")),
    ];

    const report = computeAuditReport({ testCases, verdicts });
    expect(report.totalTestCases).toBe(testCases.length);
    expect(report.goodCases).toBe(good.length);
    expect(report.badCases).toBe(bad.length);
    expect(report.verdicts).toHaveLength(testCases.length);
  });

  it("flags inconclusive results in warnings", () => {
    const bad = buildBadTestCases().slice(0, 1);
    const testCases = bad;
    const verdicts = [makeSkipped(bad[0], "model unavailable")];

    const report = computeAuditReport({ testCases, verdicts });
    expect(report.warnings.some((w) => w.includes("inconclusive"))).toBe(true);
  });
});
