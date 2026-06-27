// Insights aggregation tests: window membership, archived/superseded filtering,
// and recall ranking over a seeded Storage root.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectMemoryInsights } from "./insights.js";
import { Storage } from "./storage.js";
import type { LongTermFact, LongTermTypedFact } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-06-12T12:00:00Z");

function fact(overrides: Partial<LongTermFact> & { id: string }): LongTermFact {
  return {
    text: `fact ${overrides.id}`,
    dedupKey: `dedup-${overrides.id}`,
    importance: 0.7,
    firstSeenAt: NOW - 30 * DAY_MS,
    lastConfirmedAt: NOW - DAY_MS,
    recallCount: 2,
    sourceChunkIds: [],
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

function typedFact(overrides: Partial<LongTermTypedFact> & { id: string }): LongTermTypedFact {
  return {
    slot: `slot-${overrides.id}`,
    value: `value-${overrides.id}`,
    unit: null,
    confidence: 0.9,
    firstSeenAt: NOW - 30 * DAY_MS,
    lastConfirmedAt: NOW - DAY_MS,
    recallCount: 2,
    sourceChunkIds: [],
    history: [],
    validFrom: NOW - 30 * DAY_MS,
    validUntil: null,
    supersededBy: null,
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

describe("collectMemoryInsights", () => {
  let root: string;
  let storage: Storage;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "memory-l3-insights-"));
    storage = new Storage(root);
    await storage.ensureLayout();
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("returns empty insights for a fresh store", async () => {
    const insights = await collectMemoryInsights({ storage, now: NOW });
    expect(insights.totals).toEqual({ longTermFacts: 0, typedSlots: 0, epochs: 0, l2Chunks: 0 });
    expect(insights.window.factsPromoted).toEqual([]);
    expect(insights.topRecalled).toEqual([]);
  });

  it("separates window promotions from totals and ranks top recalled facts", async () => {
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: null,
        lastConsolidatedAt: NOW,
        facts: [
          fact({ id: "old", firstSeenAt: NOW - 20 * DAY_MS, recallCount: 9 }),
          fact({ id: "new", firstSeenAt: NOW - 2 * DAY_MS, recallCount: 3 }),
          fact({ id: "archived", firstSeenAt: NOW - DAY_MS, archived: true, archivedAt: NOW }),
          fact({ id: "superseded", firstSeenAt: NOW - DAY_MS, supersededBy: "slot-x" }),
        ],
      },
      "body",
    );

    const insights = await collectMemoryInsights({ storage, days: 7, now: NOW });
    expect(insights.totals.longTermFacts).toBe(2);
    expect(insights.window.factsPromoted.map((entry) => entry.text)).toEqual(["fact new"]);
    expect(insights.topRecalled.map((entry) => entry.recallCount)).toEqual([9, 3]);
  });

  it("reports typed slot changes within the window with history counts", async () => {
    await storage.writeLongTermTyped(
      {
        version: 1,
        agentId: null,
        lastConsolidatedAt: NOW,
        facts: [
          typedFact({
            id: "hot",
            slot: "infra:gateway-port",
            value: "4317",
            lastConfirmedAt: NOW - DAY_MS,
            history: [{ value: "4316", supersededAt: NOW - 3 * DAY_MS }],
          }),
          typedFact({ id: "stale", lastConfirmedAt: NOW - 20 * DAY_MS }),
        ],
      },
      "body",
    );

    const insights = await collectMemoryInsights({ storage, days: 7, now: NOW });
    expect(insights.totals.typedSlots).toBe(2);
    expect(insights.window.typedSlotsChanged).toEqual([
      {
        slot: "infra:gateway-port",
        value: "4317",
        lastConfirmedAt: NOW - DAY_MS,
        changes: 1,
      },
    ]);
  });

  it("counts epochs and L2 chunks inside the window", async () => {
    await storage.writeL3Epoch(
      {
        id: "epoch-recent",
        agentId: null,
        startChunkId: "c1",
        endChunkId: "c2",
        createdAt: NOW - DAY_MS,
        representativeFacts: [
          {
            id: "f1",
            text: "fact",
            importance: 0.8,
            createdAt: NOW - DAY_MS,
            dedupKey: "f1",
          },
        ],
      },
      "digest",
    );
    await storage.writeL3Epoch(
      {
        id: "epoch-old",
        agentId: null,
        startChunkId: "c0",
        endChunkId: "c1",
        createdAt: NOW - 30 * DAY_MS,
        representativeFacts: [],
      },
      "digest",
    );
    await storage.writeL2Chunk(
      {
        id: "chunk-recent",
        agentId: null,
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: NOW - DAY_MS,
        facts: [],
        dedupKeys: [],
      },
      "summary",
    );
    await storage.writeL2Chunk(
      {
        id: "chunk-old",
        agentId: null,
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: NOW - 30 * DAY_MS,
        facts: [],
        dedupKeys: [],
      },
      "summary",
    );

    const insights = await collectMemoryInsights({ storage, days: 7, now: NOW });
    expect(insights.totals.epochs).toBe(2);
    expect(insights.totals.l2Chunks).toBe(2);
    expect(insights.window.epochsCreated).toEqual([
      { id: "epoch-recent", createdAt: NOW - DAY_MS, representativeFactCount: 1 },
    ]);
    expect(insights.window.l2Chunks).toBe(1);
  });

  it("clips long fact text and honors the limit", async () => {
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: null,
        lastConsolidatedAt: NOW,
        facts: [
          fact({ id: "long", text: "x".repeat(300), recallCount: 5 }),
          fact({ id: "a", recallCount: 4 }),
          fact({ id: "b", recallCount: 3 }),
        ],
      },
      "body",
    );

    const insights = await collectMemoryInsights({ storage, limit: 2, now: NOW });
    expect(insights.topRecalled).toHaveLength(2);
    expect(insights.topRecalled[0].text.length).toBeLessThanOrEqual(201);
    expect(insights.topRecalled[0].text.endsWith("…")).toBe(true);
  });
});
