import { describe, expect, it } from "vitest";
import { pressureAdaptiveTopK } from "./engine.js";

// F9 (2026-08-28): pressure-adaptive recall volume at the assembly step.
// The engine's buildMemorySection() scales its retrieveTopK count with
// current context-token pressure (estimatedTokens / tokenBudget, clamped
// to [0,1]); this file pins the mapping so regressions are caught cheaply.
describe("pressureAdaptiveTopK", () => {
  it("returns the full baseline topK at zero pressure", () => {
    expect(pressureAdaptiveTopK(0)).toBe(5);
  });

  it("trims linearly as pressure rises", () => {
    expect(pressureAdaptiveTopK(0.5)).toBe(4);
    expect(pressureAdaptiveTopK(0.75)).toBeGreaterThanOrEqual(3);
  });

  it("floors at the minimum under full pressure", () => {
    expect(pressureAdaptiveTopK(1)).toBe(3);
  });

  it("clamps out-of-range pressure inputs", () => {
    expect(pressureAdaptiveTopK(-0.5)).toBe(5);
    expect(pressureAdaptiveTopK(2)).toBe(3);
    expect(pressureAdaptiveTopK(Number.NaN)).toBe(5);
  });
});
