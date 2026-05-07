import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMemorySection, retrieveTopK } from "./retrieval.js";
import { Storage } from "./storage.js";
import type { L2ChunkFrontmatter } from "./types.js";

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
): Promise<void> => {
  await storage.writeL2Chunk(
    {
      id: chunkId,
      agentId: "j-rorqual",
      startTurnIndex: 0,
      endTurnIndex: 1,
      createdAt,
      facts,
      dedupKeys: facts.map((f) => f.dedupKey),
    },
    "",
  );
};

describe("retrieveTopK", () => {
  it("returns [] when no chunks exist", async () => {
    const result = await retrieveTopK({ query: "anything", storage, topK: 5 });
    expect(result).toEqual([]);
  });

  it("returns [] for an empty query", async () => {
    await writeChunk("chunk-1", [
      { id: "f1", text: "morning standups", importance: 0.5, createdAt: NOW, dedupKey: "k:1" },
    ]);
    expect(await retrieveTopK({ query: "", storage, topK: 5 })).toEqual([]);
  });

  it("returns [] when topK is 0", async () => {
    await writeChunk("chunk-1", [
      { id: "f1", text: "morning standups", importance: 0.5, createdAt: NOW, dedupKey: "k:1" },
    ]);
    expect(await retrieveTopK({ query: "morning", storage, topK: 0 })).toEqual([]);
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
    const result = await retrieveTopK({
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
    const result = await retrieveTopK({ query: "morning", storage, topK: 2, now: NOW });
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
    const result = await retrieveTopK({ query: "morning task", storage, topK: 2, now: NOW });
    expect(result[0].fact.id).toBe("new");
  });

  it("attaches signals so callers can debug ranking", async () => {
    await writeChunk("chunk-1", [
      { id: "f1", text: "morning standup", importance: 0.7, createdAt: NOW, dedupKey: "k:1" },
    ]);
    const result = await retrieveTopK({ query: "morning", storage, topK: 1, now: NOW });
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
    const result = await retrieveTopK({
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
        signals: { lexical: 1, importance: 0.7, recency: 1, l3Boost: 0 },
        chunkId: "chunk-1",
      },
    ]);
    expect(result).toContain("## Memory (hierarchical-l3)");
    expect(result).toContain("[0.85] morning standups preferred");
  });
});
