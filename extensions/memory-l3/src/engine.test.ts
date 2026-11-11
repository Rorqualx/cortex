import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HierarchicalL3Engine, pressureAdaptiveTopK } from "./engine.js";
import { classifyQueryIntent } from "./retrieval.js";
import { Storage } from "./storage.js";
import type { L2ChunkFrontmatter, LongTermFrontmatter } from "./types.js";

// F9 (2026-08-28): pressure-adaptive recall volume at the assembly step.
// The engine's buildMemorySection() scales its retrieveTopK count with
// current context-token pressure (estimatedTokens / tokenBudget, clamped
// to [0,1]); this file pins the mapping so regressions are caught cheaply.
describe("pressureAdaptiveTopK", () => {
  it("returns the full baseline topK at zero pressure", () => {
    expect(pressureAdaptiveTopK(0)).toBe(5);
  });

  it("trims linearly as pressure rises", () => {
    expect(pressureAdaptiveTopK(0.5)).toBe(4);
    expect(pressureAdaptiveTopK(0.75)).toBeGreaterThanOrEqual(3);
  });

  it("floors at the minimum under full pressure", () => {
    expect(pressureAdaptiveTopK(1)).toBe(3);
  });

  it("clamps out-of-range pressure inputs", () => {
    expect(pressureAdaptiveTopK(-0.5)).toBe(5);
    expect(pressureAdaptiveTopK(2)).toBe(3);
    expect(pressureAdaptiveTopK(Number.NaN)).toBe(5);
  });
});

// ARCH-2 v1 (2026-11-11, card 9b9efeea): retrieval telemetry at both engine
// injection lanes. Fixture hygiene per the 2026-11-09 test manifest (b):
// every retrieval case seeds ≥1 L2 chunk + a matching longterm fact first
// (retrieveTopK early-returns [] on a chunkless store).
const NOW = Date.UTC(2026, 10, 11);
const FACT_TEXT = "pi-hole resolver lives at 192.168.50.128";
const PROMPT = "pi-hole resolver address";

const stubEmbedding = {
  embed: async () => [1, 0],
  embedBatch: async (texts: string[]) => texts.map(() => [1, 0] as number[]),
};

const seedFixture = async (storage: Storage): Promise<void> => {
  const frontmatter: L2ChunkFrontmatter = {
    id: "chunk-tel",
    agentId: "j-rorqual",
    startTurnIndex: 0,
    endTurnIndex: 1,
    createdAt: NOW,
    facts: [
      { id: "f-tel", text: FACT_TEXT, importance: 0.8, createdAt: NOW, dedupKey: "tel:pihole" },
    ],
    typedFacts: [],
    dedupKeys: ["tel:pihole"],
  };
  await storage.writeL2Chunk(frontmatter, "");
  const longterm: LongTermFrontmatter = {
    version: 1,
    agentId: null,
    lastConsolidatedAt: NOW,
    facts: [
      {
        id: "lt-tel",
        text: FACT_TEXT,
        dedupKey: "tel:pihole",
        importance: 0.9,
        firstSeenAt: NOW,
        lastConfirmedAt: NOW,
        recallCount: 2,
        sourceChunkIds: ["chunk-tel"],
        archived: false,
        archivedAt: null,
      },
    ],
  };
  await storage.writeLongTerm(longterm, "");
};

describe("HierarchicalL3Engine retrieval telemetry (ARCH-2 v1, 2026-11-11)", () => {
  let tmpRoot: string;
  let storage: Storage;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-engine-tel-"));
    storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("fresh injection lane records an event with recomputed intent (T-E1)", async () => {
    await seedFixture(storage);
    const engine = new HierarchicalL3Engine(storage, { embeddingProvider: stubEmbedding });
    const result = await engine.assemble({
      sessionId: "sess-1",
      sessionKey: "key-1",
      messages: [],
      prompt: PROMPT,
    });
    expect(result.systemPromptAddition).toBeDefined();
    expect(result.systemPromptAddition).toContain(FACT_TEXT);
    const events = storage.listRetrievalEvents();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.source).toBe("engine-fresh");
    expect(ev.intentClass).toBe(classifyQueryIntent(PROMPT));
    expect(ev.preset).toBe("blended");
    expect(ev.topK).toBe(pressureAdaptiveTopK(0));
    expect(ev.factIds.length).toBeGreaterThan(0);
    expect(ev.sessionKey).toBe("key-1");
  });

  it("ReTopK cache-hit lane records an event (T-E2)", async () => {
    await seedFixture(storage);
    const engine = new HierarchicalL3Engine(storage, { embeddingProvider: stubEmbedding });
    await engine.assemble({
      sessionId: "sess-1",
      sessionKey: "key-1",
      messages: [],
      prompt: PROMPT,
    });
    await engine.assemble({
      sessionId: "sess-1",
      sessionKey: "key-1",
      messages: [],
      prompt: PROMPT,
    });
    const events = storage.listRetrievalEvents();
    expect(events).toHaveLength(2);
    expect(events[1]!.source).toBe("engine-retopk-cache");
    expect(events[1]!.sessionKey).toBe("key-1");
    expect(events[1]!.intentClass).toBe("factual");
    expect(events[1]!.factIds.length).toBeGreaterThan(0);
  });

  it("throwing telemetry storage is non-fatal on both lanes (T-E3)", async () => {
    class ThrowingSyncStorage extends Storage {
      recordRetrievalEvent(): void {
        throw new Error("telemetry down (sync)");
      }
    }
    class ThrowingAsyncStorage extends Storage {
      recordRetrievalEvent(): Promise<void> {
        return Promise.reject(new Error("telemetry down (async)"));
      }
    }
    const healthyRoot = path.join(tmpRoot, "healthy");
    const healthyStorage = new Storage(path.join(healthyRoot, ".openclaw", "l3"));
    await seedFixture(healthyStorage);
    const healthy = await new HierarchicalL3Engine(healthyStorage, {
      embeddingProvider: stubEmbedding,
    }).assemble({ sessionId: "s", sessionKey: "k", messages: [], prompt: PROMPT });
    expect(healthy.systemPromptAddition).toContain(FACT_TEXT);

    const badSync = new ThrowingSyncStorage(path.join(tmpRoot, "bad-sync", ".openclaw", "l3"));
    await seedFixture(badSync);
    const outSync = await new HierarchicalL3Engine(badSync, {
      embeddingProvider: stubEmbedding,
    }).assemble({ sessionId: "s", sessionKey: "k", messages: [], prompt: PROMPT });
    expect(outSync.systemPromptAddition).toContain(FACT_TEXT);

    const badAsync = new ThrowingAsyncStorage(path.join(tmpRoot, "bad-async", ".openclaw", "l3"));
    await seedFixture(badAsync);
    const outAsync = await new HierarchicalL3Engine(badAsync, {
      embeddingProvider: stubEmbedding,
    }).assemble({ sessionId: "s", sessionKey: "k", messages: [], prompt: PROMPT });
    expect(outAsync.systemPromptAddition).toContain(FACT_TEXT);
  });

  it("channel-less session records with null session_key (T-E4)", async () => {
    await seedFixture(storage);
    const engine = new HierarchicalL3Engine(storage, { embeddingProvider: stubEmbedding });
    await engine.assemble({ sessionId: "sess-2", messages: [], prompt: PROMPT });
    const events = storage.listRetrievalEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionKey).toBeNull();
  });

  it("chunkless store: no empty-fact event rows (pins early-return) (T-E5)", async () => {
    // Long-term tier seeded but NO L2 chunks: retrieveTopK early-returns
    // {facts: []} on a chunkless store — an empty injection is not telemetry.
    const longtermOnly: LongTermFrontmatter = {
      version: 1,
      agentId: null,
      lastConsolidatedAt: NOW,
      facts: [
        {
          id: "lt-only",
          text: FACT_TEXT,
          dedupKey: "tel:pihole",
          importance: 0.9,
          firstSeenAt: NOW,
          lastConfirmedAt: NOW,
          recallCount: 1,
          sourceChunkIds: [],
          archived: false,
          archivedAt: null,
        },
      ],
    };
    await storage.writeLongTerm(longtermOnly, "");
    const engine = new HierarchicalL3Engine(storage, { embeddingProvider: stubEmbedding });
    const out = await engine.assemble({
      sessionId: "s",
      sessionKey: "k",
      messages: [],
      prompt: "pi-hole resolver",
    });
    expect(out.systemPromptAddition).toBeUndefined();
    expect(storage.listRetrievalEvents()).toHaveLength(0);
  });
});
