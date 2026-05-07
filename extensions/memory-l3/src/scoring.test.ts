import { describe, expect, it } from "vitest";
import {
  composite,
  DEFAULT_SCORING_CONFIG,
  jaccard,
  recencyScore,
  scoreFact,
  tokenize,
} from "./scoring.js";

describe("tokenize", () => {
  it("lowercases, splits on whitespace, and drops short tokens", () => {
    expect(tokenize("The QUICK Brown fox")).toEqual(new Set(["the", "quick", "brown", "fox"]));
  });

  it("strips punctuation", () => {
    expect(tokenize("hello, world! it's great.")).toEqual(
      new Set(["hello", "world", "it", "great"]),
    );
  });

  it("drops single-character tokens", () => {
    expect(tokenize("a is b")).toEqual(new Set(["is"]));
  });

  it("returns an empty set for empty input", () => {
    expect(tokenize("")).toEqual(new Set());
  });
});

describe("jaccard", () => {
  it("returns 1.0 when sets are identical", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  it("returns 0 when sets are disjoint", () => {
    expect(jaccard(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("returns intersection-over-union for partial overlap", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(2 / 4, 6);
  });

  it("returns 0 when either side is empty", () => {
    expect(jaccard(new Set(), new Set(["a"]))).toBe(0);
    expect(jaccard(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("recencyScore", () => {
  it("returns 1.0 at age 0", () => {
    expect(recencyScore(0, 7)).toBeCloseTo(1, 6);
  });

  it("returns 0.5 at one half-life", () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(recencyScore(sevenDaysMs, 7)).toBeCloseTo(0.5, 6);
  });

  it("returns 0.25 at two half-lives", () => {
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    expect(recencyScore(fourteenDaysMs, 7)).toBeCloseTo(0.25, 6);
  });

  it("clamps negative ages to 0 (treats them as fresh)", () => {
    expect(recencyScore(-1000, 7)).toBeCloseTo(1, 6);
  });

  it("returns 1 when half-life is non-positive", () => {
    expect(recencyScore(1_000_000, 0)).toBe(1);
    expect(recencyScore(1_000_000, -1)).toBe(1);
  });
});

describe("scoreFact + composite", () => {
  it("rewards lexical overlap with the query", () => {
    const config = DEFAULT_SCORING_CONFIG;
    const fact = {
      id: "f1",
      text: "user prefers morning standups",
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: "k:1",
    };
    const queryTokens = tokenize("morning standups");
    const signals = scoreFact({ queryTokens, fact, now: Date.now(), config });
    expect(signals.lexical).toBeGreaterThan(0);
    expect(composite(signals, config)).toBeGreaterThan(0);
  });

  it("decays with age", () => {
    const config = DEFAULT_SCORING_CONFIG;
    const old = {
      id: "f1",
      text: "anything",
      importance: 0.5,
      createdAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      dedupKey: "k:1",
    };
    const fresh = { ...old, createdAt: Date.now(), id: "f2" };
    const queryTokens = tokenize("xyz"); // no lexical hit
    const oldSignals = scoreFact({ queryTokens, fact: old, now: Date.now(), config });
    const freshSignals = scoreFact({ queryTokens, fact: fresh, now: Date.now(), config });
    expect(freshSignals.recency).toBeGreaterThan(oldSignals.recency);
  });

  it("composite is the weighted sum of signals", () => {
    const config = {
      weightLexical: 0.5,
      weightImportance: 0.3,
      weightRecency: 0.2,
      recencyHalfLifeDays: 7,
    };
    const score = composite({ lexical: 1.0, importance: 1.0, recency: 1.0 }, config);
    expect(score).toBeCloseTo(1.0, 6);
    const half = composite({ lexical: 0.5, importance: 0.5, recency: 0.5 }, config);
    expect(half).toBeCloseTo(0.5, 6);
  });
});
