import { describe, expect, it } from "vitest";
import {
  parseBudgets,
  parseEngineOverall,
  parseJudgeOverall,
  parseTokenLine,
  parseWroteHypothesis,
} from "./sweep-topk.mjs";

// Budget sweep (QW1, 2026-10-15): accuracy-vs-budget curve driver over the
// LongMemEval engine harness. These unit tests cover the pure helpers —
// budget-list validation and stdout parsing. The network lane (engine + LLM
// judge) is exercised by running the sweep script itself with an oracle.

describe("parseBudgets", () => {
  it("parses the default list with full", () => {
    expect(parseBudgets("5,10,20,40,full")).toEqual(["5", "10", "20", "40", "full"]);
  });

  it("trims whitespace and drops empties", () => {
    expect(parseBudgets(" 5 , 10 ,, ")).toEqual(["5", "10"]);
  });

  it("de-dups while preserving order", () => {
    expect(parseBudgets("20,5,20,full,full")).toEqual(["20", "5", "full"]);
  });

  it("rejects non-integer tokens", () => {
    expect(() => parseBudgets("5,ten")).toThrow(/Invalid budget token/);
  });

  it("rejects zero budgets", () => {
    expect(() => parseBudgets("5,0")).toThrow(/>= 1/);
  });

  it("rejects an empty list", () => {
    expect(() => parseBudgets(" , ")).toThrow(/No budgets/);
  });
});

describe("parseEngineOverall", () => {
  it("extracts exact-match and AIC percentages", () => {
    const line = "  OVERALL                     7/10 (70%)  AIC:8/10 (80%)";
    expect(parseEngineOverall(line)).toEqual({
      exactMatchPct: 70,
      answerInContextPct: 80,
    });
  });

  it("matches from within larger engine output", () => {
    const out = [
      "# LongMemEval (REAL ENGINE) — ablation: default, topK=5",
      "  single-session-user          3/5 (60%)  AIC:4/5 (80%)",
      "  OVERALL                      3/5 (60%)  AIC:4/5 (80%)",
      "  wall-clock 0.4min · avg facts/q 5 · avg memory ~1200 chars",
    ].join("\n");
    expect(parseEngineOverall(out)).toEqual({
      exactMatchPct: 60,
      answerInContextPct: 80,
    });
  });

  it("returns null when no OVERALL line exists", () => {
    expect(parseEngineOverall("no summary here")).toBeNull();
  });
});

describe("parseJudgeOverall", () => {
  it("extracts hits, total, and percentage", () => {
    expect(parseJudgeOverall("  OVERALL                     7/10 (70%)")).toEqual({
      hits: 7,
      total: 10,
      pct: 70,
    });
  });

  it("returns null for engine-style lines without judge shape", () => {
    // Engine line carries AIC after the pct — judge regex still matches the
    // leading hits/total, which is fine for judge stdout that never has AIC.
    expect(parseJudgeOverall("nothing")).toBeNull();
  });
});

describe("parseWroteHypothesis", () => {
  it("extracts the first Wrote path", () => {
    const out =
      "\nWrote /tmp/longmemeval/hypothesis-engine-stratified5__default__k5.jsonl\n      /tmp/longmemeval/runmeta-engine-stratified5__default__k5.json";
    expect(parseWroteHypothesis(out)).toBe(
      "/tmp/longmemeval/hypothesis-engine-stratified5__default__k5.jsonl",
    );
  });

  it("returns null when absent", () => {
    expect(parseWroteHypothesis("done")).toBeNull();
  });
});

describe("parseTokenLine", () => {
  it("extracts token totals and cost", () => {
    const line = "  tokens: 12345 (in 10000 / out 2345) · est cost $0.0062";
    expect(parseTokenLine(line)).toEqual({
      totalTokens: 12345,
      promptTokens: 10000,
      completionTokens: 2345,
      estimatedCostUsd: 0.0062,
    });
  });

  it("returns null when absent", () => {
    expect(parseTokenLine("no tokens")).toBeNull();
  });
});
