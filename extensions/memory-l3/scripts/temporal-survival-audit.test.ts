import { describe, expect, it } from "vitest";
import { countOrderInversions } from "./temporal-survival-audit.mjs";

// QW1 order-fidelity pass (2026-11-22, arXiv:2609.36457): pure unit tests
// over the within-chunk anchor-pair comparison — preserved order, inversions,
// non-surviving anchors excluded from pairs, and the O(n²) cap.

const PRE = "left on 2026-11-02 then again on 12/04/2026 at 9:30 finally 2026-11-20";

describe("countOrderInversions", () => {
  it("reports zero inversions when post preserves pre order", () => {
    const post = "remembered: 2026-11-02 first; then 12/04/2026; 9:30 after that; 2026-11-20 last.";
    const anchors = ["2026-11-02", "12/04/2026", "9:30", "2026-11-20"];
    expect(countOrderInversions(anchors, PRE, post)).toEqual({ pairs: 6, inversions: 0 });
  });

  it("counts each flipped pair", () => {
    // Post reverses the first two anchors AND the last two: (1,2) and (3,4) flip.
    const post = "later 12/04/2026 before 2026-11-02; then 2026-11-20 before 9:30.";
    const anchors = ["2026-11-02", "12/04/2026", "9:30", "2026-11-20"];
    expect(countOrderInversions(anchors, PRE, post)).toEqual({ pairs: 6, inversions: 2 });
  });

  it("excludes anchors that did not survive from the pair count", () => {
    // Only two anchors survive; their order is preserved.
    const post = "kept 2026-11-02 and 2026-11-20 only.";
    const anchors = ["2026-11-02", "12/04/2026", "9:30", "2026-11-20"];
    expect(countOrderInversions(anchors, PRE, post)).toEqual({ pairs: 1, inversions: 0 });
  });

  it("treats tied post positions (substring anchors) as preserved", () => {
    // "10:00" sits inside "2026-11-22 10:00" at the same post offset — tie.
    const pre = "logged 2026-11-22 10:00 and separately 10:00 sharp";
    const post = "2026-11-22 10:00 survived verbatim";
    const anchors = ["2026-11-22 10:00", "10:00"];
    expect(countOrderInversions(anchors, pre, post)).toEqual({ pairs: 1, inversions: 0 });
  });

  it("caps the pair comparison at 20 anchors", () => {
    // 25 surviving anchors in identical order: cap → exactly C(20,2)=190 pairs.
    const years = Array.from({ length: 25 }, (_, i) => `year-${String(i).padStart(2, "0")}`);
    const pre = years.join(" ");
    const post = years.join(" ");
    expect(countOrderInversions(years, pre, post)).toEqual({ pairs: 190, inversions: 0 });
  });

  it("returns zero pairs when nothing survived", () => {
    expect(countOrderInversions(["2026-11-02"], PRE, "nothing survived")).toEqual({
      pairs: 0,
      inversions: 0,
    });
  });
});
