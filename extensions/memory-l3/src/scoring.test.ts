import { describe, expect, it } from "vitest";
import {
  bm25Score,
  buildCorpusStats,
  composite,
  DEFAULT_FSRS_PARAMS,
  DEFAULT_SCORING_CONFIG,
  episodicValidity,
  fsrsRetrievability,
  jaccard,
  recencyScore,
  staleDemotionMultiplier,
  scoreFact,
  tokenize,
  volatilityMultiplier,
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

  it("preserves numeric runs with internal punctuation", () => {
    expect(tokenize("balance is $1,234.56 today")).toEqual(
      new Set(["balance", "is", "1,234.56", "today"]),
    );
  });

  it("preserves IP-like addresses as single tokens", () => {
    expect(tokenize("pi-hole at 192.168.50.128 listens")).toEqual(
      new Set(["pi", "hole", "at", "192.168.50.128", "listens"]),
    );
  });

  it("keeps single digits but drops single letters", () => {
    expect(tokenize("port 5 on host a")).toEqual(new Set(["port", "5", "on", "host"]));
  });

  it("preserves version-like decimals", () => {
    expect(tokenize("running v1.2.3 stack")).toEqual(new Set(["running", "1.2.3", "stack"]));
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
      weightBm25: 0,
      weightImportance: 0.3,
      weightRecency: 0.1,
      weightL3Boost: 0.1,
      weightLongTermTierBoost: 0,
      weightMemoryCoreTierMultiplier: 0.7,
      weightTypedFactTierBoost: 0,
      recencyHalfLifeDays: 7,
      useFsrs: false,
      weightSemantic: 0,
      weightInformationGain: 0,
      weightGoalRelevance: 0,
      weightReliability: 0,
      weightSemanticEntropy: 0,
      weightValidity: 0,
    };
    const score = composite(
      {
        lexical: 1,
        bm25: 0,
        importance: 1,
        recency: 1,
        l3Boost: 1,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 0,
        semanticEntropy: 1.0,
        validity: 1.0,
      },
      config,
    );
    expect(score).toBeCloseTo(1, 6);
    const half = composite(
      {
        lexical: 0.5,
        bm25: 0,
        importance: 0.5,
        recency: 0.5,
        l3Boost: 0.5,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 0,
        semanticEntropy: 1.0,
        validity: 1.0,
      },
      config,
    );
    expect(half).toBeCloseTo(0.5, 6);
  });

  it("information gain contributes only when weighted", () => {
    const config = {
      weightLexical: 0,
      weightBm25: 0,
      weightImportance: 0,
      weightRecency: 0,
      weightL3Boost: 0,
      weightLongTermTierBoost: 0,
      weightMemoryCoreTierMultiplier: 0.7,
      weightTypedFactTierBoost: 0,
      recencyHalfLifeDays: 7,
      useFsrs: false,
      weightSemantic: 0,
      weightInformationGain: 0,
      weightGoalRelevance: 0,
      weightReliability: 0,
      weightSemanticEntropy: 0,
      weightValidity: 0,
    };
    const signals = {
      lexical: 0,
      bm25: 0,
      importance: 0,
      recency: 0,
      l3Boost: 0,
      semantic: 0,
      informationGain: 0.8,
      goalRelevance: 0,
      reliability: 0,
      semanticEntropy: 1.0,
      validity: 1.0,
    };
    expect(composite(signals, config)).toBe(0);
    expect(composite(signals, { ...config, weightInformationGain: 0.5 })).toBeCloseTo(0.4, 6);
  });

  it("l3Boost contributes via the ε weight", () => {
    const config = {
      weightLexical: 0,
      weightBm25: 0,
      weightImportance: 0,
      weightRecency: 0,
      weightL3Boost: 0.5,
      weightLongTermTierBoost: 0,
      weightMemoryCoreTierMultiplier: 0.7,
      weightTypedFactTierBoost: 0,
      recencyHalfLifeDays: 7,
      useFsrs: false,
      weightSemantic: 0,
      weightInformationGain: 0,
      weightGoalRelevance: 0,
      weightReliability: 0,
      weightSemanticEntropy: 0,
      weightValidity: 0,
    };
    const score = composite(
      {
        lexical: 0,
        bm25: 0,
        importance: 0,
        recency: 0,
        l3Boost: 0.4,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 0,
        semanticEntropy: 1.0,
        validity: 1.0,
      },
      config,
    );
    expect(score).toBeCloseTo(0.2, 6);
  });
});

describe("buildCorpusStats + BM25", () => {
  it("computes document frequencies from fact texts", () => {
    const stats = buildCorpusStats([
      "pi-hole at 192.168.50.128",
      "router is 192.168.50.1",
      "user likes coffee",
    ]);
    // "192.168.50.128" appears in 1 doc
    expect(stats.df.get("192.168.50.128")).toBe(1);
    // "192.168.50.1" appears in 1 doc (tokenized as one token)
    expect(stats.df.get("192.168.50.1")).toBe(1);
    // "at" appears in 1 doc
    expect(stats.df.get("at")).toBe(1);
    expect(stats.total).toBe(3);
    expect(stats.avgLen).toBeGreaterThan(0);
  });

  it("returns zeroed stats for empty corpus", () => {
    const stats = buildCorpusStats([]);
    expect(stats.total).toBe(0);
    expect(stats.avgLen).toBe(0);
    expect(stats.df.size).toBe(0);
  });

  it("gives rare terms higher BM25 score than common terms", () => {
    // Two facts: one with a rare IP, one with a common word.
    const stats = buildCorpusStats([
      "pi-hole at 192.168.50.128",
      "also at 192.168.50.128 is the dns",
      "user likes coffee",
      "user also likes tea",
      "user sometimes likes water",
    ]);
    const queryTokens = tokenize("192.168.50.128");
    const score = bm25Score(queryTokens, "pi-hole at 192.168.50.128", stats);
    expect(score).toBeGreaterThan(0);
  });

  it("BM25 signal is populated by default (weightBm25=0.3)", () => {
    const config = DEFAULT_SCORING_CONFIG;
    expect(config.weightBm25).toBe(0.3);
    const fact = {
      id: "f1",
      text: "pi-hole at 192.168.50.128",
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: "k:1",
    };
    const queryTokens = tokenize("192.168.50.128");
    const stats = buildCorpusStats([fact.text, "unrelated text about coffee"]);
    const signals = scoreFact({
      queryTokens,
      fact,
      now: Date.now(),
      config,
      corpusStats: stats,
    });
    expect(signals.bm25).toBeGreaterThan(0);
  });

  it("BM25 signal is 0 when weightBm25 is explicitly 0", () => {
    const config = { ...DEFAULT_SCORING_CONFIG, weightBm25: 0 };
    const fact = {
      id: "f1",
      text: "pi-hole at 192.168.50.128",
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: "k:1",
    };
    const queryTokens = tokenize("192.168.50.128");
    const stats = buildCorpusStats([fact.text]);
    const signals = scoreFact({
      queryTokens,
      fact,
      now: Date.now(),
      config,
      corpusStats: stats,
    });
    expect(signals.bm25).toBe(0);
  });

  it("BM25 signal is populated when weightBm25 > 0 and corpusStats provided", () => {
    const config = { ...DEFAULT_SCORING_CONFIG, weightBm25: 0.3 };
    const fact = {
      id: "f1",
      text: "pi-hole at 192.168.50.128",
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: "k:1",
    };
    const queryTokens = tokenize("192.168.50.128");
    const stats = buildCorpusStats([fact.text, "unrelated text about coffee"]);
    const signals = scoreFact({
      queryTokens,
      fact,
      now: Date.now(),
      config,
      corpusStats: stats,
    });
    expect(signals.bm25).toBeGreaterThan(0);
  });

  it("reliability defaults from fact certainty", () => {
    const config = DEFAULT_SCORING_CONFIG;
    const now = Date.now();
    const base = { id: "f1", text: "anything", importance: 0.5, createdAt: now, dedupKey: "k:1" };
    const confirmed = scoreFact({
      queryTokens: new Set(),
      fact: { ...base, certainty: "confirmed" },
      now,
      config,
    });
    const instructional = scoreFact({
      queryTokens: new Set(),
      fact: { ...base, certainty: "instructional" },
      now,
      config,
    });
    const tentative = scoreFact({
      queryTokens: new Set(),
      fact: { ...base, certainty: "tentative" },
      now,
      config,
    });
    const absent = scoreFact({ queryTokens: new Set(), fact: base, now, config });
    expect(confirmed.reliability).toBe(1.0);
    expect(instructional.reliability).toBe(0.85);
    expect(tentative.reliability).toBe(0.5);
    expect(absent.reliability).toBe(1.0);
  });

  it("goalRelevance and reliability can be overridden", () => {
    const config = DEFAULT_SCORING_CONFIG;
    const fact = {
      id: "f1",
      text: "anything",
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: "k:1",
      certainty: "tentative" as const,
    };
    const signals = scoreFact({
      queryTokens: new Set(),
      fact,
      now: Date.now(),
      config,
      goalRelevance: 0.9,
      reliability: 0.95,
    });
    expect(signals.goalRelevance).toBe(0.9);
    expect(signals.reliability).toBe(0.95);
  });

  it("groundingConfidence scales reliability signal", () => {
    const config = DEFAULT_SCORING_CONFIG;
    const fact = {
      id: "f1",
      text: "anything",
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: "k:1",
      certainty: "confirmed" as const,
    };
    const signals = scoreFact({
      queryTokens: new Set(),
      fact,
      now: Date.now(),
      config,
      groundingConfidence: 0.5,
    });
    expect(signals.reliability).toBe(0.5); // confirmed=1.0 * 0.5
  });

  it("groundingConfidence is ignored when absent", () => {
    const config = DEFAULT_SCORING_CONFIG;
    const fact = {
      id: "f1",
      text: "anything",
      importance: 0.5,
      createdAt: Date.now(),
      dedupKey: "k:1",
      certainty: "confirmed" as const,
    };
    const signals = scoreFact({
      queryTokens: new Set(),
      fact,
      now: Date.now(),
      config,
    });
    expect(signals.reliability).toBe(1.0);
  });

  it("composite includes goalRelevance and reliability", () => {
    const config = {
      weightLexical: 0,
      weightBm25: 0,
      weightImportance: 0,
      weightRecency: 0,
      weightL3Boost: 0,
      weightLongTermTierBoost: 0,
      weightMemoryCoreTierMultiplier: 0.7,
      weightTypedFactTierBoost: 0,
      recencyHalfLifeDays: 7,
      useFsrs: false,
      weightSemantic: 0,
      weightInformationGain: 0,
      weightGoalRelevance: 0.2,
      weightReliability: 0.3,
      weightSemanticEntropy: 0,
      weightValidity: 0,
    };
    const signals = {
      lexical: 0,
      bm25: 0,
      importance: 0,
      recency: 0,
      l3Boost: 0,
      semantic: 0,
      informationGain: 0,
      goalRelevance: 0.5,
      reliability: 0.8,
      semanticEntropy: 1.0,
      validity: 1.0,
    };
    expect(composite(signals, config)).toBeCloseTo(0.5 * 0.2 + 0.8 * 0.3, 6);
  });
});

describe("episodicValidity", () => {
  it("returns 1.0 for facts without eventTime (neutral)", () => {
    const fact = { id: "f1", text: "test", importance: 0.5, createdAt: 0, dedupKey: "k" };
    expect(episodicValidity(fact, Date.now())).toBe(1.0);
  });

  it("returns ~1.0 for very recent eventTime", () => {
    const now = Date.now();
    const fact = {
      id: "f1",
      text: "user is in Tokyo",
      importance: 0.5,
      createdAt: now,
      dedupKey: "k",
      eventTime: now - 1000, // 1 second ago
    };
    expect(episodicValidity(fact, now)).toBeCloseTo(1.0, 2);
  });

  it("returns ~0.5 for 90-day-old eventTime", () => {
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const fact = {
      id: "f1",
      text: "old event",
      importance: 0.5,
      createdAt: now - ninetyDaysMs,
      dedupKey: "k",
      eventTime: now - ninetyDaysMs,
    };
    expect(episodicValidity(fact, now)).toBeCloseTo(0.5, 1);
  });

  it("returns near-0 for very old eventTime", () => {
    const now = Date.now();
    const oneYearMs = 365 * 24 * 60 * 60 * 1000;
    const fact = {
      id: "f1",
      text: "ancient event",
      importance: 0.5,
      createdAt: now - oneYearMs,
      dedupKey: "k",
      eventTime: now - oneYearMs,
    };
    const v = episodicValidity(fact, now);
    expect(v).toBeLessThan(0.1);
    expect(v).toBeGreaterThan(0);
  });

  it("contributes to composite score via weightValidity", () => {
    const config = {
      weightLexical: 0,
      weightBm25: 0,
      weightImportance: 0,
      weightRecency: 0,
      weightL3Boost: 0,
      weightLongTermTierBoost: 0,
      weightMemoryCoreTierMultiplier: 0.7,
      weightTypedFactTierBoost: 0,
      recencyHalfLifeDays: 7,
      useFsrs: false,
      weightSemantic: 0,
      weightInformationGain: 0,
      weightGoalRelevance: 0,
      weightReliability: 0,
      weightSemanticEntropy: 0,
      weightValidity: 0.5,
    };
    const now = Date.now();
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const staleFact = {
      id: "f1",
      text: "stale",
      importance: 0.5,
      createdAt: now - ninetyDaysMs,
      dedupKey: "k",
      eventTime: now - ninetyDaysMs,
    };
    const freshFact = {
      id: "f2",
      text: "fresh",
      importance: 0.5,
      createdAt: now,
      dedupKey: "k2",
      eventTime: now,
    };
    const staleScore = scoreFact({
      queryTokens: new Set(["test"]),
      fact: staleFact,
      now,
      config,
    });
    const freshScore = scoreFact({
      queryTokens: new Set(["test"]),
      fact: freshFact,
      now,
      config,
    });
    expect(composite(freshScore, config)).toBeGreaterThan(composite(staleScore, config));
  });
});

describe("volatilityMultiplier", () => {
  it("returns 1.0 for semi-volatile (default)", () => {
    expect(volatilityMultiplier("semi-volatile")).toBe(1.0);
  });

  it("returns 0.3 for stable facts", () => {
    expect(volatilityMultiplier("stable")).toBe(0.3);
  });

  it("returns 2.5 for volatile facts", () => {
    expect(volatilityMultiplier("volatile")).toBe(2.5);
  });

  it("returns 1.0 for null/undefined (backward compat)", () => {
    expect(volatilityMultiplier(null)).toBe(1.0);
    expect(volatilityMultiplier(undefined)).toBe(1.0);
  });

  it("returns 1.0 for unknown class", () => {
    expect(volatilityMultiplier("unknown-class")).toBe(1.0);
  });

  it("uses custom FsrsParams multipliers", () => {
    const custom = {
      ...DEFAULT_FSRS_PARAMS,
      volatilityMultipliers: { stable: 0.1, volatile: 5.0, "semi-volatile": 1.5 },
    };
    expect(volatilityMultiplier("stable", custom)).toBe(0.1);
    expect(volatilityMultiplier("volatile", custom)).toBe(5.0);
    expect(volatilityMultiplier("semi-volatile", custom)).toBe(1.5);
  });
});

describe("fsrsRetrievability with volatility class", () => {
  const halfLifeDays = 7;
  const DAY = 24 * 60 * 60 * 1000;

  it("stable facts decay slower than semi-volatile", () => {
    const ageMs = halfLifeDays * DAY;
    const stable = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      volatilityClass: "stable",
    });
    const semi = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      volatilityClass: "semi-volatile",
    });
    expect(stable).toBeGreaterThan(semi);
  });

  it("volatile facts decay faster than semi-volatile", () => {
    const ageMs = halfLifeDays * DAY;
    const volatileR = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      volatilityClass: "volatile",
    });
    const semi = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      volatilityClass: "semi-volatile",
    });
    expect(volatileR).toBeLessThan(semi);
  });

  it("missing volatilityClass defaults to semi-volatile (backward compat)", () => {
    const ageMs = halfLifeDays * DAY;
    const without = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
    });
    const semi = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      volatilityClass: "semi-volatile",
    });
    expect(without).toBe(semi);
  });

  it("volatile facts reach near-zero faster", () => {
    const ageMs = 30 * DAY;
    const volatileR = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      volatilityClass: "volatile",
    });
    expect(volatileR).toBeLessThan(0.1);
  });
});

describe("fsrsRetrievability with drift demotion", () => {
  const halfLifeDays = 7;
  const DAY = 24 * 60 * 60 * 1000;

  it("defaults to neutral (1.0) when driftDemotion is absent", () => {
    const ageMs = halfLifeDays * DAY;
    const without = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
    });
    const withNeutral = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      driftDemotion: 1.0,
    });
    expect(without).toBe(withNeutral);
  });

  it("driftDemotion > 1.0 accelerates forgetting", () => {
    const ageMs = halfLifeDays * DAY;
    const demoted = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      driftDemotion: 1.5,
    });
    const neutral = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      driftDemotion: 1.0,
    });
    expect(demoted).toBeLessThan(neutral);
  });

  it("driftDemotion composes with volatility class", () => {
    const ageMs = halfLifeDays * DAY;
    // A volatile + drift-demoted fact should decay faster than either alone
    const both = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      volatilityClass: "volatile",
      driftDemotion: 1.5,
    });
    const volatileOnly = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      volatilityClass: "volatile",
    });
    const driftOnly = fsrsRetrievability({
      ageMs,
      recallCount: 1,
      halfLifeDays,
      driftDemotion: 1.5,
    });
    expect(both).toBeLessThan(volatileOnly);
    expect(both).toBeLessThan(driftOnly);
  });
});

describe("scoreFact with drift demotion", () => {
  it("driftDemotion reduces recency signal for old facts", () => {
    const config = DEFAULT_SCORING_CONFIG;
    const ageMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    const fact = {
      id: "f1",
      text: "old intent fact",
      importance: 0.5,
      createdAt: Date.now() - ageMs,
      dedupKey: "k:1",
    };
    const queryTokens = new Set<string>();
    const neutral = scoreFact({
      queryTokens,
      fact,
      now: Date.now(),
      config,
      recallCount: 2,
    });
    const demoted = scoreFact({
      queryTokens,
      fact,
      now: Date.now(),
      config,
      recallCount: 2,
      driftDemotion: 2.0,
    });
    expect(demoted.recency).toBeLessThan(neutral.recency);
  });

  it("driftDemotion has no effect when useFsrs is false", () => {
    const config = { ...DEFAULT_SCORING_CONFIG, useFsrs: false };
    const fact = {
      id: "f1",
      text: "test",
      importance: 0.5,
      createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000,
      dedupKey: "k:1",
    };
    const queryTokens = new Set<string>();
    const neutral = scoreFact({
      queryTokens,
      fact,
      now: Date.now(),
      config,
      recallCount: 2,
    });
    const demoted = scoreFact({
      queryTokens,
      fact,
      now: Date.now(),
      config,
      recallCount: 2,
      driftDemotion: 2.0,
    });
    expect(demoted.recency).toBe(neutral.recency);
  });
});

describe("staleDemotionMultiplier", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("returns 1.0 when recallCount > 0", () => {
    expect(
      staleDemotionMultiplier({
        recallCount: 1,
        ageMs: 999 * DAY,
        config: DEFAULT_SCORING_CONFIG,
      }),
    ).toBe(1.0);
  });

  it("returns 1.0 when age is below threshold", () => {
    expect(
      staleDemotionMultiplier({
        recallCount: 0,
        ageMs: 10 * DAY, // below default 21-day threshold
        config: DEFAULT_SCORING_CONFIG,
      }),
    ).toBe(1.0);
  });

  it("returns the demotion factor when recallCount=0 and age >= threshold", () => {
    expect(
      staleDemotionMultiplier({
        recallCount: 0,
        ageMs: 21 * DAY,
        config: DEFAULT_SCORING_CONFIG,
      }),
    ).toBe(0.5);
  });

  it("returns 1.0 when demotion factor is 1.0 (disabled)", () => {
    const config = { ...DEFAULT_SCORING_CONFIG, staleZeroRecallDemotion: 1.0 };
    expect(
      staleDemotionMultiplier({
        recallCount: 0,
        ageMs: 999 * DAY,
        config,
      }),
    ).toBe(1.0);
  });

  it("respects custom threshold", () => {
    const config = { ...DEFAULT_SCORING_CONFIG, staleZeroRecallAgeDays: 5 };
    // Below custom threshold
    expect(
      staleDemotionMultiplier({
        recallCount: 0,
        ageMs: 4 * DAY,
        config,
      }),
    ).toBe(1.0);
    // At custom threshold
    expect(
      staleDemotionMultiplier({
        recallCount: 0,
        ageMs: 5 * DAY,
        config,
      }),
    ).toBe(0.5);
  });

  it("respects custom demotion factor", () => {
    const config = { ...DEFAULT_SCORING_CONFIG, staleZeroRecallDemotion: 0.3 };
    expect(
      staleDemotionMultiplier({
        recallCount: 0,
        ageMs: 30 * DAY,
        config,
      }),
    ).toBe(0.3);
  });

  it("clamps negative age to 0 (treats as fresh)", () => {
    expect(
      staleDemotionMultiplier({
        recallCount: 0,
        ageMs: -1000,
        config: DEFAULT_SCORING_CONFIG,
      }),
    ).toBe(1.0);
  });

  it("demotes a fact that is well past the threshold", () => {
    expect(
      staleDemotionMultiplier({
        recallCount: 0,
        ageMs: 90 * DAY, // 90 days old, never recalled
        config: DEFAULT_SCORING_CONFIG,
      }),
    ).toBe(0.5);
  });
});
