import { describe, expect, it } from "vitest";
import { TYPED_FACT_CATEGORIES } from "./categories.js";
import {
  CATEGORY_PRESET_GROUPS,
  getCategoryScoringPreset,
  resolveTypedFactCategory,
} from "./category-presets.js";
import { DEFAULT_SCORING_CONFIG } from "./scoring.js";

// MemoType type-dispatched retrieval (QW3, 2026-10-09): per-category scoring
// presets for typed facts. Groups follow the fact-kind taxonomy: rule-like
// values are keyword-first, episodic facts semantic-first, open work
// recency-weighted.

describe("CATEGORY_PRESET_GROUPS", () => {
  it("maps every canonical category to a group", () => {
    for (const category of TYPED_FACT_CATEGORIES) {
      expect(CATEGORY_PRESET_GROUPS[category]).toBeDefined();
    }
  });

  it("assigns the MemoType-documented groups", () => {
    expect(CATEGORY_PRESET_GROUPS.infra).toBe("keyword-first");
    expect(CATEGORY_PRESET_GROUPS.preference).toBe("keyword-first");
    expect(CATEGORY_PRESET_GROUPS.project).toBe("keyword-first");
    expect(CATEGORY_PRESET_GROUPS.environment).toBe("keyword-first");
    expect(CATEGORY_PRESET_GROUPS.person).toBe("keyword-first");
    expect(CATEGORY_PRESET_GROUPS.attempt).toBe("semantic-first");
    expect(CATEGORY_PRESET_GROUPS.diagnosis).toBe("semantic-first");
    expect(CATEGORY_PRESET_GROUPS.task).toBe("recency-weighted");
    expect(CATEGORY_PRESET_GROUPS.subgoal).toBe("recency-weighted");
  });
});

describe("getCategoryScoringPreset", () => {
  it("keyword-first categories get exact-term-dominant weights", () => {
    const preset = getCategoryScoringPreset("infra");
    expect(preset.weightBm25).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weightBm25);
    expect(preset.weightSemantic).toBeLessThan(DEFAULT_SCORING_CONFIG.weightSemantic);
    expect(preset.weightRecency).toBeLessThan(DEFAULT_SCORING_CONFIG.weightRecency);
  });

  it("semantic-first categories get paraphrase-dominant weights", () => {
    const preset = getCategoryScoringPreset("attempt");
    expect(preset.weightSemantic).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weightSemantic);
    expect(preset.weightBm25).toBeLessThan(DEFAULT_SCORING_CONFIG.weightBm25);
  });

  it("recency-weighted categories get current-state-dominant weights", () => {
    const preset = getCategoryScoringPreset("task");
    expect(preset.weightRecency).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weightRecency);
  });

  it("falls back to the default config for unknown categories", () => {
    expect(getCategoryScoringPreset("not-a-category")).toEqual(DEFAULT_SCORING_CONFIG);
    expect(getCategoryScoringPreset("")).toEqual(DEFAULT_SCORING_CONFIG);
  });
});

describe("resolveTypedFactCategory", () => {
  it("prefers a valid explicit category over slot inference", () => {
    expect(resolveTypedFactCategory("infra:thing", "person")).toBe("person");
  });

  it("infers from slot namespaces when no explicit category exists", () => {
    expect(resolveTypedFactCategory("infra:pi_hole_ip")).toBe("infra");
    expect(resolveTypedFactCategory("task:migration")).toBe("task");
    expect(resolveTypedFactCategory("attempt:cache_bust")).toBe("attempt");
    expect(resolveTypedFactCategory("user:phone")).toBe("preference");
  });

  it("returns undefined for slots with no inferable namespace", () => {
    expect(resolveTypedFactCategory("gateway")).toBeUndefined();
  });

  it("ignores invalid explicit values (falls back to slot inference)", () => {
    expect(resolveTypedFactCategory("infra:thing", "bogus")).toBe("infra");
  });
});
