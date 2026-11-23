// PROBE SPIKE TESTS (card f19820b6, 2026-11-22): composite OFF-identity,
// comparator tiebreak laws, budget-fn INERTNESS finding, readUtilityMaps
// neutral degradation. Throwaway with the probe.
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SCORING_CONFIG, composite, type Signals } from "./scoring.js";
import { applyCategoryBudget, compareBudgetedFacts } from "./compaction.js";
import type { ExtractedFact } from "./llm.js";
import {
  closeRetrievalUseStoreForTest,
  readUtilityMaps,
  recordRetrievalUses,
} from "./retrieval-use-store.js";
import { writeUtilityTables } from "../scripts/compute-retrieval-utility.mjs";

const BASE_SIGNALS: Signals = {
  lexical: 0.4,
  bm25: 0.2,
  importance: 0.8,
  recency: 0.5,
  l3Boost: 0,
  semantic: 0.7,
  informationGain: 0.3,
  goalRelevance: 0.2,
  reliability: 0.85,
  semanticEntropy: 0.9,
  validity: 1,
  entityScore: 0.1,
  temporalAlignment: 0.5,
  polarityMultiplier: 1,
};

function fact(dedupKey: string, importance: number): ExtractedFact {
  return { dedupKey, text: `fact ${dedupKey}`, importance };
}

// OFF-identity law comes first in every spike test file (file-order law).
describe("futureUtility OFF-identity (weight 0/absent = byte-identical composite)", () => {
  it("weight 0 + signal present === baseline; signal present + weight default === baseline", () => {
    const baseline = composite(BASE_SIGNALS, DEFAULT_SCORING_CONFIG);
    const zeroWeight = composite(BASE_SIGNALS, { ...DEFAULT_SCORING_CONFIG, weightFutureUtility: 0 });
    const signalOnly = composite({ ...BASE_SIGNALS, futureUtility: 0.7 }, DEFAULT_SCORING_CONFIG);
    expect(zeroWeight).toBe(baseline);
    expect(signalOnly).toBe(baseline);
  });

  it("armed weight + signal adds exactly weight × signal", () => {
    const baseline = composite(BASE_SIGNALS, DEFAULT_SCORING_CONFIG);
    const armed = composite(
      { ...BASE_SIGNALS, futureUtility: 0.5 },
      { ...DEFAULT_SCORING_CONFIG, weightFutureUtility: 0.1 },
    );
    expect(armed).toBeCloseTo(baseline + 0.05, 12);
  });
});

describe("compareBudgetedFacts tiebreak laws", () => {
  it("differentiates equal-importance facts of DIFFERENT categories (comparator grain only)", () => {
    const alpha = fact("alpha:a", 0.7);
    const beta = fact("beta:b", 0.7);
    const map = new Map([
      ["alpha", 1],
      ["beta", 0],
    ]);
    expect(compareBudgetedFacts(alpha, beta, map)).toBeLessThan(0);
    expect(compareBudgetedFacts(beta, alpha, map)).toBeGreaterThan(0);
  });

  it("never reorders facts of unequal importance regardless of utility", () => {
    const lowImpHighUtil = fact("alpha:a", 0.5);
    const highImpLowUtil = fact("beta:b", 0.9);
    const map = new Map([
      ["alpha", 1],
      ["beta", 0],
    ]);
    expect(compareBudgetedFacts(lowImpHighUtil, highImpLowUtil, map)).toBeGreaterThan(0);
  });

  it("no map + equal importance returns 0 (stable insertion order)", () => {
    expect(compareBudgetedFacts(fact("alpha:a", 0.7), fact("alpha:b", 0.7))).toBe(0);
  });
});

describe("budget-fn INERTNESS law (PROBE FINDING 2026-11-22)", () => {
  it("armed category map cannot change retention: within a category group the map value is constant by construction", () => {
    const facts: ExtractedFact[] = [];
    for (let i = 0; i < 5; i++) facts.push(fact(`alpha:${i}`, 0.7));
    for (let i = 0; i < 5; i++) facts.push(fact(`beta:${i}`, 0.7));
    const budget = 10; // forces drops in both categories
    const unarmed = applyCategoryBudget(facts, budget);
    const armed = applyCategoryBudget(facts, budget, new Map([["alpha", 1], ["beta", 0]]));
    expect(armed).toEqual(unarmed); // identical set AND order — the tiebreak is inert here
    expect(armed.length).toBeLessThan(facts.length); // drops really happened
  });
});

describe("readUtilityMaps neutral degradation", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "future-utility-"));
  });
  afterEach(() => {
    closeRetrievalUseStoreForTest();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("absent DB file ⇒ empty maps, no state created", () => {
    const maps = readUtilityMaps({ dir: tmpRoot });
    expect(maps.chunks.size).toBe(0);
    expect(maps.categories.size).toBe(0);
  });

  it("DB present, utility tables absent ⇒ empty maps (neutral, no throw)", () => {
    recordRetrievalUses({ sessionId: "s", items: [{ chunkId: "c1", tier: "l2" }], dir: tmpRoot });
    const maps = readUtilityMaps({ dir: tmpRoot });
    expect(maps.chunks.size).toBe(0);
    expect(maps.categories.size).toBe(0);
  });

  it("tables written ⇒ maps populated with written values", () => {
    recordRetrievalUses({ sessionId: "s", items: [{ chunkId: "c1", tier: "l2" }], dir: tmpRoot });
    const db = new DatabaseSync(path.join(tmpRoot, "retrieval-use.sqlite"));
    try {
      writeUtilityTables(
        db,
        {
          chunkUtility: [{ chunk_id: "c1", utility: 0.9, uses_total: 5, last_day: "2026-11-20" }],
          categoryUtility: [{ category: "alpha", utility: 0.9, chunk_count: 1 }],
        },
        "2026-11-22T00:00:00.000Z",
      );
    } finally {
      db.close();
    }
    const maps = readUtilityMaps({ dir: tmpRoot });
    expect(maps.chunks.get("c1")).toBeCloseTo(0.9, 12);
    expect(maps.categories.get("alpha")).toBeCloseTo(0.9, 12);
  });
});
