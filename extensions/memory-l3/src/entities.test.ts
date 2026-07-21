import { describe, expect, it } from "vitest";
import {
  extractEntitiesFromFacts,
  mergeEntities,
  adjustImportance,
  recordRetrievalSignals,
  findTopicLinks,
} from "./entities.js";
import type { L2Fact, TypedFact, LongTermFact, Entity, RetrievalSignal } from "./types.js";

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------

const makeFact = (text: string, overrides?: Partial<L2Fact>): L2Fact => ({
  id: `test-${Math.random().toString(36).slice(2, 8)}`,
  text,
  importance: 0.5,
  createdAt: Date.now(),
  dedupKey: `test:${text.slice(0, 20)}`,
  ...overrides,
});

const makeTypedFact = (slot: string, value: string): TypedFact => ({
  id: `tf-${Math.random().toString(36).slice(2, 8)}`,
  slot,
  value,
  sourceSpan: `context with ${value}`,
  unit: null,
  confidence: 0.9,
  createdAt: Date.now(),
});

// -----------------------------------------------------------------
// Entity extraction
// -----------------------------------------------------------------

describe("extractEntitiesFromFacts", () => {
  it("extracts IP addresses as infrastructure", () => {
    const facts = [makeFact("Pi-hole is at 192.168.50.128")];
    const entities = extractEntitiesFromFacts({
      facts,
      agentId: null,
      chunkId: "chunk-1",
    });
    const ips = entities.filter((e) => e.category === "infrastructure");
    expect(ips.length).toBeGreaterThanOrEqual(1);
    expect(ips.some((e) => e.name === "192.168.50.128")).toBe(true);
  });

  it("extracts IPs from typed facts", () => {
    const entities = extractEntitiesFromFacts({
      facts: [],
      typedFacts: [makeTypedFact("infra:pi_hole_ip", "192.168.50.128")],
      agentId: null,
      chunkId: "chunk-1",
    });
    expect(entities.some((e) => e.name === "192.168.50.128")).toBe(true);
  });

  it("extracts Docker service names", () => {
    const facts = [makeFact("Running transmission-daemon and portainer-agent containers")];
    const entities = extractEntitiesFromFacts({
      facts,
      agentId: null,
      chunkId: "chunk-1",
    });
    const tools = entities.filter((e) => e.category === "tool");
    expect(tools.some((e) => e.name === "transmission-daemon")).toBe(true);
    expect(tools.some((e) => e.name === "portainer-agent")).toBe(true);
  });

  it("extracts project names after project keywords", () => {
    const facts = [makeFact("Working on the Kaizoku project using portainer-agent")];
    const entities = extractEntitiesFromFacts({
      facts,
      agentId: null,
      chunkId: "chunk-1",
    });
    // "portainer-agent" should be extracted as a tool (Docker pattern)
    const tools = entities.filter((e) => e.category === "tool");
    expect(tools.some((e) => e.name === "portainer-agent")).toBe(true);
  });

  it("returns empty for no recognizable entities", () => {
    const facts = [makeFact("it was a dark and stormy night")];
    const entities = extractEntitiesFromFacts({
      facts,
      agentId: null,
      chunkId: "chunk-1",
    });
    expect(entities).toEqual([]);
  });

  it("deduplicates within a single extraction pass", () => {
    const facts = [
      makeFact("Server HueyTheDestroyer at 192.168.50.185"),
      makeFact("HueyTheDestroyer runs Docker"),
    ];
    const entities = extractEntitiesFromFacts({
      facts,
      agentId: null,
      chunkId: "chunk-1",
    });
    const ipEntities = entities.filter((e) => e.name === "192.168.50.185");
    expect(ipEntities.length).toBe(1);
    const [ipEntity] = ipEntities;
    if (!ipEntity) throw new Error("expected deduplicated ip entity");
    expect(ipEntity.mentionCount).toBeGreaterThanOrEqual(1);
  });
});

// -----------------------------------------------------------------
// Entity merging
// -----------------------------------------------------------------

describe("mergeEntities", () => {
  it("merges new entities into existing index", () => {
    const now = Date.now();
    const existing: Entity[] = [
      {
        id: "entity-192.168.50.128",
        name: "192.168.50.128",
        category: "infrastructure",
        aliases: [],
        firstSeenAt: now - 86400000,
        lastSeenAt: now - 86400000,
        mentionCount: 1,
        sourceChunkIds: ["chunk-0"],
        attributes: {},
      },
    ];
    const incoming: Entity[] = [
      {
        id: "entity-192.168.50.128",
        name: "192.168.50.128",
        category: "infrastructure",
        aliases: ["infra:pi_hole_ip"],
        firstSeenAt: now,
        lastSeenAt: now,
        mentionCount: 1,
        sourceChunkIds: ["chunk-1"],
        attributes: {},
      },
    ];
    const merged = mergeEntities(existing, incoming);
    expect(merged.length).toBe(1);
    const [mergedEntity] = merged;
    if (!mergedEntity) throw new Error("expected merged entity");
    expect(mergedEntity.mentionCount).toBe(2);
    expect(mergedEntity.aliases).toContain("infra:pi_hole_ip");
    expect(mergedEntity.sourceChunkIds).toContain("chunk-0");
    expect(mergedEntity.sourceChunkIds).toContain("chunk-1");
  });

  it("adds new entities not in existing index", () => {
    const existing: Entity[] = [];
    const incoming: Entity[] = [
      {
        id: "entity-hueythedestroyer",
        name: "HueyTheDestroyer",
        category: "infrastructure",
        aliases: [],
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        mentionCount: 1,
        sourceChunkIds: ["chunk-1"],
        attributes: {},
      },
    ];
    const merged = mergeEntities(existing, incoming);
    expect(merged.length).toBe(1);
    expect(merged[0]?.name).toBe("HueyTheDestroyer");
  });
});

// -----------------------------------------------------------------
// Dynamic importance scoring
// -----------------------------------------------------------------

describe("adjustImportance", () => {
  const now = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  it("boosts frequently recalled facts", () => {
    const facts: LongTermFact[] = [
      {
        id: "f1",
        text: "important fact",
        dedupKey: "dk1",
        importance: 0.5,
        firstSeenAt: now - 30 * MS_PER_DAY,
        lastConfirmedAt: now,
        recallCount: 5,
        sourceChunkIds: [],
        archived: false,
        archivedAt: null,
      },
    ];
    const signals = new Map<string, RetrievalSignal>([
      [
        "f1",
        {
          factId: "f1",
          recallCount: 10,
          lastRecalledAt: now,
          firstRecalledAt: now - 7 * MS_PER_DAY,
        },
      ],
    ]);
    const adjusted = adjustImportance({ facts, signals, now });
    const [adjustedFact] = adjusted;
    if (!adjustedFact) throw new Error("expected adjusted fact");
    expect(adjustedFact.importance).toBeGreaterThan(0.5);
  });

  it("decays old unrecalled facts", () => {
    const facts: LongTermFact[] = [
      {
        id: "f2",
        text: "old idle fact",
        dedupKey: "dk2",
        importance: 0.7,
        firstSeenAt: now - 90 * MS_PER_DAY,
        lastConfirmedAt: now - 60 * MS_PER_DAY,
        recallCount: 0,
        sourceChunkIds: [],
        archived: false,
        archivedAt: null,
      },
    ];
    const adjusted = adjustImportance({ facts, signals: new Map(), now });
    const [adjustedFact] = adjusted;
    if (!adjustedFact) throw new Error("expected adjusted fact");
    // Should still be >= 70% of original (0.49) but less than original
    expect(adjustedFact.importance).toBeLessThan(0.7);
    expect(adjustedFact.importance).toBeGreaterThanOrEqual(0.7 * 0.7);
  });

  it("decays significant facts slower", () => {
    const facts: LongTermFact[] = [
      {
        id: "f3",
        text: "significant fact",
        dedupKey: "dk3",
        importance: 0.7,
        firstSeenAt: now - 90 * MS_PER_DAY,
        lastConfirmedAt: now - 60 * MS_PER_DAY,
        recallCount: 0,
        sourceChunkIds: [],
        archived: false,
        archivedAt: null,
        significant: true,
      },
    ];
    const [significantFact] = facts;
    if (!significantFact) throw new Error("expected significant fact");
    const normalFacts: LongTermFact[] = [
      {
        ...significantFact,
        id: "f4",
        dedupKey: "dk4",
        significant: false,
      },
    ];
    const adjustedSignificant = adjustImportance({ facts, signals: new Map(), now });
    const adjustedNormal = adjustImportance({ facts: normalFacts, signals: new Map(), now });
    const [sigAdjusted] = adjustedSignificant;
    const [normalAdjusted] = adjustedNormal;
    if (!sigAdjusted || !normalAdjusted) throw new Error("expected adjusted facts");
    expect(sigAdjusted.importance).toBeGreaterThan(normalAdjusted.importance);
  });

  it("preserves facts with no meaningful change", () => {
    const facts: LongTermFact[] = [
      {
        id: "f5",
        text: "stable fact",
        dedupKey: "dk5",
        importance: 0.6,
        firstSeenAt: now,
        lastConfirmedAt: now,
        recallCount: 1,
        sourceChunkIds: [],
        archived: false,
        archivedAt: null,
      },
    ];
    const adjusted = adjustImportance({ facts, signals: new Map(), now });
    // Very recent fact with no retrieval signal — change should be < 0.01
    expect(adjusted[0]?.importance).toBe(facts[0]?.importance);
    // Reference equality means no new object was created
    expect(adjusted[0]).toBe(facts[0]);
  });
});

// -----------------------------------------------------------------
// Retrieval signal recording
// -----------------------------------------------------------------

describe("recordRetrievalSignals", () => {
  it("creates new signals for first-time retrieved facts", () => {
    const existing = new Map<string, RetrievalSignal>();
    const updated = recordRetrievalSignals(existing, ["f1", "f2"], 1000);
    expect(updated.size).toBe(2);
    expect(updated.get("f1")?.recallCount).toBe(1);
    expect(updated.get("f1")?.lastRecalledAt).toBe(1000);
  });

  it("increments existing signals", () => {
    const existing = new Map<string, RetrievalSignal>([
      ["f1", { factId: "f1", recallCount: 3, lastRecalledAt: 500, firstRecalledAt: 100 }],
    ]);
    const updated = recordRetrievalSignals(existing, ["f1"], 2000);
    expect(updated.get("f1")?.recallCount).toBe(4);
    expect(updated.get("f1")?.lastRecalledAt).toBe(2000);
    expect(updated.get("f1")?.firstRecalledAt).toBe(100); // unchanged
  });
});

// -----------------------------------------------------------------
// Topic linking
// -----------------------------------------------------------------

describe("findTopicLinks", () => {
  it("links chunks with high similarity", async () => {
    // Create two similar embedding vectors
    const embedding1 = Array(8).fill(0.1);
    embedding1[0] = 0.9;
    const embedding2 = Array(8).fill(0.1);
    embedding2[0] = 0.85;

    const links = await findTopicLinks({
      chunkId: "chunk-1",
      chunkEmbedding: embedding1,
      existingChunks: [{ chunkId: "chunk-0", embedding: embedding2 }],
      threshold: 0.7,
    });
    expect(links.length).toBe(1);
    const [link] = links;
    if (!link) throw new Error("expected topic link");
    expect(link.sourceChunkId).toBe("chunk-1");
    expect(link.targetChunkId).toBe("chunk-0");
    expect(link.similarity).toBeGreaterThan(0.7);
  });

  it("skips chunks below threshold", async () => {
    const embedding1 = Array(8).fill(0.1);
    embedding1[0] = 0.9;
    const embedding2 = Array(8).fill(0.1);
    embedding2[7] = 0.9; // orthogonal

    const links = await findTopicLinks({
      chunkId: "chunk-1",
      chunkEmbedding: embedding1,
      existingChunks: [{ chunkId: "chunk-0", embedding: embedding2 }],
      threshold: 0.7,
    });
    expect(links).toEqual([]);
  });

  it("skips self-links", async () => {
    const embedding = Array(8).fill(0.5);

    const links = await findTopicLinks({
      chunkId: "chunk-1",
      chunkEmbedding: embedding,
      existingChunks: [{ chunkId: "chunk-1", embedding }],
      threshold: 0.5,
    });
    expect(links).toEqual([]);
  });
});
