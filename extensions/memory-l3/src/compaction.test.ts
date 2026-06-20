import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactSession } from "./compaction.js";
import { IngestBuffer } from "./ingest.js";
import type { LlmCaller } from "./llm.js";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L3State } from "./types.js";

const userMsg = (text: string) => ({ role: "user", content: text }) as never;

let tmpRoot: string;
let storage: Storage;
let buffer: IngestBuffer;
let state: L3State;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-compaction-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  buffer = new IngestBuffer();
  state = { ...INITIAL_L3_STATE, agentId: "j-rorqual" };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("compactSession", () => {
  it("returns an empty result when buffer is empty", async () => {
    const caller = vi.fn(async () => "{}");
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result).toEqual({
      chunkId: null,
      factsAdded: 0,
      typedFactsAdded: 0,
      tokensBefore: 0,
      messagesIngested: 0,
      epochId: null,
    });
    expect(caller).not.toHaveBeenCalled();
  });

  it("segments extraction at topic boundaries when segmented compaction is enabled", async () => {
    await storage.ensureLayout();
    // 20 messages = two 10-message windows; orthogonal window embeddings
    // force one boundary at message index 10.
    for (let i = 0; i < 10; i++) {
      buffer.push("s1", userMsg(`gardening topic message ${i}`));
    }
    for (let i = 0; i < 10; i++) {
      buffer.push("s1", userMsg(`kubernetes topic message ${i}`));
    }
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [{ text: "segment fact", importance: 0.7, dedupKey: `seg:${Math.random()}` }],
      }),
    );
    let windowCall = 0;
    const embeddingProvider = {
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) =>
        texts.map(() => (windowCall++ % 2 === 0 ? [1, 0] : [0, 1])),
    };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      embeddingProvider,
      segmentedCompaction: true,
    });
    // One extraction call per topic segment.
    expect(caller).toHaveBeenCalledTimes(2);
    const doc = await storage.readL2Chunk(result.chunkId!, Date.now());
    expect(doc?.frontmatter.topicSegments).toEqual([
      { startMsgIndex: 0, endMsgIndex: 10 },
      { startMsgIndex: 10, endMsgIndex: 20 },
    ]);
  });

  it("keeps monolithic extraction when segmented compaction is disabled", async () => {
    await storage.ensureLayout();
    for (let i = 0; i < 20; i++) {
      buffer.push("s1", userMsg(`message ${i}`));
    }
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [{ text: "fact", importance: 0.7, dedupKey: "k:1" }],
      }),
    );
    let windowCall = 0;
    const embeddingProvider = {
      embed: async () => [1, 0],
      embedBatch: async (texts: string[]) =>
        texts.map(() => (windowCall++ % 2 === 0 ? [1, 0] : [0, 1])),
    };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      embeddingProvider,
      segmentedCompaction: false,
    });
    expect(caller).toHaveBeenCalledTimes(1);
    const doc = await storage.readL2Chunk(result.chunkId!, Date.now());
    expect(doc?.frontmatter.topicSegments).toBeUndefined();
  });

  it("persists information gain as novelty against long-term fact embeddings", async () => {
    await storage.ensureLayout();
    // Seed one long-term fact whose embedding is identical to what the stub
    // provider returns — the new chunk covers no new ground (gain 0).
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: 0,
        facts: [
          {
            id: "lt-1",
            text: "known fact",
            dedupKey: "known:fact",
            importance: 0.8,
            firstSeenAt: 1,
            lastConfirmedAt: 2,
            recallCount: 3,
            sourceChunkIds: ["chunk-0"],
            archived: false,
            archivedAt: null,
            embedding: [1, 0, 0],
          },
        ],
      },
      "body",
    );
    buffer.push("s1", userMsg("Something new."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [{ text: "a fresh fact", importance: 0.7, dedupKey: "fresh:fact" }],
      }),
    );
    const embeddingProvider = {
      embed: async () => [1, 0, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      embeddingProvider,
    });
    const doc = await storage.readL2Chunk(result.chunkId!, Date.now());
    expect(doc?.frontmatter.informationGain).toBeCloseTo(0, 6);
  });

  it("records full information gain when long-term memory is empty", async () => {
    await storage.ensureLayout();
    buffer.push("s1", userMsg("Brand new territory."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [{ text: "novel fact", importance: 0.7, dedupKey: "novel:fact" }],
      }),
    );
    const embeddingProvider = {
      embed: async () => [0, 1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [0, 1, 0]),
    };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      embeddingProvider,
    });
    const doc = await storage.readL2Chunk(result.chunkId!, Date.now());
    expect(doc?.frontmatter.informationGain).toBe(1);
  });

  it("extracts facts, persists an L2 chunk, and drains the buffer", async () => {
    buffer.push("s1", userMsg("I prefer morning standups."));
    buffer.push("s1", userMsg("Yes, every weekday."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "user prefers morning standups",
            importance: 0.8,
            dedupKey: "user_preference:morning_standups",
          },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.chunkId).not.toBeNull();
    expect(result.factsAdded).toBe(1);
    expect(result.messagesIngested).toBe(2);
    expect(buffer.size("s1")).toBe(0);
    expect(state.l2ChunkIndex).toBe(1);
    expect(state.lastChunkId).toBe(result.chunkId);

    const paths = await storage.listL2ChunkPaths();
    expect(paths).toHaveLength(1);
    const doc = await storage.readL2ChunkAtPath(paths[0]);
    expect(doc?.frontmatter.facts).toHaveLength(1);
    expect(doc?.frontmatter.facts[0].text).toBe("user prefers morning standups");
    expect(doc?.frontmatter.dedupKeys).toEqual(["user_preference:morning_standups"]);
  });

  it("drops facts whose dedupKey is already in a recent chunk", async () => {
    await storage.ensureLayout();
    await storage.writeL2Chunk(
      {
        id: "chunk-prior",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: Date.now(),
        facts: [],
        dedupKeys: ["user_preference:morning_standups"],
      },
      "",
    );

    buffer.push("s1", userMsg("morning standups again"));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "user prefers morning standups",
            importance: 0.8,
            dedupKey: "user_preference:morning_standups",
          },
          {
            text: "user uses tabs not spaces",
            importance: 0.6,
            dedupKey: "code_style:tabs",
          },
        ],
      }),
    );

    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.factsAdded).toBe(1);
    const paths = await storage.listL2ChunkPaths();
    const newChunkPath = paths.find((p) => !p.includes("chunk-prior"));
    expect(newChunkPath).toBeDefined();
    const doc = await storage.readL2ChunkAtPath(newChunkPath as string);
    expect(doc?.frontmatter.dedupKeys).toEqual(["code_style:tabs"]);
  });

  it("dedupes within-chunk when the LLM emits the same dedupKey twice", async () => {
    buffer.push("s1", userMsg("anything"));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          { text: "first emission", importance: 0.8, dedupKey: "k:dup" },
          { text: "second emission", importance: 0.3, dedupKey: "k:dup" },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.factsAdded).toBe(1);
    const paths = await storage.listL2ChunkPaths();
    const doc = await storage.readL2ChunkAtPath(paths[0]);
    expect(doc?.frontmatter.facts[0].text).toBe("first emission");
    expect(doc?.frontmatter.facts[0].importance).toBe(0.8);
  });

  it("grounds typed facts against the transcript and persists only those that survive", async () => {
    buffer.push(
      "s1",
      userMsg("My pi-hole is at 192.168.50.128 and the router is at 192.168.50.1."),
    );
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [],
        typedFacts: [
          {
            slot: "infra:pi_hole_ip",
            value: "192.168.50.128",
            sourceSpan: "pi-hole is at 192.168.50.128",
            unit: null,
            confidence: 0.95,
          },
          {
            slot: "infra:router_ip",
            value: "192.168.50.1",
            sourceSpan: "router is at 192.168.50.1",
            unit: null,
            confidence: 0.95,
          },
          {
            // Hallucinated — value never appeared in the transcript. Must be dropped.
            slot: "infra:gateway_ip",
            value: "10.0.0.1",
            sourceSpan: "gateway at 10.0.0.1",
            unit: null,
            confidence: 0.5,
          },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.typedFactsAdded).toBe(2);

    const paths = await storage.listL2ChunkPaths();
    const doc = await storage.readL2ChunkAtPath(paths[0]);
    expect(doc?.frontmatter.typedFacts).toHaveLength(2);
    expect(doc?.frontmatter.typedFacts?.map((t) => t.slot)).toEqual([
      "infra:pi_hole_ip",
      "infra:router_ip",
    ]);
    expect(doc?.frontmatter.typedFacts?.[0].value).toBe("192.168.50.128");
  });

  it("uses the native compaction prompt when nativeCompaction is enabled", async () => {
    buffer.push("s1", userMsg("I prefer morning standups."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "usr:morning_standups=9AM",
            importance: 0.8,
            dedupKey: "user_preference:morning_standups",
          },
        ],
      }),
    );
    await storage.ensureLayout();
    await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      nativeCompaction: true,
    });
    expect(caller).toHaveBeenCalledTimes(1);
    const systemPrompt = (caller as ReturnType<typeof vi.fn>).mock.calls[0][0].systemPrompt;
    expect(systemPrompt).toContain("PROMPT_VERSION=8-NATIVE");
  });

  it("writes the L1 archive with the original messages", async () => {
    buffer.push("s1", userMsg("first"));
    buffer.push("s1", userMsg("second"));
    const caller: LlmCaller = vi.fn(async () => JSON.stringify({ facts: [] }));
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.chunkId).not.toBeNull();
    const archivePath = path.join(storage.root, "l1_archive", `${result.chunkId}.jsonl`);
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(archivePath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ role: "user", content: "first" });
    expect(JSON.parse(lines[1])).toEqual({ role: "user", content: "second" });
  });
});
