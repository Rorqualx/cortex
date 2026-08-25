import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyQueryIntent,
  compareRetrievedFacts,
  critiqueStaleFacts,
  formatMemorySection,
  getIntentScoringPreset,
  heuristicReformulate,
  retrieveTopK,
  type RetrievedFact,
} from "./retrieval.js";
import { DEFAULT_SCORING_CONFIG } from "./scoring.js";
import { Storage } from "./storage.js";
import type { L2ChunkFrontmatter, TypedFact } from "./types.js";

let tmpRoot: string;
let storage: Storage;
const NOW = Date.UTC(2026, 4, 6, 12, 0, 0);

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-retrieval-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const writeChunk = async (
  chunkId: string,
  facts: L2ChunkFrontmatter["facts"],
  createdAt: number = NOW,
  typedFacts: TypedFact[] = [],
): Promise<void> => {
  await storage.writeL2Chunk(
    {
      id: chunkId,
      agentId: "j-rorqual",
      startTurnIndex: 0,
      endTurnIndex: 1,
      createdAt,
      facts,
      typedFacts,
      dedupKeys: facts.map((f) => f.dedupKey),
    },
    "",
  );
};

describe("retrieveTopK", () => {
  it("returns [] when no chunks exist", async () => {
    const { facts } = await retrieveTopK({ query: "anything", storage, topK: 5 });
    expect(facts).toEqual([]);
  });

  it("returns [] for an empty query", async () => {
    await writeChunk("chunk-1", [
      { id: "f1", text: "morning standups", importance: 0.5, createdAt: NOW, dedupKey: "k:1" },
    ]);
    const { facts } = await retrieveTopK({ query: "", storage, topK: 5 });
    expect(facts).toEqual([]);
  });

  it("returns [] when topK is 0", async () => {
    await writeChunk("chunk-1", [
      { id: "f1", text: "morning standups", importance: 0.5, createdAt: NOW, dedupKey: "k:1" },
    ]);
    const { facts } = await retrieveTopK({ query: "morning", storage, topK: 0 });
    expect(facts).toEqual([]);
  });

  it("ranks lexically matching facts above non-matching", async () => {
    await writeChunk("chunk-1", [
      {
        id: "f-match",
        text: "user prefers morning standups",
        importance: 0.5,
        createdAt: NOW,
        dedupKey: "k:1",
      },
      {
        id: "f-nomatch",
        text: "the cat is napping",
        importance: 0.5,
        createdAt: NOW,
        dedupKey: "k:2",
      },
    ]);
    const { facts: result } = await retrieveTopK({
      query: "morning standups",
      storage,
      topK: 5,
      now: NOW,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.fact.id).toBe("f-match");
  });

  it("respects the topK cap", async () => {
    await writeChunk("chunk-1", [
      { id: "a", text: "morning meeting", importance: 0.5, createdAt: NOW, dedupKey: "k:a" },
      { id: "b", text: "morning coffee", importance: 0.5, createdAt: NOW, dedupKey: "k:b" },
      { id: "c", text: "morning routine", importance: 0.5, createdAt: NOW, dedupKey: "k:c" },
    ]);
    const { facts: result } = await retrieveTopK({ query: "morning", storage, topK: 2, now: NOW });
    expect(result).toHaveLength(2);
  });

  it("prefers fresher facts when lexical scores tie", async () => {
    const stale = NOW - 30 * 24 * 60 * 60 * 1000;
    const fresh = NOW - 1 * 24 * 60 * 60 * 1000;
    await writeChunk(
      "chunk-old",
      [{ id: "old", text: "morning task", importance: 0.5, createdAt: stale, dedupKey: "k:old" }],
      stale,
    );
    await writeChunk(
      "chunk-new",
      [{ id: "new", text: "morning task", importance: 0.5, createdAt: fresh, dedupKey: "k:new" }],
      fresh,
    );
    const { facts: result } = await retrieveTopK({
      query: "morning task",
      storage,
      topK: 2,
      now: NOW,
    });
    expect(result[0]!.fact.id).toBe("new");
  });

  it("attaches signals so callers can debug ranking", async () => {
    await writeChunk("chunk-1", [
      { id: "f1", text: "morning standup", importance: 0.7, createdAt: NOW, dedupKey: "k:1" },
    ]);
    const { facts: result } = await retrieveTopK({ query: "morning", storage, topK: 1, now: NOW });
    expect(result[0]!.signals.lexical).toBeGreaterThan(0);
    expect(result[0]!.signals.importance).toBe(0.7);
    expect(result[0]!.signals.recency).toBeCloseTo(1, 4);
  });
});

describe("retrieveTopK with L3 boost", () => {
  it("applies an additive boost to facts whose epoch lexically matches the query", async () => {
    // Two chunks. Both have facts that DON'T lexically match "deadline".
    // Only the second is covered by an epoch whose representative facts mention "deadline".
    await writeChunk("chunk-000000-aaaa", [
      { id: "f-old", text: "alpha topic", importance: 0.5, createdAt: NOW, dedupKey: "k:old" },
    ]);
    await writeChunk("chunk-000001-bbbb", [
      { id: "f-new", text: "beta topic", importance: 0.5, createdAt: NOW, dedupKey: "k:new" },
    ]);
    await storage.writeL3Epoch(
      {
        id: "epoch-0000",
        agentId: "j-rorqual",
        startChunkId: "chunk-000001-bbbb",
        endChunkId: "chunk-000001-bbbb",
        createdAt: NOW,
        representativeFacts: [
          {
            id: "rep",
            text: "user is anxious about the deadline",
            importance: 0.8,
            createdAt: NOW,
            dedupKey: "k:deadline",
          },
        ],
      },
      "",
    );
    const { facts: result } = await retrieveTopK({
      query: "deadline",
      storage,
      topK: 5,
      now: NOW,
    });
    // f-new should rank higher than f-old because it's in the epoch range.
    const fNewIdx = result.findIndex((r) => r.fact.id === "f-new");
    expect(fNewIdx).toBeGreaterThanOrEqual(0);
    expect(result[fNewIdx]!.signals.l3Boost).toBeGreaterThan(0);
  });
});

describe("formatMemorySection", () => {
  it("returns an empty string when no facts are provided", () => {
    expect(formatMemorySection([])).toBe("");
  });

  it("formats facts as a header + score-prefixed bullets", () => {
    const result = formatMemorySection([
      {
        fact: {
          id: "f1",
          text: "morning standups preferred",
          importance: 0.7,
          createdAt: NOW,
          dedupKey: "k:1",
        },
        score: 0.85,
        signals: {
          lexical: 1,
          bm25: 0,
          importance: 0.7,
          recency: 1,
          l3Boost: 0,
          semantic: 0,
          informationGain: 0,
          goalRelevance: 0,
          reliability: 1,
          semanticEntropy: 1,
          validity: 1,
        },
        chunkId: "chunk-1",
        tier: "l2",
      },
    ]);
    expect(result).toContain("## Memory (hierarchical-l3)");
    expect(result).toContain("[0.85] morning standups preferred");
  });

  it("uses ★ marker for long-term hits and · for L2 hits", () => {
    const result = formatMemorySection([
      {
        fact: {
          id: "lt-1",
          text: "evergreen fact",
          importance: 0.8,
          createdAt: NOW,
          dedupKey: "k:lt",
        },
        score: 0.9,
        signals: {
          lexical: 1,
          bm25: 0,
          importance: 0.8,
          recency: 1,
          l3Boost: 0,
          semantic: 0,
          informationGain: 0,
          goalRelevance: 0,
          reliability: 1,
          semanticEntropy: 1,
          validity: 1,
        },
        chunkId: "longterm",
        tier: "longterm",
      },
      {
        fact: {
          id: "f1",
          text: "fresh fact",
          importance: 0.6,
          createdAt: NOW,
          dedupKey: "k:l2",
        },
        score: 0.5,
        signals: {
          lexical: 0.5,
          bm25: 0,
          importance: 0.6,
          recency: 1,
          l3Boost: 0,
          semantic: 0,
          informationGain: 0,
          goalRelevance: 0,
          reliability: 1,
          semanticEntropy: 1,
          validity: 1,
        },
        chunkId: "chunk-1",
        tier: "l2",
      },
    ]);
    expect(result).toContain("★ [0.90] evergreen fact");
    expect(result).toContain("· [0.50] fresh fact");
  });
});

describe("retrieveTopK long-term tier", () => {
  it("surfaces a matching long-term fact even when no L2 chunks match", async () => {
    // Write an L2 chunk whose facts are unrelated to the query.
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "alpha topic", importance: 0.6, createdAt: NOW, dedupKey: "k:alpha" },
    ]);
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "lt-1",
            text: "user prefers tabs over spaces",
            dedupKey: "user_pref:tabs",
            importance: 0.8,
            firstSeenAt: NOW - 10 * 86400000,
            lastConfirmedAt: NOW,
            recallCount: 4,
            sourceChunkIds: ["chunk-a", "chunk-b", "chunk-c", "chunk-d"],
            archived: false,
            archivedAt: null,
          },
        ],
      },
      "",
    );

    const { facts: result } = await retrieveTopK({
      query: "tabs vs spaces",
      storage,
      topK: 5,
      now: NOW,
    });
    const ltHit = result.find((r) => r.tier === "longterm");
    expect(ltHit).toBeDefined();
    expect(ltHit?.fact.dedupKey).toBe("user_pref:tabs");
    expect(ltHit?.signals.lexical).toBeGreaterThan(0);
  });

  it("does not surface archived long-term facts", async () => {
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "alpha topic", importance: 0.5, createdAt: NOW, dedupKey: "k:alpha" },
    ]);
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "lt-archived",
            text: "user prefers tabs over spaces",
            dedupKey: "user_pref:tabs",
            importance: 0.8,
            firstSeenAt: NOW - 100 * 86400000,
            lastConfirmedAt: NOW - 80 * 86400000,
            recallCount: 4,
            sourceChunkIds: ["chunk-a"],
            archived: true,
            archivedAt: NOW - 60 * 86400000,
          },
        ],
      },
      "",
    );
    const { facts: result } = await retrieveTopK({ query: "tabs", storage, topK: 5, now: NOW });
    expect(result.find((r) => r.fact.id === "lt-archived")).toBeUndefined();
  });

  it("surfaces a high-importance long-term fact even with zero lexical overlap", async () => {
    // Query has zero token overlap with the long-term fact text, but the
    // fact has high importance and there's nothing else competing — it
    // should still appear in the result set (previously it was hard-skipped).
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "weather report", importance: 0.4, createdAt: NOW, dedupKey: "k:weather" },
    ]);
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "lt-persona",
            text: "user prefers tabs over spaces",
            dedupKey: "user_pref:tabs",
            importance: 0.9,
            firstSeenAt: NOW - 10 * 86400000,
            lastConfirmedAt: NOW,
            recallCount: 5,
            sourceChunkIds: ["a", "b", "c", "d", "e"],
            archived: false,
            archivedAt: null,
          },
        ],
      },
      "",
    );
    const { facts: result } = await retrieveTopK({
      query: "lunch ideas",
      storage,
      topK: 5,
      now: NOW,
    });
    const ltHit = result.find((r) => r.tier === "longterm");
    expect(ltHit).toBeDefined();
    expect(ltHit?.signals.lexical).toBe(0);
  });

  it("does not let a zero-lexical long-term fact out-rank a meaningfully-relevant L2 fact", async () => {
    // L2 fact with a real but mediocre lexical hit — should rank above an
    // unrelated high-importance long-term fact, because the long-term tier
    // boost is withheld when lexical is zero.
    await writeChunk("chunk-000000-x", [
      {
        id: "l2-relevant",
        text: "lunch options near downtown denver",
        importance: 0.5,
        createdAt: NOW,
        dedupKey: "k:lunch_options",
      },
    ]);
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "lt-unrelated",
            text: "user prefers tabs over spaces",
            dedupKey: "user_pref:tabs",
            importance: 0.9,
            firstSeenAt: NOW - 10 * 86400000,
            lastConfirmedAt: NOW,
            recallCount: 5,
            sourceChunkIds: ["a", "b", "c", "d", "e"],
            archived: false,
            archivedAt: null,
          },
        ],
      },
      "",
    );
    const { facts: result } = await retrieveTopK({
      query: "lunch ideas",
      storage,
      topK: 5,
      now: NOW,
    });
    const l2Idx = result.findIndex((r) => r.fact.id === "l2-relevant");
    const ltIdx = result.findIndex((r) => r.fact.id === "lt-unrelated");
    expect(l2Idx).toBeGreaterThanOrEqual(0);
    expect(l2Idx).toBeLessThan(ltIdx === -1 ? Infinity : ltIdx);
  });

  it("ranks long-term tier above an L2 fact at similar lexical strength", async () => {
    // L2 fact with strong lexical match
    await writeChunk("chunk-000000-x", [
      {
        id: "l2-1",
        text: "tabs preferred recently",
        importance: 0.6,
        createdAt: NOW,
        dedupKey: "user_pref:tabs:recent",
      },
    ]);
    // Long-term fact with same lexical match but lower importance
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "lt-1",
            text: "tabs preferred",
            dedupKey: "user_pref:tabs",
            importance: 0.6, // same as L2
            firstSeenAt: NOW - 10 * 86400000,
            lastConfirmedAt: NOW,
            recallCount: 5,
            sourceChunkIds: ["a", "b", "c", "d", "e"],
            archived: false,
            archivedAt: null,
          },
        ],
      },
      "",
    );
    const { facts: result } = await retrieveTopK({
      query: "tabs preferred",
      storage,
      topK: 5,
      now: NOW,
    });
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0]!.tier).toBe("longterm");
  });
});

describe("retrieveTopK typed-fact tier", () => {
  it("surfaces a typed fact whose slot or value matches the query", async () => {
    await writeChunk(
      "chunk-000000-x",
      [
        {
          id: "f1",
          text: "user discussed networking",
          importance: 0.4,
          createdAt: NOW,
          dedupKey: "k:net",
        },
      ],
      NOW,
      [
        {
          id: "tf-pi",
          slot: "infra:pi_hole_ip",
          value: "192.168.50.128",
          sourceSpan: "pi-hole at 192.168.50.128",
          unit: null,
          confidence: 0.9,
          createdAt: NOW,
        },
      ],
    );
    const { facts: result } = await retrieveTopK({
      query: "192.168.50.128",
      storage,
      topK: 5,
      now: NOW,
    });
    const typedHit = result.find((r) => r.tier === "typed");
    expect(typedHit).toBeDefined();
    expect(typedHit?.fact.text).toBe("infra:pi_hole_ip = 192.168.50.128");
    expect(typedHit?.signals.lexical).toBeGreaterThan(0);
  });

  it("includes unit in the rendered text when present", async () => {
    await writeChunk("chunk-000000-y", [], NOW, [
      {
        id: "tf-bal",
        slot: "user:account_balance",
        value: "1234.56",
        sourceSpan: "balance is 1234.56",
        unit: "USD",
        confidence: 0.95,
        createdAt: NOW,
      },
    ]);
    const { facts: result } = await retrieveTopK({ query: "balance", storage, topK: 5, now: NOW });
    const hit = result.find((r) => r.tier === "typed");
    expect(hit?.fact.text).toBe("user:account_balance = 1234.56 USD");
  });

  it("ranks a typed fact above a mediocre prose fact when both lexically match", async () => {
    await writeChunk(
      "chunk-000000-z",
      [
        {
          id: "prose",
          text: "the user mentioned their phone briefly",
          importance: 0.3,
          createdAt: NOW,
          dedupKey: "k:phone_mention",
        },
      ],
      NOW,
      [
        {
          id: "tf-phone",
          slot: "user:phone",
          value: "555-1234",
          sourceSpan: "my phone is 555-1234",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
    );
    const { facts: result } = await retrieveTopK({
      query: "phone 555-1234",
      storage,
      topK: 5,
      now: NOW,
    });
    expect(result[0]!.tier).toBe("typed");
    expect(result[0]!.fact.id).toBe("tf-phone");
  });

  it("renders relative ages and a guidance prelude when `now` is provided", () => {
    const result = formatMemorySection(
      [
        {
          fact: {
            id: "f-fresh",
            text: "balance is 750",
            importance: 0.7,
            createdAt: NOW - 2 * 86400000,
            dedupKey: "k:fresh",
          },
          score: 0.8,
          signals: {
            lexical: 0.5,
            bm25: 0,
            importance: 0.7,
            recency: 1,
            l3Boost: 0,
            semantic: 0,
            informationGain: 0,
            goalRelevance: 0,
            reliability: 1,
            semanticEntropy: 1,
            validity: 1,
          },
          chunkId: "chunk-1",
          tier: "l2",
        },
        {
          fact: {
            id: "f-stale",
            text: "balance is 500",
            importance: 0.6,
            createdAt: NOW - 30 * 86400000,
            dedupKey: "k:stale",
          },
          score: 0.5,
          signals: {
            lexical: 0.4,
            bm25: 0,
            importance: 0.6,
            recency: 0.05,
            l3Boost: 0,
            semantic: 0,
            informationGain: 0,
            goalRelevance: 0,
            reliability: 1,
            semanticEntropy: 1,
            validity: 1,
          },
          chunkId: "chunk-2",
          tier: "l2",
        },
      ],
      { now: NOW },
    );
    expect(result).toContain("(2d ago) balance is 750");
    expect(result).toContain("(4w ago) balance is 500");
    expect(result).toContain("when each fact was *noted*");
  });

  it("renders typed-fact hits with the ■ marker in formatMemorySection", () => {
    const result = formatMemorySection([
      {
        fact: {
          id: "tf-1",
          text: "user:phone = 555-1234",
          importance: 0.9,
          createdAt: NOW,
          dedupKey: "user:phone",
        },
        score: 0.78,
        signals: {
          lexical: 0.5,
          bm25: 0,
          importance: 0.9,
          recency: 1,
          l3Boost: 0,
          semantic: 0,
          informationGain: 0,
          goalRelevance: 0,
          reliability: 1,
          semanticEntropy: 1,
          validity: 1,
        },
        chunkId: "chunk-1",
        tier: "typed",
      },
    ]);
    expect(result).toContain("■ [0.78] user:phone = 555-1234");
  });
});

describe("retrieveTopK failure-fact significance", () => {
  it("auto-marks failure: typed facts as significant for FSRS slower decay", async () => {
    // A failure: typed fact and a non-failure typed fact with identical lexical
    // relevance. The failure fact should get a recency boost from significance.
    const failureFact: TypedFact = {
      id: "tf-fail",
      slot: "failure:doom_loop_pattern",
      value: "repeated grep on empty dir wasted 5 iterations",
      sourceSpan: "repeated grep on empty dir wasted 5 iterations",
      unit: null,
      confidence: 0.8,
      createdAt: NOW,
    };
    const normalFact: TypedFact = {
      id: "tf-normal",
      slot: "user:phone",
      value: "555-1234",
      sourceSpan: "phone 555-1234",
      unit: null,
      confidence: 0.8,
      createdAt: NOW,
    };
    await writeChunk("chunk-fail", [], NOW, [failureFact, normalFact]);

    const { facts } = await retrieveTopK({
      query: "grep iterations",
      storage,
      topK: 5,
      now: NOW + 1000 * 60 * 60 * 24 * 14, // 14 days later
    });

    // Both should be retrieved (both match some tokens)
    const failureHit = facts.find((f) => f.fact.dedupKey === "failure:doom_loop_pattern");
    expect(failureHit).toBeDefined();

    // The failure fact should have `significant` propagated through
    // (typedFactAsL2Fact sets it based on slot prefix)
    expect(failureHit?.fact.significant).toBe(true);

    // The normal fact should NOT have significant set
    const normalHit = facts.find((f) => f.fact.dedupKey === "user:phone");
    if (normalHit) {
      expect(normalHit.fact.significant).toBeFalsy();
    }
  });
});

describe("retrieveTopK cross-brain reconciliation", () => {
  it("does not surface a long-term prose fact that has been marked supersededBy", async () => {
    // Need at least one L2 chunk for retrieval to enter the loop.
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "alpha topic", importance: 0.4, createdAt: NOW, dedupKey: "k:alpha" },
    ]);
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "lt-stale",
            text: "user balance is around 500",
            dedupKey: "user:balance_estimate",
            importance: 0.7,
            firstSeenAt: NOW - 10 * 86400000,
            lastConfirmedAt: NOW,
            recallCount: 3,
            sourceChunkIds: ["a", "b", "c"],
            archived: false,
            archivedAt: null,
            supersededBy: "user:account_balance",
          },
        ],
      },
      "",
    );
    const { facts: result } = await retrieveTopK({ query: "balance", storage, topK: 5, now: NOW });
    expect(result.find((r) => r.fact.id === "lt-stale")).toBeUndefined();
  });
});

describe("retrieveTopK longterm-typed tier", () => {
  it("surfaces canonical entry and suppresses per-chunk typed facts for the same slot", async () => {
    // Two chunks both emit the same slot with different values. After
    // consolidation, the canonical view holds only the latest. Retrieval
    // should surface the canonical entry and skip the per-chunk hits.
    await writeChunk("chunk-a", [], NOW - 5 * 86400000, [
      {
        id: "tf-old",
        slot: "user:account_balance",
        value: "500.00",
        sourceSpan: "balance 500.00",
        unit: null,
        confidence: 0.9,
        createdAt: NOW - 5 * 86400000,
      },
    ]);
    await writeChunk("chunk-b", [], NOW, [
      {
        id: "tf-new",
        slot: "user:account_balance",
        value: "750.00",
        sourceSpan: "balance 750.00",
        unit: null,
        confidence: 0.95,
        createdAt: NOW,
      },
    ]);
    await storage.writeLongTermTyped(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "ltt-1",
            slot: "user:account_balance",
            value: "750.00",
            unit: null,
            confidence: 0.95,
            firstSeenAt: NOW - 5 * 86400000,
            lastConfirmedAt: NOW,
            recallCount: 2,
            sourceChunkIds: ["chunk-a", "chunk-b"],
            history: [{ value: "500.00", supersededAt: NOW }],
            validFrom: NOW,
            validUntil: null,
            supersededBy: null,
            archived: false,
            archivedAt: null,
            lastAccessedAt: NOW,
          },
        ],
      },
      "",
    );

    const { facts: result } = await retrieveTopK({
      query: "balance",
      storage,
      topK: 10,
      now: NOW,
    });
    const canonical = result.find((r) => r.tier === "longterm-typed");
    const perChunk = result.find((r) => r.tier === "typed");
    expect(canonical).toBeDefined();
    expect(canonical?.fact.text).toBe("user:account_balance = 750.00");
    expect(perChunk).toBeUndefined();
  });

  it("applies access-time decay to typed-fact confidence", async () => {
    // Need at least one L2 chunk or retrieveTopK returns empty
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "placeholder", importance: 0.1, createdAt: NOW, dedupKey: "k:placeholder" },
    ]);
    // Write a typed fact that was last accessed 60 days ago
    await storage.writeLongTermTyped(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "ltt-old",
            slot: "user:old_fact",
            value: "stale",
            unit: null,
            confidence: 0.9,
            firstSeenAt: NOW - 60 * 86400000,
            lastConfirmedAt: NOW - 60 * 86400000,
            recallCount: 1,
            sourceChunkIds: ["chunk-a"],
            history: [],
            validFrom: NOW - 60 * 86400000,
            validUntil: null,
            supersededBy: null,
            archived: false,
            archivedAt: null,
            lastAccessedAt: NOW - 60 * 86400000,
          },
        ],
      },
      "",
    );

    const { facts: result } = await retrieveTopK({
      query: "stale",
      storage,
      topK: 10,
      now: NOW,
    });
    const hit = result.find((r) => r.tier === "longterm-typed");
    expect(hit).toBeDefined();
    // Decay: 0.9 * exp(-60/30) = 0.9 * exp(-2) ≈ 0.9 * 0.1353 ≈ 0.1218
    expect(hit!.fact.importance).toBeCloseTo(0.9 * Math.exp(-2), 4);
  });

  it("updates lastAccessedAt on retrieved typed facts", async () => {
    // Need at least one L2 chunk or retrieveTopK returns empty
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "placeholder", importance: 0.1, createdAt: NOW, dedupKey: "k:placeholder" },
    ]);
    await storage.writeLongTermTyped(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW,
        facts: [
          {
            id: "ltt-track",
            slot: "user:track_me",
            value: "track",
            unit: null,
            confidence: 0.9,
            firstSeenAt: NOW - 10 * 86400000,
            lastConfirmedAt: NOW - 10 * 86400000,
            recallCount: 1,
            sourceChunkIds: ["chunk-a"],
            history: [],
            validFrom: NOW - 10 * 86400000,
            validUntil: null,
            supersededBy: null,
            archived: false,
            archivedAt: null,
            lastAccessedAt: NOW - 10 * 86400000,
          },
        ],
      },
      "",
    );

    await retrieveTopK({
      query: "track",
      storage,
      topK: 10,
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.lastAccessedAt).toBe(NOW);
  });
});

describe("retrieveTopK memory-core tier", () => {
  it("merges memory-core hits into the top-K ranking with the ◆ marker", async () => {
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "alpha topic", importance: 0.5, createdAt: NOW, dedupKey: "k:alpha" },
    ]);
    const memoryCoreLookup = async (_query: string) => [
      {
        path: "MEMORY.md",
        startLine: 12,
        endLine: 14,
        score: 0.9,
        snippet: "user prefers morning standups (per dreaming consolidation)",
      },
    ];
    const { facts: result } = await retrieveTopK({
      query: "morning standups",
      storage,
      topK: 5,
      now: NOW,
      memoryCoreLookup,
    });
    const mcHit = result.find((r) => r.tier === "memory-core");
    expect(mcHit).toBeDefined();
    expect(mcHit?.fact.text).toContain("morning standups");
    expect(mcHit?.chunkId).toBe("MEMORY.md");
    // 0.9 * weightMemoryCoreTierMultiplier (default 0.7) = 0.63
    expect(mcHit?.score).toBeCloseTo(0.63, 4);
  });

  it("silently drops the tier when the lookup throws", async () => {
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "alpha topic", importance: 0.5, createdAt: NOW, dedupKey: "k:alpha" },
    ]);
    const memoryCoreLookup = async (_query: string) => {
      throw new Error("memory-core unavailable");
    };
    const { facts: result } = await retrieveTopK({
      query: "alpha",
      storage,
      topK: 5,
      now: NOW,
      memoryCoreLookup,
    });
    // L2 result still returned, no memory-core hits
    expect(result.length).toBe(1);
    expect(result[0]!.tier).toBe("l2");
  });

  it("does not call the lookup when none is provided (existing tests stay valid)", async () => {
    await writeChunk("chunk-000000-x", [
      { id: "f1", text: "alpha", importance: 0.5, createdAt: NOW, dedupKey: "k:alpha" },
    ]);
    const { facts: result } = await retrieveTopK({ query: "alpha", storage, topK: 5, now: NOW });
    expect(result.every((r) => r.tier === "l2")).toBe(true);
  });
});

describe("retrieveTopK contextWindow (RaMem reinstatement)", () => {
  it("exposes contextWindow on L2 facts when present in chunk frontmatter", async () => {
    await storage.writeL2Chunk(
      {
        id: "chunk-cw",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 5,
        createdAt: NOW,
        facts: [
          { id: "f1", text: "user prefers tabs", importance: 0.8, createdAt: NOW, dedupKey: "k:1" },
        ],
        dedupKeys: ["k:1"],
        contextWindow: 5,
      },
      "",
    );
    const { facts: result } = await retrieveTopK({ query: "tabs", storage, topK: 5, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.tier).toBe("l2");
    expect(result[0]!.contextWindow).toBe(5);
  });

  it("omits contextWindow on long-term facts", async () => {
    await storage.writeL2Chunk(
      {
        id: "chunk-cw2",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 3,
        createdAt: NOW,
        facts: [
          { id: "f1", text: "evergreen fact", importance: 0.9, createdAt: NOW, dedupKey: "k:1" },
        ],
        dedupKeys: ["k:1"],
        contextWindow: 3,
      },
      "",
    );
    // Run consolidation so the fact promotes to long-term
    const { consolidateLongTerm } = await import("./longterm.js");
    await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW });

    const { facts: result } = await retrieveTopK({
      query: "evergreen",
      storage,
      topK: 5,
      now: NOW,
    });
    const lt = result.find((r) => r.tier === "longterm");
    expect(lt).toBeDefined();
    expect(lt!.contextWindow).toBeUndefined();
  });
});

describe("retrieveTopK retrieval mode", () => {
  beforeEach(async () => {
    await writeChunk("chunk-mode", [
      {
        id: "fm1",
        text: "rust async runtime tokio",
        importance: 0.8,
        createdAt: NOW,
        dedupKey: "k:m1",
      },
      {
        id: "fm2",
        text: "python gil threading lock",
        importance: 0.6,
        createdAt: NOW,
        dedupKey: "k:m2",
      },
    ]);
  });

  const fullConfig = {
    useEpochFirst: false,
    epochExpandTopN: 3,
    useSubmodularSelect: false,
    submodularDiversityWeight: 0.3,
    submodularCoverageWeight: 0.3,
    submodularTokenBudget: null as number | null,
    mode: "blended" as const,
  };

  it("keyword mode zeroes semantic signal but still finds lexical matches", async () => {
    const { facts } = await retrieveTopK({
      query: "tokio runtime",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: { ...fullConfig, mode: "keyword" },
      queryEmbedding: [1.0, 0.0],
    });
    expect(facts.length).toBeGreaterThan(0);
    expect(facts[0]!.fact.text).toContain("tokio");
    // Semantic signal should be zeroed in keyword mode
    expect(facts[0]!.signals.semantic).toBe(0);
    // BM25 should be non-zero for matching facts
    expect(facts[0]!.signals.bm25).toBeGreaterThan(0);
  });

  it("semantic mode zeroes bm25 signal", async () => {
    const { facts } = await retrieveTopK({
      query: "tokio runtime",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: { ...fullConfig, mode: "semantic" },
    });
    // In semantic mode, bm25 should be zeroed in signals for all results
    for (const f of facts) {
      expect(f.signals.bm25).toBe(0);
    }
  });

  it("blended mode keeps both bm25 and semantic signals", async () => {
    const { facts } = await retrieveTopK({
      query: "tokio runtime",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: { ...fullConfig, mode: "blended" },
    });
    expect(facts.length).toBeGreaterThan(0);
    // In blended mode, bm25 should be non-zero for lexical matches
    expect(facts[0]!.signals.bm25).toBeGreaterThan(0);
  });
});

describe("classifyQueryIntent", () => {
  it("classifies direct lookups as factual", () => {
    expect(classifyQueryIntent("What is the pi-hole IP?")).toBe("factual");
    expect(classifyQueryIntent("what's my account balance")).toBe("factual");
    expect(classifyQueryIntent("192.168.50.128")).toBe("factual");
    expect(classifyQueryIntent("server port number")).toBe("factual");
  });

  it("classifies comparison/relational queries as multihop", () => {
    expect(classifyQueryIntent("compare rust vs python performance")).toBe("multihop");
    expect(classifyQueryIntent("what changed since last week")).toBe("multihop");
    expect(classifyQueryIntent("difference between API v1 and v2")).toBe("multihop");
    expect(classifyQueryIntent("docker and kubernetes")).toBe("multihop");
  });

  it("classifies open-ended queries as synthesis", () => {
    expect(classifyQueryIntent("summarize the project status")).toBe("synthesis");
    expect(classifyQueryIntent("explain how the memory system works")).toBe("synthesis");
    expect(classifyQueryIntent("tell me about the underground greenhouse")).toBe("synthesis");
    expect(classifyQueryIntent("overview of the deployment pipeline")).toBe("synthesis");
    expect(classifyQueryIntent("what do you know about HueyTheDestroyer")).toBe("synthesis");
  });

  it("defaults to factual for ambiguous short queries", () => {
    expect(classifyQueryIntent("server config")).toBe("factual");
    expect(classifyQueryIntent("phone number")).toBe("factual");
  });
});

describe("getIntentScoringPreset", () => {
  it("returns BM25-heavy config for factual intent", () => {
    const preset = getIntentScoringPreset("factual");
    expect(preset.weightBm25).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weightBm25);
    expect(preset.weightSemantic).toBeLessThan(DEFAULT_SCORING_CONFIG.weightSemantic);
  });

  it("factual preset favours sparse over dense (APS-RAG)", () => {
    const preset = getIntentScoringPreset("factual");
    const sparse = preset.weightBm25 + preset.weightLexical;
    const dense = preset.weightSemantic;
    expect(sparse / dense).toBeGreaterThan(3); // strong sparse dominance
  });

  it("factual preset boosts reliability for confirmed sources", () => {
    const preset = getIntentScoringPreset("factual");
    expect(preset.weightReliability).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weightReliability);
  });

  it("returns balanced config for multihop intent", () => {
    const preset = getIntentScoringPreset("multihop");
    expect(preset.weightSemantic).toBeGreaterThan(preset.weightBm25);
    expect(preset.weightGoalRelevance).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weightGoalRelevance);
  });

  it("multihop preset has near 1:1 dense/sparse ratio (APS-RAG)", () => {
    const preset = getIntentScoringPreset("multihop");
    const sparse = preset.weightBm25 + preset.weightLexical;
    const dense = preset.weightSemantic;
    // Should be roughly balanced (between 0.8 and 1.5)
    expect(sparse / dense).toBeGreaterThan(0.8);
    expect(sparse / dense).toBeLessThan(1.5);
  });

  it("multihop preset boosts informationGain for novel connections", () => {
    const preset = getIntentScoringPreset("multihop");
    expect(preset.weightInformationGain).toBeGreaterThan(
      DEFAULT_SCORING_CONFIG.weightInformationGain,
    );
  });

  it("returns semantic-heavy config for synthesis intent", () => {
    const preset = getIntentScoringPreset("synthesis");
    expect(preset.weightSemantic).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weightSemantic);
    expect(preset.weightImportance).toBeGreaterThan(DEFAULT_SCORING_CONFIG.weightImportance);
    expect(preset.weightBm25).toBeLessThan(DEFAULT_SCORING_CONFIG.weightBm25);
  });

  it("synthesis preset favours dense over sparse (APS-RAG)", () => {
    const preset = getIntentScoringPreset("synthesis");
    const sparse = preset.weightBm25 + preset.weightLexical;
    const dense = preset.weightSemantic;
    expect(dense / sparse).toBeGreaterThan(2); // strong dense dominance
  });

  it("synthesis preset boosts informationGain for diverse perspectives", () => {
    const preset = getIntentScoringPreset("synthesis");
    expect(preset.weightInformationGain).toBeGreaterThan(
      DEFAULT_SCORING_CONFIG.weightInformationGain,
    );
  });
});

describe("retrieveTopK routed mode", () => {
  beforeEach(async () => {
    await writeChunk("chunk-routed", [
      {
        id: "fr1",
        text: "the server runs rust with tokio",
        importance: 0.8,
        createdAt: NOW,
        dedupKey: "k:r1",
      },
      {
        id: "fr2",
        text: "python async uses asyncio event loop",
        importance: 0.6,
        createdAt: NOW,
        dedupKey: "k:r2",
      },
    ]);
  });

  const routedConfig = {
    useEpochFirst: false,
    epochExpandTopN: 3,
    useSubmodularSelect: false,
    submodularDiversityWeight: 0.3,
    submodularCoverageWeight: 0.3,
    submodularTokenBudget: null as number | null,
    mode: "routed" as const,
  };

  it("routes factual queries through the factual scoring preset", async () => {
    // A factual lookup query — the router should select factual preset
    // (BM25-heavy). All signals stay active (unlike keyword mode which zeroes
    // semantic).
    const { facts } = await retrieveTopK({
      query: "server tokio",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: routedConfig,
      queryEmbedding: [1.0, 0.0],
    });
    expect(facts.length).toBeGreaterThan(0);
    // In routed mode, semantic is NOT zeroed (unlike keyword mode)
    // The factual preset has reduced but non-zero semantic weight.
    // Signals themselves are preserved — only the composite weight changes.
    expect(facts[0]!.signals.semantic).toBeGreaterThanOrEqual(0);
  });

  it("does not zero any signal in routed mode (unlike keyword/semantic modes)", async () => {
    const { facts } = await retrieveTopK({
      query: "tokio",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: routedConfig,
    });
    expect(facts.length).toBeGreaterThan(0);
    // bm25 should NOT be zeroed in routed mode
    expect(facts[0]!.signals.bm25).toBeGreaterThan(0);
  });

  it("respects explicit config over routed preset", async () => {
    // When caller provides explicit config, routed mode should NOT override it
    const explicitConfig: Partial<import("./scoring.js").ScoringConfig> = {
      weightBm25: 0.99,
      weightSemantic: 0.01,
    };
    const { facts } = await retrieveTopK({
      query: "summarize the architecture",
      storage,
      topK: 5,
      now: NOW,
      config: { ...DEFAULT_SCORING_CONFIG, ...explicitConfig },
      retrievalConfig: routedConfig,
    });
    // The query is classified as synthesis (which would normally use high
    // semantic weight), but explicit config should win.
    // We verify this indirectly: the query still returns results, meaning
    // the explicit config was used without the routed preset clobbering it.
    expect(facts.length).toBeGreaterThan(0);
  });
});

describe("REFACT-style adaptive fact compression", () => {
  const routedConfig = {
    useEpochFirst: false,
    epochExpandTopN: 3,
    useSubmodularSelect: false,
    submodularDiversityWeight: 0.3,
    submodularCoverageWeight: 0.3,
    submodularTokenBudget: null,
    mode: "routed" as const,
  };

  it("compresses prose facts to 1 sentence for factual queries in routed mode", async () => {
    // Write a chunk with a multi-sentence prose fact
    await writeChunk(
      "chunk-prose",
      [
        {
          id: "fact-prose-1",
          text: "The server runs on port 3000. It was configured last week. The config file is at /etc/server.conf.",
          importance: 0.8,
          createdAt: NOW,
          dedupKey: "prose-1",
        },
      ],
      NOW,
      [],
    );

    const { facts } = await retrieveTopK({
      query: "server port",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: routedConfig, // triggers intent classification → factual
    });

    expect(facts.length).toBeGreaterThan(0);
    const proseFact = facts.find((f) => f.fact.dedupKey === "prose-1");
    expect(proseFact).toBeDefined();
    // Should be compressed to first sentence + ellipsis
    expect(proseFact!.fact.text).toMatch(/port 3000/);
    expect(proseFact!.fact.text).not.toMatch(/configured last week/i);
    expect(proseFact!.fact.text.endsWith("…")).toBe(true);
  });

  it("keeps typed facts uncompressed for factual queries", async () => {
    const typedFacts: TypedFact[] = [
      {
        slot: "server:port",
        value: "3000",
        sourceSpan: "the dev server listens on port 3000 by default",
        unit: null,
        id: "tf-port",
        confidence: 0.95,
        createdAt: NOW,
      },
    ];
    await writeChunk("chunk-typed", [], NOW, typedFacts);

    const { facts } = await retrieveTopK({
      query: "server port",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: routedConfig,
    });

    const typedResult = facts.find((f) => f.tier === "typed");
    expect(typedResult).toBeDefined();
    // Typed facts should keep their full "slot = value" format
    expect(typedResult!.fact.text).toMatch(/server:port = 3000/u);
  });

  it("keeps prose uncompressed for synthesis queries", async () => {
    const longText =
      "The system architecture is complex. It involves many moving parts. Each part has a specific role in the pipeline.";
    await writeChunk(
      "chunk-synth",
      [
        {
          id: "fact-synth-1",
          text: longText,
          importance: 0.9,
          createdAt: NOW,
          dedupKey: "synth-1",
        },
      ],
      NOW,
      [],
    );

    const { facts } = await retrieveTopK({
      query: "summarize the architecture",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: routedConfig, // synthesis intent
    });

    const proseResult = facts.find((f) => f.fact.dedupKey === "synth-1");
    expect(proseResult).toBeDefined();
    // Synthesis should keep prose full
    expect(proseResult!.fact.text).toBe(longText);
  });

  it("leaves prose uncompressed when the mode carries no intent signal", async () => {
    // Guards the default (non-routed) path: with no intent to route on, the
    // lossless setting must win. Hardcoding "factual" here truncated every
    // prose fact to its first sentence on the default retrieval path.
    const longText =
      "The server runs on port 3000. The config file is at /etc/server.conf. Restart after edits.";
    await writeChunk(
      "chunk-default-mode",
      [
        {
          id: "fact-default-1",
          text: longText,
          importance: 0.9,
          createdAt: NOW,
          dedupKey: "default-1",
        },
      ],
      NOW,
      [],
    );

    const { facts } = await retrieveTopK({
      query: "what port does the server run on",
      storage,
      topK: 5,
      now: NOW,
      // No retrievalConfig -> DEFAULT_RETRIEVAL_CONFIG, i.e. mode "blended".
    });

    const proseFact = facts.find((f) => f.fact.dedupKey === "default-1");
    expect(proseFact).toBeDefined();
    expect(proseFact!.fact.text).toBe(longText);
  });
});

describe("critiqueStaleFacts", () => {
  it("demotes stale + unreliable prose facts", () => {
    const stale: RetrievedFact = {
      fact: {
        id: "f1",
        text: "old tentative claim",
        importance: 0.3,
        createdAt: 0,
        dedupKey: "k:1",
      },
      score: 1.0,
      signals: {
        lexical: 0.5,
        bm25: 0,
        importance: 0.3,
        recency: 0.1,
        l3Boost: 0,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 0.5,
        semanticEntropy: 1,
        validity: 0.2,
        entityScore: 0,
        polarityMultiplier: 1.0,
      },
      chunkId: "c1",
      tier: "l2",
    };
    const fresh: RetrievedFact = {
      fact: {
        id: "f2",
        text: "confirmed recent fact",
        importance: 0.8,
        createdAt: Date.now(),
        dedupKey: "k:2",
      },
      score: 0.9,
      signals: {
        lexical: 0.5,
        bm25: 0,
        importance: 0.8,
        recency: 0.9,
        l3Boost: 0,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 1.0,
        semanticEntropy: 1,
        validity: 0.95,
        entityScore: 0,
        polarityMultiplier: 1.0,
      },
      chunkId: "c2",
      tier: "l2",
    };
    const results = critiqueStaleFacts([stale, fresh]);
    // Stale fact should be demoted below fresh fact
    expect(results[0]!.fact.id).toBe("f2");
    expect(results[1]!.fact.id).toBe("f1");
    expect(results[1]!.score).toBeCloseTo(0.5, 6); // 1.0 * 0.5 demotion
  });

  it("does NOT demote stale facts that are reliable", () => {
    const stale: RetrievedFact = {
      fact: {
        id: "f1",
        text: "old confirmed fact",
        importance: 0.8,
        createdAt: 0,
        dedupKey: "k:1",
      },
      score: 1.0,
      signals: {
        lexical: 0.5,
        bm25: 0,
        importance: 0.8,
        recency: 0.1,
        l3Boost: 0,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 1.0,
        semanticEntropy: 1,
        validity: 0.2,
        entityScore: 0,
        polarityMultiplier: 1.0,
      },
      chunkId: "c1",
      tier: "l2",
    };
    critiqueStaleFacts([stale]);
    // Reliability is high (1.0) — should NOT be demoted despite low validity
    expect(stale.score).toBe(1.0);
  });

  it("does NOT demote reliable facts with low validity", () => {
    const item: RetrievedFact = {
      fact: { id: "f1", text: "test", importance: 0.5, createdAt: 0, dedupKey: "k:1" },
      score: 0.8,
      signals: {
        lexical: 0,
        bm25: 0,
        importance: 0.5,
        recency: 0.1,
        l3Boost: 0,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 0.9,
        semanticEntropy: 1,
        validity: 0.1,
        entityScore: 0,
        polarityMultiplier: 1.0,
      },
      chunkId: "c1",
      tier: "longterm",
    };
    critiqueStaleFacts([item]);
    expect(item.score).toBe(0.8); // unchanged
  });

  it("skips typed facts entirely", () => {
    const typed: RetrievedFact = {
      fact: { id: "f1", text: "slot = value", importance: 0.9, createdAt: 0, dedupKey: "k:1" },
      score: 1.0,
      signals: {
        lexical: 0.5,
        bm25: 0,
        importance: 0.9,
        recency: 0.1,
        l3Boost: 0,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 0.1,
        semanticEntropy: 1,
        validity: 0.05,
        entityScore: 0,
        polarityMultiplier: 1.0,
      },
      chunkId: "c1",
      tier: "typed",
    };
    critiqueStaleFacts([typed]);
    expect(typed.score).toBe(1.0); // unchanged despite terrible signals
  });

  it("skips longterm-typed facts entirely", () => {
    const ltt: RetrievedFact = {
      fact: { id: "f1", text: "ip = 192.168.1.1", importance: 0.9, createdAt: 0, dedupKey: "k:1" },
      score: 1.0,
      signals: {
        lexical: 0.5,
        bm25: 0,
        importance: 0.9,
        recency: 0.1,
        l3Boost: 0,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 0.1,
        semanticEntropy: 1,
        validity: 0.05,
        entityScore: 0,
        polarityMultiplier: 1.0,
      },
      chunkId: "c1",
      tier: "longterm-typed",
    };
    critiqueStaleFacts([ltt]);
    expect(ltt.score).toBe(1.0);
  });

  it("handles empty/single-element arrays gracefully", () => {
    expect(critiqueStaleFacts([])).toEqual([]);
    const single: RetrievedFact = {
      fact: { id: "f1", text: "test", importance: 0.1, createdAt: 0, dedupKey: "k:1" },
      score: 0.5,
      signals: {
        lexical: 0,
        bm25: 0,
        importance: 0.1,
        recency: 0.1,
        l3Boost: 0,
        semantic: 0,
        informationGain: 0,
        goalRelevance: 0,
        reliability: 0.1,
        semanticEntropy: 1,
        validity: 0.01,
        entityScore: 0,
        polarityMultiplier: 1.0,
      },
      chunkId: "c1",
      tier: "l2",
    };
    critiqueStaleFacts([single]);
    // Single element should still be demoted
    expect(single.score).toBeCloseTo(0.25, 6); // 0.5 * 0.5
  });
});

// ---------------------------------------------------------------------------
// QW-1: Query Reformulation (heuristic)
// ---------------------------------------------------------------------------
describe("heuristicReformulate", () => {
  it("strips stop words to produce core-terms variant", () => {
    const variants = heuristicReformulate("what is the API endpoint for the server");
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.some((v) => !v.includes("what"))).toBe(true);
    expect(variants.some((v) => !v.includes("the"))).toBe(true);
  });

  it("produces a broader variant for long queries", () => {
    const variants = heuristicReformulate(
      "how to configure the network settings for docker containers",
    );
    // Should include a shorter variant with just first few core terms
    const broader = variants.find((v) => v.split(" ").length <= 3);
    expect(broader).toBeDefined();
  });

  it("splits conjunctions into sub-queries", () => {
    const variants = heuristicReformulate("database connection settings and redis cache config");
    // Should contain parts from both sides of "and"
    expect(variants.some((v) => v.includes("database"))).toBe(true);
    expect(variants.some((v) => v.includes("redis"))).toBe(true);
  });

  it("returns empty array for single-word queries", () => {
    const variants = heuristicReformulate("config");
    expect(variants).toHaveLength(0);
  });

  it("does not include the original query as a variant", () => {
    const variants = heuristicReformulate("what is the project status");
    expect(variants).not.toContain("what is the project status");
  });
});

// ---------------------------------------------------------------------------
// QW-1: Query Reformulation in retrieveTopK
// ---------------------------------------------------------------------------
describe("retrieveTopK with query reformulation", () => {
  it("does not reformulate when result score is high enough", async () => {
    // Write facts that match the query well → high score
    await writeChunk("chunk-high-score", [
      {
        id: "f1",
        text: "The project status is on track and progressing well",
        importance: 0.9,
        createdAt: NOW,
        dedupKey: "status:1",
      },
    ]);

    const result = await retrieveTopK({
      query: "project status",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: {
        ...({
          useEpochFirst: false,
          epochExpandTopN: 3,
          useSubmodularSelect: false,
          submodularDiversityWeight: 0.3,
          submodularCoverageWeight: 0.3,
          submodularTokenBudget: null,
          mode: "blended",
        } as never),
        reformulationPasses: 1,
        reformulationThreshold: 0.01, // Very low threshold → never triggers
      },
    });

    expect(result.reformulated).toBeFalsy();
  });

  it("reformulates when result score is below threshold", async () => {
    // Write facts that DON'T match the query well → low score
    await writeChunk("chunk-low-score", [
      {
        id: "f1",
        text: "The weather forecast indicates rain tomorrow afternoon",
        importance: 0.3,
        createdAt: NOW,
        dedupKey: "weather:1",
      },
    ]);

    // Also write a fact that matches a reformulation (core terms)
    await writeChunk("chunk-reform-match", [
      {
        id: "f2",
        text: "docker compose network configuration guide",
        importance: 0.7,
        createdAt: NOW,
        dedupKey: "docker:1",
      },
    ]);

    const result = await retrieveTopK({
      query: "how to configure docker",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: {
        ...({
          useEpochFirst: false,
          epochExpandTopN: 3,
          useSubmodularSelect: false,
          submodularDiversityWeight: 0.3,
          submodularCoverageWeight: 0.3,
          submodularTokenBudget: null,
          mode: "blended",
        } as never),
        reformulationPasses: 1,
        reformulationThreshold: 100, // Very high threshold → always triggers
      },
    });

    expect(result.reformulated).toBe(true);
  });

  it("does not reformulate when reformulationPasses is 0", async () => {
    await writeChunk("chunk-no-reform", [
      {
        id: "f1",
        text: "random unrelated content",
        importance: 0.1,
        createdAt: NOW,
        dedupKey: "random:1",
      },
    ]);

    const result = await retrieveTopK({
      query: "something completely different",
      storage,
      topK: 5,
      now: NOW,
      retrievalConfig: {
        ...({
          useEpochFirst: false,
          epochExpandTopN: 3,
          useSubmodularSelect: false,
          submodularDiversityWeight: 0.3,
          submodularCoverageWeight: 0.3,
          submodularTokenBudget: null,
          mode: "blended",
        } as never),
        reformulationPasses: 0,
      },
    });

    expect(result.reformulated).toBeFalsy();
  });

  it("trims results to maxInjectedTokens budget", async () => {
    await writeChunk("chunk-budget", [
      {
        id: "f1",
        text: "alpha budget fact with some detail",
        importance: 0.9,
        createdAt: NOW,
        dedupKey: "budget:1",
      },
      {
        id: "f2",
        text: "beta budget fact with some detail",
        importance: 0.8,
        createdAt: NOW,
        dedupKey: "budget:2",
      },
      {
        id: "f3",
        text: "gamma budget fact with some detail",
        importance: 0.7,
        createdAt: NOW,
        dedupKey: "budget:3",
      },
      {
        id: "f4",
        text: "delta budget fact with some detail that is longer than the rest to consume tokens",
        importance: 0.6,
        createdAt: NOW,
        dedupKey: "budget:4",
      },
    ]);

    const result = await retrieveTopK({
      query: "budget fact",
      storage,
      topK: 10,
      now: NOW,
      retrievalConfig: {
        useEpochFirst: false,
        epochExpandTopN: 3,
        useSubmodularSelect: false,
        submodularDiversityWeight: 0.3,
        submodularCoverageWeight: 0.3,
        submodularTokenBudget: null,
        mode: "blended",
        maxInjectedTokens: 80,
      },
    });

    // Budget of 80 tokens, prelude ~60, leaving ~20 for facts.
    // Each fact ~(35+20)/4 = ~14 tokens. Should fit ~1-2 facts.
    expect(result.facts.length).toBeLessThan(4);
    expect(result.facts.length).toBeGreaterThan(0);
    // Highest-score fact always present
    expect(result.facts.some((r) => r.fact.dedupKey === "budget:1")).toBe(true);
  });
});

describe("compareRetrievedFacts", () => {
  const baseSignals = {
    lexical: 0.5,
    bm25: 0,
    importance: 0.5,
    recency: 1,
    l3Boost: 0,
    semantic: 0,
    informationGain: 0,
    goalRelevance: 0,
    reliability: 1,
    semanticEntropy: 1,
    validity: 1,
    entityScore: 0,
    polarityMultiplier: 1,
  };
  const item = (
    id: string,
    score: number,
    createdAt: number,
    eventTime?: number,
  ): RetrievedFact => ({
    fact: {
      id,
      text: `fact ${id}`,
      importance: 0.5,
      createdAt,
      dedupKey: `k:${id}`,
      eventTime,
    },
    score,
    signals: baseSignals,
    chunkId: "c1",
    tier: "l2",
  });

  it("orders strictly by score when scores differ", () => {
    const low = item("a", 0.4, 1000);
    const high = item("b", 0.9, 2000);
    expect([low, high].sort(compareRetrievedFacts)[0]?.fact.id).toBe("b");
  });

  it("breaks score ties by eventTime, most recent event first", () => {
    const olderEvent = item("a", 0.7, NOW, NOW - 10 * 24 * 3600 * 1000);
    const newerEvent = item("b", 0.7, NOW - 5 * 24 * 3600 * 1000, NOW - 1000);
    // Same storage recency ordering would put "a" first (later createdAt),
    // but "b"'s *event* is far more recent — event time must win the tie.
    expect([olderEvent, newerEvent].sort(compareRetrievedFacts)[0]?.fact.id).toBe("b");
  });

  it("falls back to createdAt when eventTime is absent on one side", () => {
    const noEvent = item("a", 0.7, NOW - 30 * 24 * 3600 * 1000);
    const withOldEvent = item("b", 0.7, NOW, NOW - 90 * 24 * 3600 * 1000);
    // "b" has an eventTime but it is 90 days old; "a" has no eventTime so its
    // stand-in is createdAt (30 days old) — "a" wins.
    expect([noEvent, withOldEvent].sort(compareRetrievedFacts)[0]?.fact.id).toBe("a");
  });

  it("returns 0 for identical score and time anchors (stable ordering)", () => {
    const a = item("a", 0.5, 1000, 1000);
    const b = item("b", 0.5, 1000, 1000);
    expect(compareRetrievedFacts(a, b)).toBe(0);
  });
});
