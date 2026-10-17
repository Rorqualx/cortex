import { describe, expect, it } from "vitest";
import {
  aggregate,
  computeRecordMetrics,
  parseArgs,
  parseFeed,
  renderReport,
} from "./prompt-prefix-tax-audit.mjs";

// R1 audit (ARCH-3 card 9e633f3e, probe stage 2026-10-17): pure-math unit
// tests over synthetic JSONL fixtures — exact tax math, recall share,
// telemetry-absent n/a path, dropCause bucketing, zero-suffix guard.

const FEED = [
  {
    turn: 1,
    stablePrefixTokens: 4000,
    suffixTokens: 800,
    sections: [
      { name: "Memory Recall", chars: 1200, estTokens: 300 },
      { name: "Working Context", chars: 2000, estTokens: 500 },
    ],
    input: 4800,
    cacheRead: 0,
  },
  {
    turn: 2,
    stablePrefixTokens: 4000,
    suffixTokens: 800,
    sections: [
      { name: "Memory Recall", chars: 1200, estTokens: 300 },
      { name: "Working Context", chars: 2000, estTokens: 500 },
    ],
    input: 4800,
    cacheRead: 4000,
    dropCause: "provider-cache-reuse-lost:suffix-churn",
  },
  {
    turn: 3,
    stablePrefixTokens: 4000,
    suffixTokens: 400,
    sections: [{ name: "Working Context", chars: 1600, estTokens: 400 }],
    // no usage telemetry at all — offline capture lane
  },
];

describe("parseArgs", () => {
  it("parses --key=value and bare flags", () => {
    expect(parseArgs(["--feed=/tmp/f.jsonl", "--out", "--pricing-in=2"])).toEqual({
      feed: "/tmp/f.jsonl",
      out: true,
      "pricing-in": "2",
    });
  });
});

describe("parseFeed", () => {
  it("parses JSONL, skips blanks, rejects malformed", () => {
    const text = FEED.map((r) => JSON.stringify(r)).join("\n") + "\n\n";
    expect(parseFeed(text)).toHaveLength(3);
    expect(() => parseFeed("not-json")).toThrow(/line 1/);
    expect(() => parseFeed('{"noTurn":1}')).toThrow(/turn/);
    expect(() => parseFeed("")).toThrow(/empty/);
  });
});

describe("computeRecordMetrics", () => {
  it("computes recall share, hit ratio, and tax exactly", () => {
    const m1 = computeRecordMetrics(FEED[0]);
    expect(m1.recallShare).toBeCloseTo(300 / 800);
    expect(m1.cacheHitRatio).toBe(0);
    // cold turn: full suffix is tax
    expect(m1.rePrefillTaxTokens).toBe(800);
    const m2 = computeRecordMetrics(FEED[1]);
    expect(m2.cacheHitRatio).toBeCloseTo(4000 / 4800);
    // 800 × (1 − 4000/4800) = 800 × 1/6 ≈ 133
    expect(m2.rePrefillTaxTokens).toBe(Math.round(800 * (1 - 4000 / 4800)));
    expect(m2.boundaryBreak).toBe(true);
  });

  it("labels tax n/a (null) when telemetry absent", () => {
    const m3 = computeRecordMetrics(FEED[2]);
    expect(m3.cacheHitRatio).toBeNull();
    expect(m3.rePrefillTaxTokens).toBeNull();
    expect(m3.costUsd).toBeNull();
  });

  it("recall share 0 when section absent; null-safe on zero suffix", () => {
    expect(computeRecordMetrics(FEED[2]).recallShare).toBe(0);
    const zero = computeRecordMetrics({
      turn: 9,
      suffixTokens: 0,
      sections: [{ name: "Memory Recall", chars: 10, estTokens: 3 }],
    });
    expect(zero.recallShare).toBeNull(); // degenerate: recall exists but no suffix
    expect(zero.rePrefillTaxTokens).toBeNull();
  });

  it("computes optional cost from pricing", () => {
    const m = computeRecordMetrics(FEED[0], 2);
    expect(m.costUsd).toBeCloseTo((4800 * 2) / 1e6);
  });
});

describe("aggregate + renderReport", () => {
  it("aggregates means, histogram, boundary breaks", () => {
    const agg = aggregate(FEED);
    expect(agg.n).toBe(3);
    expect(agg.telemetryRecords).toBe(2);
    expect(agg.suffixTokensMean).toBeCloseTo((800 + 800 + 400) / 3);
    expect(agg.boundaryBreaks).toBe(1);
    expect(agg.dropCauseHistogram["provider-cache-reuse-lost:suffix-churn"]).toBe(1);
    expect(agg.dropCauseHistogram["(none)"]).toBe(2);
    expect(agg.recallShareMean).toBeCloseTo((300 / 800 + 300 / 800 + 0) / 3);
  });

  it("renders a report with n/a tax when no telemetry anywhere", () => {
    const agg = aggregate([FEED[2]]);
    const md = renderReport(agg, { feed: "x.jsonl", date: "2026-10-17" });
    expect(md).toContain("# Prompt Prefix Tax Audit");
    expect(md).toContain("upper bound = full suffix");
    expect(md).not.toContain("NaN");
  });
});
