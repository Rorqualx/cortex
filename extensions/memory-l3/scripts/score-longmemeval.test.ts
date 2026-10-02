import { describe, expect, it } from "vitest";
import {
  countTemporalPreserved,
  extractTemporalExpressions,
  pickStabilitySample,
  summarizeStabilityRuns,
} from "./score-longmemeval.mjs";

// Temporal-expression preservation metric (QW2, 2026-08-25): deterministic
// anchor extraction + survival counting. Guards the TEMPORAL prompt rule's
// downstream effect without an extra judge call.

describe("extractTemporalExpressions", () => {
  it("extracts every guarded anchor category", () => {
    const anchors = extractTemporalExpressions(
      "Met on 2026-08-16 at 9:00 AM; runs every Tuesday for 3 weeks; revisit next month; moved from Aug 2, 2025.",
    );
    expect(anchors).toContain("2026-08-16");
    expect(anchors).toContain("9:00 am");
    expect(anchors).toContain("every tuesday");
    expect(anchors).toContain("3 weeks");
    expect(anchors).toContain("next month");
    expect(anchors).toContain("aug 2, 2025");
  });

  it("normalizes case and whitespace and dedupes repeats", () => {
    const anchors = extractTemporalExpressions("EVERY   Tuesday and every tuesday");
    expect(anchors).toEqual(["every tuesday"]);
  });

  it("returns nothing for text without temporal expressions", () => {
    expect(extractTemporalExpressions("Joe likes ramen and trains")).toEqual([]);
  });
});

describe("countTemporalPreserved", () => {
  it("counts anchors surviving in a normalized response", () => {
    const r = countTemporalPreserved(
      "Payment due 2026-08-16 and renewals every Tuesday",
      "The   payment is due 2026-08-16; renewals happen EVERY TUESDAY.",
    );
    expect(r).toEqual({ total: 2, preserved: 2 });
  });

  it("does not credit abbreviated or dropped anchors", () => {
    const r = countTemporalPreserved(
      "Flight departs 14:30 on 2026-08-16",
      "The flight departs in the afternoon that day.",
    );
    expect(r).toEqual({ total: 2, preserved: 0 });
  });

  it("reports zero anchors when the answer has no temporal expression", () => {
    expect(countTemporalPreserved("Joe likes ramen", "Joe likes ramen")).toEqual({
      total: 0,
      preserved: 0,
    });
  });

  it("handles nullish inputs without throwing", () => {
    expect(countTemporalPreserved(undefined, undefined)).toEqual({ total: 0, preserved: 0 });
  });
});

// Judge stability check (QW2, 2026-10-02): deterministic sampling + flip
// summarization for byte-identical re-judging. Guards against judge verdict
// noise corrupting the metric every memory-l3 change is judged by.

describe("pickStabilitySample", () => {
  it("is deterministic for a fixed seed and caps to the requested size", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    const a = pickStabilitySample(items, 8, 20261002);
    const b = pickStabilitySample(items, 8, 20261002);
    expect(a).toEqual(b);
    expect(a).toHaveLength(8);
    expect(new Set(a).size).toBe(8);
  });

  it("returns the full list in order when size >= length", () => {
    expect(pickStabilitySample([1, 2, 3], 5, 20261002)).toEqual([1, 2, 3]);
  });

  it("samples differently under a different seed", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(pickStabilitySample(items, 8, 1)).not.toEqual(pickStabilitySample(items, 8, 2));
  });
});

describe("summarizeStabilityRuns", () => {
  it("marks a flip when byte-identical answers get different verdicts", () => {
    expect(summarizeStabilityRuns([true, true, false, true])).toEqual({
      repeats: 4,
      distinctVerdicts: 2,
      flipped: true,
      unparseable: 0,
    });
  });

  it("stable verdicts do not flip", () => {
    expect(summarizeStabilityRuns([true, true, true]).flipped).toBe(false);
  });

  it("ignores unparseable nulls for flip detection but counts them", () => {
    expect(summarizeStabilityRuns([true, null, true])).toEqual({
      repeats: 3,
      distinctVerdicts: 1,
      flipped: false,
      unparseable: 1,
    });
  });

  it("flips even when nulls are interleaved", () => {
    expect(summarizeStabilityRuns([true, null, false]).flipped).toBe(true);
  });
});
