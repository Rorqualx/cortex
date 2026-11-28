// QW3 (2026-11-27, NFA): near/far scoring split — unit tests for the
// zone resolver and the recency re-weighting profiles.
import { describe, expect, it } from "vitest";
import {
  applyNearFarProfile,
  DEFAULT_NEAR_FAR_WINDOW_MS,
  FAR_RECENCY_MULTIPLIER,
  NEAR_RECENCY_MULTIPLIER,
  resolveNearFarZone,
} from "./near-far-presets.js";
import { DEFAULT_SCORING_CONFIG } from "./scoring.js";

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

describe("resolveNearFarZone", () => {
  it("maps consolidated tiers to far regardless of age", () => {
    for (const tier of ["longterm", "longterm-typed", "insight", "procedural", "shared"]) {
      expect(resolveNearFarZone(tier, NOW, NOW, DEFAULT_NEAR_FAR_WINDOW_MS)).toBe("far");
    }
  });

  it("maps recent session-archive items to near", () => {
    for (const tier of ["l2", "typed", "memory-core"]) {
      expect(resolveNearFarZone(tier, NOW - DAY, NOW, DEFAULT_NEAR_FAR_WINDOW_MS)).toBe("near");
    }
  });

  it("maps session-archive items older than the window to far (age-neutral)", () => {
    expect(
      resolveNearFarZone(
        "l2",
        NOW - DEFAULT_NEAR_FAR_WINDOW_MS - 1,
        NOW,
        DEFAULT_NEAR_FAR_WINDOW_MS,
      ),
    ).toBe("far");
    expect(resolveNearFarZone("typed", NOW - 30 * DAY, NOW, DEFAULT_NEAR_FAR_WINDOW_MS)).toBe(
      "far",
    );
  });

  it("treats the window boundary as near (inclusive)", () => {
    expect(
      resolveNearFarZone("l2", NOW - DEFAULT_NEAR_FAR_WINDOW_MS, NOW, DEFAULT_NEAR_FAR_WINDOW_MS),
    ).toBe("near");
  });
});

describe("applyNearFarProfile", () => {
  it("doubles weightRecency for near-zone items", () => {
    const config = applyNearFarProfile(DEFAULT_SCORING_CONFIG, "near");
    expect(config.weightRecency).toBeCloseTo(
      DEFAULT_SCORING_CONFIG.weightRecency * NEAR_RECENCY_MULTIPLIER,
      10,
    );
  });

  it("shrinks weightRecency for far-zone items (age-neutral far pool)", () => {
    const config = applyNearFarProfile(DEFAULT_SCORING_CONFIG, "far");
    expect(config.weightRecency).toBeCloseTo(
      DEFAULT_SCORING_CONFIG.weightRecency * FAR_RECENCY_MULTIPLIER,
      10,
    );
  });

  it("preserves every other weight (composes with presets, never clobbers)", () => {
    for (const zone of ["near", "far"] as const) {
      const config = applyNearFarProfile(DEFAULT_SCORING_CONFIG, zone);
      expect(config.weightBm25).toBe(DEFAULT_SCORING_CONFIG.weightBm25);
      expect(config.weightImportance).toBe(DEFAULT_SCORING_CONFIG.weightImportance);
      expect(config.weightSemantic).toBe(DEFAULT_SCORING_CONFIG.weightSemantic);
      expect(config.weightReliability).toBe(DEFAULT_SCORING_CONFIG.weightReliability);
    }
  });

  it("scales a preset's deliberate recency choice proportionally", () => {
    // keyword-first category preset sets weightRecency 0.02 — the split
    // must scale it, not reset it to the default's value.
    const presetLike = { ...DEFAULT_SCORING_CONFIG, weightRecency: 0.02 };
    const far = applyNearFarProfile(presetLike, "far");
    expect(far.weightRecency).toBeCloseTo(0.02 * FAR_RECENCY_MULTIPLIER, 10);
    const near = applyNearFarProfile(presetLike, "near");
    expect(near.weightRecency).toBeCloseTo(0.02 * NEAR_RECENCY_MULTIPLIER, 10);
  });
});
