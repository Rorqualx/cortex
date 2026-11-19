// PROBE SPIKE (throwaway) — card 42510695. Delete after probe; findings live in
// memory/reports/lab/2026-11-17_42510695.md.
import { describe, expect, it } from "vitest";
import { computeTrajectoryReliability, weightedMean } from "./trajectory-reliability.js";

describe("probe: trajectory reliability", () => {
  it("neutral law: all signals absent ⇒ successScore unchanged (incl. 3dp float safety)", () => {
    expect(computeTrajectoryReliability({ successScore: 1 })).toBe(1);
    expect(computeTrajectoryReliability({ successScore: 0.5 })).toBe(0.5);
    expect(computeTrajectoryReliability({ successScore: 1, doomLoop: false, steerCount: 0, tokenOverrun: false })).toBe(1);
  });

  it("penalties: doom −0.3, overrun −0.2, steer −0.05 each", () => {
    expect(computeTrajectoryReliability({ successScore: 1, doomLoop: true })).toBe(0.7);
    expect(computeTrajectoryReliability({ successScore: 1, tokenOverrun: true })).toBe(0.8);
    expect(computeTrajectoryReliability({ successScore: 1, steerCount: 2 })).toBe(0.9);
  });

  it("steer penalty caps at −0.15", () => {
    expect(computeTrajectoryReliability({ successScore: 1, steerCount: 3 })).toBe(0.85);
    expect(computeTrajectoryReliability({ successScore: 1, steerCount: 10 })).toBe(0.85);
  });

  it("floor at 0 and 3dp rounding", () => {
    expect(computeTrajectoryReliability({ successScore: 0.5, doomLoop: true, tokenOverrun: true, steerCount: 3 })).toBe(0);
    expect(computeTrajectoryReliability({ successScore: 1, steerCount: 1 })).toBe(0.95);
  });

  it("weightedMean: equal weights ⇒ arithmetic mean; skewed weights pull toward weight", () => {
    // 2 clean (1.0) + 1 tainted (0.5), equal reliability ⇒ mean = 5/6 ≈ 0.833
    expect(
      weightedMean([
        { reliability: 1, successScore: 1 },
        { reliability: 1, successScore: 1 },
        { reliability: 1, successScore: 0.5 },
      ]),
    ).toBe(0.833);
    // tainted member with low reliability barely moves the mean
    expect(
      weightedMean([
        { reliability: 1, successScore: 1 },
        { reliability: 0.05, successScore: 0.5 },
      ]),
    ).toBe(0.976);
    expect(weightedMean([])).toBe(0);
  });

  it("lane invariance with real-score domain {0.5, 1}: weighted mean of tainted clusters stays in [0.5, 1)", () => {
    const members = Array.from({ length: 5 }, () => ({ reliability: 1, successScore: 0.5 }));
    const merged = weightedMean(members);
    expect(merged).toBe(0.5); // all-tainted degenerates to today's 0.5 lane
    const mixed = weightedMean([
      { reliability: 1, successScore: 1 },
      { reliability: 1, successScore: 0.5 },
    ]);
    expect(mixed).toBeGreaterThanOrEqual(0.5);
    expect(mixed).toBeLessThan(1); // isBorderlineCandidate band [0.5,1) preserved
  });
});
