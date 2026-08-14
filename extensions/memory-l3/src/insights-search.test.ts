// L1-archive lexical search tests: iterative chunk selection, message scoring,
// session-aware rank fusion, temporal + session filters, malformed-line safety.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchMemoryArchive, tokenizeQuery } from "./insights-search.js";
import { Storage } from "./storage.js";
import type { L2ChunkFrontmatter, L2Fact } from "./types.js";

const NOW = Date.parse("2026-08-14T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function l2Fact(overrides: Partial<L2Fact> & { id: string }): L2Fact {
  return {
    text: `fact ${overrides.id}`,
    importance: 0.7,
    createdAt: NOW,
    dedupKey: `dedup-${overrides.id}`,
    ...overrides,
  };
}

function l2Frontmatter(
  overrides: Partial<L2ChunkFrontmatter> & { id: string },
): L2ChunkFrontmatter {
  return {
    agentId: "eval",
    startTurnIndex: 0,
    endTurnIndex: 2,
    createdAt: NOW,
    facts: [],
    dedupKeys: [],
    ...overrides,
  };
}

describe("tokenizeQuery", () => {
  it("splits, lowercases, dedupes, drops noise", () => {
    expect(tokenizeQuery("The THE green-house! a b x 42")).toEqual(["the", "green", "house", "42"]);
  });

  it("returns empty for stopword-length noise only", () => {
    expect(tokenizeQuery("a - _ ! ?")).toEqual([]);
  });
});

describe("searchMemoryArchive", () => {
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

  it("finds keyword hits with score, matchedTerms, and chunk metadata", async () => {
    await storage.appendL1Archive("chunk-a", { role: "user", content: "I love green tea" });
    await storage.appendL1Archive("chunk-a", {
      role: "assistant",
      content: "Noted your tea preference.",
    });
    await storage.appendL1Archive("chunk-b", {
      role: "user",
      content: "Talk about something else",
    });

    const result = await searchMemoryArchive({ storage, query: "green tea", now: NOW });
    expect(result.terms).toEqual(["green", "tea"]);
    expect(result.chunksScanned).toBe(2);
    expect(result.chunksMatched).toBe(1);
    expect(result.messagesScanned).toBe(3);
    // Both chunk-a messages match ("tea" appears in the reply too); the
    // full-coverage user message outranks the single-term assistant reply.
    expect(result.hits).toHaveLength(2);
    const hit = result.hits[0]!;
    expect(hit.chunkId).toBe("chunk-a");
    expect(hit.index).toBe(0);
    expect(hit.role).toBe("user");
    expect(hit.text).toBe("I love green tea");
    expect(hit.matchedTerms).toEqual(["green", "tea"]);
    expect(hit.score).toBeGreaterThan(result.hits[1]!.score);
  });

  it("rank fusion prefers fuller query coverage from broader chunks", async () => {
    // chunk-a: single message covering BOTH terms
    await storage.appendL1Archive("chunk-a", { role: "user", content: "green tea is great" });
    // chunk-b: each term in a separate message
    await storage.appendL1Archive("chunk-b", { role: "user", content: "the green lamp shines" });
    await storage.appendL1Archive("chunk-b", { role: "user", content: "iced tea is cold" });

    const result = await searchMemoryArchive({ storage, query: "green tea", now: NOW });
    expect(result.hits).toHaveLength(3);
    expect(result.hits[0]!.chunkId).toBe("chunk-a");
    expect(result.hits[0]!.matchedTerms).toEqual(["green", "tea"]);
    // chunk-b hits match one term each but its chunk coverage spans both,
    // so they fuse above zero — the broad-session prior keeps them ranked.
    expect(result.hits[1]!.chunkId).toBe("chunk-b");
    expect(result.hits[2]!.chunkId).toBe("chunk-b");
  });

  it("extracts text from assistant content-part arrays", async () => {
    await storage.appendL1Archive("chunk-a", {
      role: "assistant",
      content: [{ type: "text", text: "Deployed the flaky widget" }],
    });
    const result = await searchMemoryArchive({ storage, query: "flaky widget", now: NOW });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.text).toContain("flaky widget");
  });

  it("since/until filters by message timestamp, falling back to chunk createdAt", async () => {
    await storage.appendL1Archive("chunk-old", {
      role: "user",
      content: "ancient green tea ritual",
      timestamp: NOW - 30 * DAY_MS,
    });
    await storage.appendL1Archive("chunk-new", {
      role: "user",
      content: "recent green tea order",
      timestamp: NOW - DAY_MS,
    });

    const recent = await searchMemoryArchive({
      storage,
      query: "green tea",
      since: NOW - 7 * DAY_MS,
      now: NOW,
    });
    expect(recent.hits).toHaveLength(1);
    expect(recent.hits[0]!.chunkId).toBe("chunk-new");

    const windowed = await searchMemoryArchive({
      storage,
      query: "green tea",
      since: NOW - 40 * DAY_MS,
      until: NOW - 20 * DAY_MS,
      now: NOW,
    });
    expect(windowed.hits).toHaveLength(1);
    expect(windowed.hits[0]!.chunkId).toBe("chunk-old");
  });

  it("falls back to the L2 chunk createdAt when messages lack timestamps", async () => {
    await storage.writeL2Chunk(
      l2Frontmatter({ id: "chunk-stamped", createdAt: NOW - 60 * DAY_MS }),
      "body",
    );
    await storage.appendL1Archive("chunk-stamped", {
      role: "user",
      content: "undated tea ceremony",
    });

    const result = await searchMemoryArchive({
      storage,
      query: "tea ceremony",
      since: NOW - 10 * DAY_MS,
      now: NOW,
    });
    expect(result.hits).toHaveLength(0);

    const all = await searchMemoryArchive({ storage, query: "tea ceremony", now: NOW });
    expect(all.hits).toHaveLength(1);
  });

  it("sessionId filter restricts to chunks citing that session", async () => {
    await storage.writeL2Chunk(
      l2Frontmatter({
        id: "chunk-s1",
        facts: [l2Fact({ id: "f1", sessionId: "session-1" })],
      }),
      "body",
    );
    await storage.writeL2Chunk(
      l2Frontmatter({
        id: "chunk-s2",
        facts: [l2Fact({ id: "f2", sessionId: "session-2" })],
      }),
      "body",
    );
    await storage.appendL1Archive("chunk-s1", {
      role: "user",
      content: "green tea from session one",
    });
    await storage.appendL1Archive("chunk-s2", {
      role: "user",
      content: "green tea from session two",
    });

    const result = await searchMemoryArchive({
      storage,
      query: "green tea",
      sessionId: "session-1",
      now: NOW,
    });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.chunkId).toBe("chunk-s1");
    expect(result.hits[0]!.sessionId).toBe("session-1");
  });

  it("reports sessionId metadata on hits even without a filter", async () => {
    await storage.writeL2Chunk(
      l2Frontmatter({ id: "chunk-s1", facts: [l2Fact({ id: "f1", sessionId: "session-9" })] }),
      "body",
    );
    await storage.appendL1Archive("chunk-s1", { role: "user", content: "green tea here" });
    const result = await searchMemoryArchive({ storage, query: "green tea", now: NOW });
    expect(result.hits[0]!.sessionId).toBe("session-9");
  });

  it("skips malformed JSONL lines without failing", async () => {
    await fsp.appendFile(
      path.join(storage.root, "l1_archive", "chunk-bad.jsonl"),
      '{"role":"user","content":"valid green tea line"}\nnot-json\n[1,2,3]\n\n',
      "utf8",
    );
    const result = await searchMemoryArchive({ storage, query: "green tea", now: NOW });
    expect(result.hits).toHaveLength(1);
    expect(result.messagesScanned).toBe(1);
  });

  it("honors limit and sorts by fused score", async () => {
    for (let i = 0; i < 5; i += 1) {
      await storage.appendL1Archive("chunk-many", {
        role: "user",
        content: `green tea mention number ${i}`,
      });
    }
    const result = await searchMemoryArchive({ storage, query: "green tea", limit: 2, now: NOW });
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]!.score).toBeGreaterThanOrEqual(result.hits[1]!.score);
  });

  it("returns an empty result for empty or noise-only queries", async () => {
    await storage.appendL1Archive("chunk-a", { role: "user", content: "green tea" });
    const result = await searchMemoryArchive({ storage, query: "?? a", now: NOW });
    expect(result).toMatchObject({ chunksScanned: 0, chunksMatched: 0, hits: [] });
  });

  it("returns empty on a fresh store with no archive", async () => {
    const result = await searchMemoryArchive({ storage, query: "anything", now: NOW });
    expect(result.hits).toEqual([]);
    expect(result.chunksScanned).toBe(0);
  });
});
