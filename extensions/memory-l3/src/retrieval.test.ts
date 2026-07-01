import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMemorySection, retrieveTopK } from "./retrieval.js";
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
    expect(result[0].fact.id).toBe("f-match");
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
    expect(result[0].fact.id).toBe("new");
  });

  it("attaches signals so callers can debug ranking", async () => {
    await writeChunk("chunk-1", [
      { id: "f1", text: "morning standup", importance: 0.7, createdAt: NOW, dedupKey: "k:1" },
    ]);
    const { facts: result } = await retrieveTopK({ query: "morning", storage, topK: 1, now: NOW });
    expect(result[0].signals.lexical).toBeGreaterThan(0);
    expect(result[0].signals.importance).toBe(0.7);
    expect(result[0].signals.recency).toBeCloseTo(1, 4);
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
    expect(result[fNewIdx].signals.l3Boost).toBeGreaterThan(0);
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
    expect(result[0].tier).toBe("longterm");
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
    expect(result[0].tier).toBe("typed");
    expect(result[0].fact.id).toBe("tf-phone");
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
        },
        chunkId: "chunk-1",
        tier: "typed",
      },
    ]);
    expect(result).toContain("■ [0.78] user:phone = 555-1234");
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
            archived: false,
            archivedAt: null,
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

  it("renders longterm-typed hits with the ★ marker", () => {
    const result = formatMemorySection([
      {
        fact: {
          id: "ltt-1",
          text: "user:phone = 555-1234",
          importance: 0.95,
          createdAt: NOW,
          dedupKey: "user:phone",
        },
        score: 0.82,
        signals: {
          lexical: 0.5,
          bm25: 0,
          importance: 0.95,
          recency: 1,
          l3Boost: 0,
          semantic: 0,
          informationGain: 0,
        },
        chunkId: "longterm-typed",
        tier: "longterm-typed",
      },
    ]);
    expect(result).toContain("★ [0.82] user:phone = 555-1234");
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
    expect(result[0].tier).toBe("l2");
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
    expect(result[0].tier).toBe("l2");
    expect(result[0].contextWindow).toBe(5);
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
