import { describe, expect, it } from "vitest";
import { cosine, perturbTimeAxis, summarizeDrift } from "./axis-drift.mjs";

// Axis-counterfactual embedding drift (QW2, 2026-11-14): deterministic
// time-axis perturbation + cosine drift summary. The perturbation is the
// counterfactual handed to the embedding provider — it must change every
// temporal token class and leave everything else byte-identical.

describe("perturbTimeAxis", () => {
  it("shifts ISO dates by one year", () => {
    const out = perturbTimeAxis("Meeting was on 2026-08-16 about the greenhouse");
    expect(out).toContain("2027-08-16");
    expect(out).not.toContain("2026-08-16");
  });

  it("shifts full ISO timestamps by one year", () => {
    const out = perturbTimeAxis("Logged 2026-08-16T09:30:00Z");
    expect(out).toMatch(/^Logged 2027-08-16/);
  });

  it("shifts full slash dates by one year", () => {
    expect(perturbTimeAxis("due 2026/08/16")).toBe("due 2027/08/16");
  });

  it("swaps day/month in short slash dates when they differ", () => {
    expect(perturbTimeAxis("on 3/7/2026")).toBe("on 7/3/2026");
  });

  it("leaves short slash dates with equal groups untouched", () => {
    expect(perturbTimeAxis("on 7/7/2026")).toBe("on 7/7/2026");
  });

  it("swaps full month names preserving case", () => {
    expect(perturbTimeAxis("starts January 5")).toBe("starts July 5");
    expect(perturbTimeAxis("revisit 12 september")).toBe("revisit 12 march");
  });

  it("maps sept (4-letter abbreviation) to the full counterpart", () => {
    expect(perturbTimeAxis("due sept 5")).toBe("due march 5");
  });

  it("swaps 3-letter month abbreviations", () => {
    expect(perturbTimeAxis("due jan 5")).toBe("due jul 5");
  });

  it("month swap is an involution on month tokens", () => {
    // No years/clocks in this text, so two passes restore the original byte-for-byte.
    const original = "starts January 5 and ends jun 30";
    const once = perturbTimeAxis(original);
    expect(once).toBe("starts July 5 and ends dec 30");
    expect(perturbTimeAxis(once)).toBe(original);
  });

  it("shifts 12-hour clock times by one hour", () => {
    expect(perturbTimeAxis("at 9:00 AM")).toBe("at 10:00 AM");
    expect(perturbTimeAxis("at 12:30am")).toBe("at 1:30am");
  });

  it("shifts 24-hour clock times modulo 24", () => {
    expect(perturbTimeAxis("at 23:45")).toBe("at 0:45");
  });

  it("leaves non-temporal text byte-identical", () => {
    const text = "Joe likes ramen and the underground greenhouse design";
    expect(perturbTimeAxis(text)).toBe(text);
  });
});

describe("cosine", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("returns null for empty or zero vectors", () => {
    expect(cosine([], [])).toBeNull();
    expect(cosine([0, 0], [1, 1])).toBeNull();
  });
});

describe("summarizeDrift", () => {
  it("summarizes a known distribution", () => {
    const s = summarizeDrift([0.001, 0.005, 0.02, 0.05]);
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(0.019, 3);
    expect(s.median).toBe(0.02);
    expect(s.p90).toBe(0.05);
    expect(s.min).toBe(0.001);
    expect(s.max).toBe(0.05);
    expect(s.axisBlind).toBe(2); // 0.001 and 0.005 below 0.01
  });

  it("honors a custom blind threshold", () => {
    expect(summarizeDrift([0.02, 0.05], 0.03).axisBlind).toBe(1);
  });

  it("returns nulls for empty input", () => {
    const s = summarizeDrift([]);
    expect(s.n).toBe(0);
    expect(s.mean).toBeNull();
    expect(s.median).toBeNull();
    expect(s.axisBlind).toBe(0);
  });
});
