import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRecommendation,
  loadVariantTable,
  rankResults,
  VariantTableError,
  type VariantResult,
} from "./optimize-extract-prompt.js";

// ARCH-3 Phase 1 probe tests (2026-11-20): variant-table validation laws,
// ranking, and recommendation shape. Importing this module also proves the
// main-guard keeps the CLI inert under test import.

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "optimize-extract-prompt-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeTable(data: unknown): string {
  const filePath = path.join(tempDir, "table.json");
  writeFileSync(filePath, typeof data === "string" ? data : JSON.stringify(data), "utf8");
  return filePath;
}

const validTable = {
  variants: [
    { id: "v20-baseline", target: "extract", systemPrompt: "baseline text" },
    { id: "v21-a", target: "extract", systemPrompt: "variant a" },
    { id: "v20-native-baseline", target: "native", systemPrompt: "native baseline" },
  ],
};

describe("loadVariantTable laws", () => {
  it("accepts a valid baseline-first table", () => {
    const table = loadVariantTable(writeTable(validTable));
    expect(table.variants).toHaveLength(3);
    expect(table.variants[0]!.id).toBe("v20-baseline");
  });

  it("throws on unreadable file", () => {
    expect(() => loadVariantTable(path.join(tempDir, "missing.json"))).toThrow(VariantTableError);
  });

  it("throws on non-JSON content", () => {
    expect(() => loadVariantTable(writeTable("not json"))).toThrow(VariantTableError);
  });

  it("throws on empty variants array", () => {
    expect(() => loadVariantTable(writeTable({ variants: [] }))).toThrow(/non-empty/);
  });

  it("throws when first variant is not a baseline (baseline-first law)", () => {
    const flipped = {
      variants: [
        { id: "v21-a", target: "extract", systemPrompt: "a" },
        { id: "v20-baseline", target: "extract", systemPrompt: "b" },
      ],
    };
    expect(() => loadVariantTable(writeTable(flipped))).toThrow(/baseline-first/);
  });

  it("throws on duplicate ids", () => {
    const dup = {
      variants: [
        { id: "v20-baseline", target: "extract", systemPrompt: "a" },
        { id: "v20-baseline", target: "extract", systemPrompt: "b" },
      ],
    };
    expect(() => loadVariantTable(writeTable(dup))).toThrow(/duplicate/);
  });

  it("throws on bad target enum", () => {
    const bad = {
      variants: [
        { id: "v20-baseline", target: "both", systemPrompt: "a" },
      ],
    };
    expect(() => loadVariantTable(writeTable(bad))).toThrow(/"extract" or "native"/);
  });

  it("throws on empty systemPrompt", () => {
    const bad = {
      variants: [{ id: "v20-baseline", target: "extract", systemPrompt: "  " }],
    };
    expect(() => loadVariantTable(writeTable(bad))).toThrow(/non-empty/);
  });
});

describe("rankResults", () => {
  it("orders by accuracy desc, per-type mean tiebreak desc", () => {
    const a: VariantResult = { id: "a", target: "extract", accuracy: 0.5, perType: {}, guardFailures: [] };
    const b: VariantResult = { id: "b", target: "extract", accuracy: 0.7, perType: {}, guardFailures: [] };
    const c: VariantResult = { id: "c", target: "extract", accuracy: 0.7, perType: { x: 1.0 }, guardFailures: [] };
    expect(rankResults([a, b, c]).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate input order", () => {
    const a: VariantResult = { id: "a", target: "extract", accuracy: 0.1, perType: {}, guardFailures: [] };
    const b: VariantResult = { id: "b", target: "extract", accuracy: 0.9, perType: {}, guardFailures: [] };
    const input = [a, b];
    rankResults(input);
    expect(input.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("buildRecommendation", () => {
  it("picks the top-ranked variant and records baseline accuracy", () => {
    const baseline: VariantResult = { id: "v20-baseline", target: "extract", accuracy: 0.6, perType: {}, guardFailures: [] };
    const winner: VariantResult = { id: "v21-a", target: "extract", accuracy: 0.8, perType: {}, guardFailures: [] };
    const rec = buildRecommendation([baseline, winner], "tip-abc");
    expect(rec.recommendedVariantId).toBe("v21-a");
    expect(rec.baselineAccuracy).toBe(0.6);
    expect(rec.results[0]!.id).toBe("v21-a");
    expect(rec.tip).toBe("tip-abc");
    expect(typeof rec.timestamp).toBe("string");
  });

  it("disqualifies guard-failing winners", () => {
    const baseline: VariantResult = { id: "v20-baseline", target: "extract", accuracy: 0.6, perType: {}, guardFailures: [] };
    const guardFailed: VariantResult = { id: "v21-bad", target: "extract", accuracy: 0.9, perType: {}, guardFailures: ["temporal-survival-regression"] };
    const rec = buildRecommendation([baseline, guardFailed], "tip");
    expect(rec.recommendedVariantId).toBeNull();
    expect(rec.results[0]!.id).toBe("v21-bad");
    expect(rec.results[0]!.guardFailures).toEqual(["temporal-survival-regression"]);
  });
});
