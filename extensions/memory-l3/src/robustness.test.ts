import { describe, expect, it } from "vitest";
import {
  computeRobustnessBar,
  maxPairwiseDelta,
  renderRobustnessBar,
} from "../scripts/robustness.mjs";
import { pickStabilitySample } from "../scripts/score-longmemeval.mjs";

// Robustness bar (ARCH-2, 2026-10-12): interface-sensitivity measurement —
// same sampled answers, every judge variant, max pairwise delta. Unit-tested
// with a fake judge (no network). Convention note: this test lives under
// src/ so the vitest project glob picks it up; the helper stays in scripts/.

describe("maxPairwiseDelta", () => {
  it("returns 0 for a single variant (nothing to compare)", () => {
    expect(maxPairwiseDelta([0.8])).toBe(0);
  });

  it("returns 0 for an empty list", () => {
    expect(maxPairwiseDelta([])).toBe(0);
  });

  it("computes max |a-b| over all pairs", () => {
    expect(maxPairwiseDelta([0.8, 0.7, 0.95])).toBeCloseTo(0.25);
    expect(maxPairwiseDelta([0.7, 0.82, 0.61])).toBeCloseTo(0.21);
  });
});

describe("renderRobustnessBar", () => {
  it("renders the exact interface-sensitivity bar shape", () => {
    expect(renderRobustnessBar({ accuracy: 0.71, maxDelta: 0.12, variants: 3, sampled: 50 })).toBe(
      "accuracy = 71% ± 12% (interface-sensitivity bar, 3 variants, 50 sampled)",
    );
  });
});

describe("computeRobustnessBar", () => {
  const sample = [
    { id: 1, correct: "a" },
    { id: 2, correct: "b" },
    { id: 3, correct: "c" },
    { id: 4, correct: "d" },
  ];

  it("judges the SAME sampled items per variant and reports the bar", async () => {
    // Primary gets 3/4 right; secondary 2/4 → maxDelta 0.25.
    const correctById = new Map([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
    ]);
    const bar = await computeRobustnessBar({
      sample,
      primaryModel: "primary",
      secondaryModels: ["secondary"],
      judge: async (item, model) => (model === "primary" ? correctById.get(item.id) : item.id <= 2),
    });
    expect(bar.status).toBe("ok");
    expect(bar.rows).toHaveLength(2);
    expect(bar.rows[0]).toMatchObject({ variant: "primary", judged: 4, correct: 3 });
    expect(bar.rows[1]).toMatchObject({ variant: "secondary", judged: 4, correct: 2 });
    expect(bar.maxDelta).toBeCloseTo(0.25);
    expect(bar.render).toBe(
      "accuracy = 75% ± 25% (interface-sensitivity bar, 2 variants, 4 sampled)",
    );
  });

  it("counts null verdicts as unparseable, not judged", async () => {
    const bar = await computeRobustnessBar({
      sample,
      primaryModel: "p",
      secondaryModels: ["s"],
      judge: async (item) => (item.id === 1 ? null : true),
    });
    expect(bar.rows.every((r) => r.judged === 3 && r.correct === 3)).toBe(true);
  });

  it("degrades to SKIPPED (never throws) with no secondary judge configured", async () => {
    const bar = await computeRobustnessBar({
      sample,
      primaryModel: "p",
      secondaryModels: [],
      judge: async () => true,
    });
    expect(bar).toEqual({
      status: "skipped",
      render: "robustness: SKIPPED (no secondary judge configured)",
    });
  });

  it("invokes the judge exactly n×k times (cost contract)", async () => {
    let calls = 0;
    await computeRobustnessBar({
      sample,
      primaryModel: "p",
      secondaryModels: ["s1", "s2"],
      judge: async () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(sample.length * 3);
  });

  it("determinism: ROBUSTNESS_SEED sampling is stable across calls", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    const a = pickStabilitySample(items, 10, 20261008);
    const b = pickStabilitySample(items, 10, 20261008);
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    // A different seed must produce a different sample at this size.
    const c = pickStabilitySample(items, 10, 20261002);
    expect(c).not.toEqual(a);
  });
});
