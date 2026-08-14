// Lexical L1-archive search tests: keyword matching, session-aware rank
// fusion, temporal + session filtering, and graceful behavior on malformed
// archive lines. Seeded via Storage's real appendL1Archive / writeL2Chunk.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTimeBound, searchL1Archive } from "./insights-search.js";
import { Storage } from "./storage.js";
import type { L2ChunkFrontmatter } from "./types.js";

const NOW = Date.parse("2026-08-01T12:00:00Z");

function chunkFrontmatter(overrides: Partial<L2ChunkFrontmatter> & { id: string }) {
  return {
    agentId: null,
    startTurnIndex: 0,
    endTurnIndex: 2,
    createdAt: NOW,
    facts: [],
    dedupKeys: [],
    ...overrides,
  } satisfies L2ChunkFrontmatter;
}

describe("searchL1Archive", () => {
  let root: string;
  let storage: Storage;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-l3-insights-search-"));
    storage = new Storage(root);
    await storage.ensureLayout();
  });

  afterEach(async () => {
    storage.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("returns no matches for an empty archive", async () => {
    const result = await searchL1Archive({ storage, query: "pihole", now: NOW });
    expect(result.scanned).toEqual({ chunks: 0, messages: 0 });
    expect(result.matches).toEqual([]);
  });

  it("finds keyword matches across chunks and reports counts", async () => {
    await storage.appendL1Archive("chunk-1", {
      role: "user",
      content: "the pihole is at 192.168.50.128",
    });
    await storage.appendL1Archive("chunk-1", {
      role: "assistant",
      content: "noted the dns address",
    });
    await storage.appendL1Archive("chunk-2", { role: "user", content: "whats for dinner" });

    const result = await searchL1Archive({ storage, query: "pihole dns", now: NOW });
    expect(result.scanned.chunks).toBe(2);
    expect(result.scanned.messages).toBe(3);
    expect(result.matchedChunks).toBe(1);
    // Both terms hit inside chunk-1 ("pihole" and "dns"); the dinner message stays out.
    expect(result.matches).toHaveLength(2);
    expect(new Set(result.matches.map((m) => m.chunkId))).toEqual(new Set(["chunk-1"]));
    expect(result.matches[0]!.text).toContain("pihole");
  });

  it("ranks a session-corroborated message above an isolated identical hit", async () => {
    // chunk-a: three messages all about "greenhouse insulation"
    for (const text of [
      "greenhouse insulation plan",
      "buy greenhouse insulation boards",
      "greenhouse insulation cost estimate",
    ]) {
      await storage.appendL1Archive("chunk-a", { role: "user", content: text });
    }
    // chunk-b: a single message with the same keyword density, no corroboration
    await storage.appendL1Archive("chunk-b", {
      role: "user",
      content: "greenhouse insulation plan",
    });

    const result = await searchL1Archive({ storage, query: "greenhouse insulation", now: NOW });
    expect(result.matches).toHaveLength(4);
    expect(result.matches[0]!.chunkId).toBe("chunk-a");
    expect(result.matches[0]!.score).toBeGreaterThan(
      result.matches.find((m) => m.chunkId === "chunk-b")!.score,
    );
  });

  it("filters by since/until using message timestamps, falling back to chunk createdAt", async () => {
    const T0 = Date.parse("2026-07-01T00:00:00Z");
    await storage.appendL1Archive("chunk-old", {
      role: "user",
      content: "old greenhouse note",
      timestamp: T0,
    });
    await storage.appendL1Archive("chunk-new", {
      role: "user",
      content: "new greenhouse note",
      timestamp: NOW,
    });

    const since = await searchL1Archive({
      storage,
      query: "greenhouse",
      since: NOW - 1000,
      now: NOW,
    });
    expect(since.matches.map((m) => m.chunkId)).toEqual(["chunk-new"]);

    const until = await searchL1Archive({
      storage,
      query: "greenhouse",
      until: T0 + 1000,
      now: NOW,
    });
    expect(until.matches.map((m) => m.chunkId)).toEqual(["chunk-old"]);
  });

  it("filters by sessionId from the message record", async () => {
    await storage.appendL1Archive("chunk-1", {
      role: "user",
      content: "greenhouse drainage",
      sessionId: "sess-a",
    });
    await storage.appendL1Archive("chunk-2", {
      role: "user",
      content: "greenhouse drainage",
      sessionId: "sess-b",
    });

    const result = await searchL1Archive({
      storage,
      query: "greenhouse drainage",
      sessionId: "sess-b",
      now: NOW,
    });
    expect(result.sessionId).toBe("sess-b");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.chunkId).toBe("chunk-2");
    expect(result.matches[0]!.sessionId).toBe("sess-b");
  });

  it("resolves sessionId and createdAt from chunk typed-fact lineage", async () => {
    const createdAt = Date.parse("2026-07-15T00:00:00Z");
    await storage.writeL2Chunk(
      chunkFrontmatter({
        id: "chunk-lineage",
        createdAt,
        typedFacts: [
          {
            id: "tf-1",
            slot: "infra:pihole_ip",
            value: "192.168.50.128",
            sourceSpan: "pihole at 192.168.50.128",
            unit: null,
            confidence: 0.9,
            createdAt,
            sessionId: "sess-lineage",
          },
        ],
      }),
      "body",
    );
    // Archived message has NO timestamp and NO sessionId — lineage fills both.
    await storage.appendL1Archive("chunk-lineage", {
      role: "user",
      content: "pihole address note",
    });

    const filtered = await searchL1Archive({
      storage,
      query: "pihole",
      sessionId: "sess-lineage",
      now: NOW,
    });
    expect(filtered.matches).toHaveLength(1);
    expect(filtered.matches[0]!.sessionId).toBe("sess-lineage");
    expect(filtered.matches[0]!.createdAt).toBe(createdAt);

    // Temporal filter uses the chunk createdAt fallback for timestamp-less records.
    const early = await searchL1Archive({
      storage,
      query: "pihole",
      until: createdAt - 1,
      now: NOW,
    });
    expect(early.matches).toEqual([]);
  });

  it("skips malformed JSONL lines without failing the scan", async () => {
    const target = path.join(root, "l1_archive", "chunk-bad.jsonl");
    await fsp.writeFile(target, '{"role":"user","content":"greenhouse note"}\n{broken\n', "utf8");
    const result = await searchL1Archive({ storage, query: "greenhouse", now: NOW });
    expect(result.matches).toHaveLength(1);
    expect(result.scanned.messages).toBe(1);
  });

  it("returns empty matches for stopword-only queries", async () => {
    await storage.appendL1Archive("chunk-1", { role: "user", content: "the and of to" });
    const result = await searchL1Archive({ storage, query: "the and of", now: NOW });
    expect(result.matches).toEqual([]);
    expect(result.matchedChunks).toBe(0);
  });

  it("clips long matched text and honors limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await storage.appendL1Archive(`chunk-${i}`, {
        role: "user",
        content: `greenhouse ${"x".repeat(500)} ${i}`,
      });
    }
    const result = await searchL1Archive({ storage, query: "greenhouse", limit: 3, now: NOW });
    expect(result.matches).toHaveLength(3);
    expect(result.matches[0]!.text.length).toBeLessThanOrEqual(301);
    expect(result.matches[0]!.text.endsWith("…")).toBe(true);
  });

  it("matches content stored as a parts array", async () => {
    await storage.appendL1Archive("chunk-parts", {
      role: "assistant",
      content: [{ type: "text", text: "greenhouse plans attached" }],
    });
    const result = await searchL1Archive({ storage, query: "greenhouse", now: NOW });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.role).toBe("assistant");
  });
});

describe("parseTimeBound", () => {
  it("passes through epoch ms numbers", () => {
    expect(parseTimeBound(1750000000000)).toBe(1750000000000);
  });

  it("accepts epoch-ms strings and ISO 8601 strings", () => {
    expect(parseTimeBound("1750000000000")).toBe(1750000000000);
    expect(parseTimeBound("2026-08-01T00:00:00Z")).toBe(Date.parse("2026-08-01T00:00:00Z"));
  });

  it("returns undefined for garbage and absent input", () => {
    expect(parseTimeBound(undefined)).toBeUndefined();
    expect(parseTimeBound("not a date")).toBeUndefined();
  });
});
