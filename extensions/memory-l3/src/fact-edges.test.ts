import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitEntityShareEdges } from "./fact-edges.js";
import { applyFactEdgeBoost, DEFAULT_HEBBIAN_CONFIG } from "./hebbian.js";
import { consolidateLongTermTyped } from "./longterm-typed.js";
import { Storage } from "./storage.js";
import type { FactEdge, LongTermTypedFact, TypedFact } from "./types.js";
import { INITIAL_L3_STATE } from "./types.js";

let tmpRoot: string;
let storage: Storage;

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-fact-edges-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeTypedFact(
  overrides: Partial<TypedFact> & Pick<TypedFact, "id" | "slot" | "value">,
): TypedFact {
  return {
    sourceSpan: `source of ${overrides.value}`,
    unit: null,
    confidence: 0.9,
    createdAt: NOW,
    ...overrides,
  };
}

function makeLongTermTyped(
  slot: string,
  value: string,
  overrides: Partial<LongTermTypedFact> = {},
): LongTermTypedFact {
  return {
    id: `ltt-${slot.replace(/[^a-z0-9]/gi, "-")}`,
    slot,
    value,
    unit: null,
    confidence: 0.9,
    firstSeenAt: NOW,
    lastConfirmedAt: NOW,
    recallCount: 1,
    sourceChunkIds: ["chunk-000000-a"],
    history: [],
    validFrom: NOW,
    validUntil: null,
    supersededBy: null,
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

async function writeChunkWithTyped(
  chunkId: string,
  typedFacts: TypedFact[],
  createdAt: number,
): Promise<void> {
  await storage.writeL2Chunk(
    {
      id: chunkId,
      agentId: "j-rorqual",
      startTurnIndex: 0,
      endTurnIndex: 1,
      createdAt,
      facts: [],
      typedFacts,
      dedupKeys: [],
    },
    "",
  );
}

describe("FactEdge storage", () => {
  it("round-trips both edge types through l3_fact_edges preserving confidence and createdEpoch", async () => {
    await storage.ensureLayout();
    const edges: FactEdge[] = [
      {
        sourceKey: "user:balance@200",
        targetKey: "user:balance@100",
        edgeType: "supersedes",
        confidence: 1,
        createdEpoch: 1_728,
      },
      {
        sourceKey: "infra:dns_a",
        targetKey: "infra:dns_b",
        edgeType: "entity-shares",
        confidence: 0.75,
        createdEpoch: 1_728,
      },
    ];
    await storage.writeFactEdges(edges);
    const readBack = await storage.readFactEdges();
    expect(readBack).toHaveLength(2);
    expect(readBack).toEqual(expect.arrayContaining(edges));
  });

  it("collapses repeat transitions on the composite PK (idempotent upsert)", async () => {
    await storage.ensureLayout();
    const base = {
      sourceKey: "user:balance@300",
      targetKey: "user:balance@200",
      edgeType: "supersedes" as const,
    };
    await storage.writeFactEdges([{ ...base, confidence: 1, createdEpoch: 1 }]);
    await storage.writeFactEdges([{ ...base, confidence: 1, createdEpoch: 2 }]);
    await storage.writeFactEdges([{ ...base, confidence: 0.9, createdEpoch: 3 }]);
    const readBack = await storage.readFactEdges();
    expect(readBack).toHaveLength(1);
    expect(readBack[0]).toMatchObject({ confidence: 0.9, createdEpoch: 3 });
  });

  it("is additive: l3_fact_edges DDL touches no existing table", async () => {
    await storage.ensureLayout();
    await storage.writeState({ ...INITIAL_L3_STATE, bufferTokenCount: 42 });
    await storage.writeL2Chunk(
      {
        id: "chunk-legacy",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 0,
        createdAt: NOW,
        facts: [],
        dedupKeys: [],
      },
      "",
    );
    const before = {
      state: await storage.readState(),
      chunks: (await storage.listL2ChunkPaths()).length,
    };
    await storage.writeFactEdges([
      {
        sourceKey: "s:a",
        targetKey: "s:b",
        edgeType: "entity-shares",
        confidence: 1,
        createdEpoch: NOW,
      },
    ]);
    const after = {
      state: await storage.readState(),
      chunks: (await storage.listL2ChunkPaths()).length,
    };
    expect(after.state).toEqual(before.state);
    expect(after.chunks).toBe(before.chunks);
    expect(await storage.readFactEdges()).toHaveLength(1);
  });

  it("dangling endpoints are consumer no-ops, never storage errors", async () => {
    await storage.ensureLayout();
    await storage.writeFactEdges([
      {
        sourceKey: "ghost:slot@v2",
        targetKey: "ghost:slot@v1",
        edgeType: "supersedes",
        confidence: 1,
        createdEpoch: NOW,
      },
    ]);
    const readBack = await storage.readFactEdges();
    expect(readBack).toHaveLength(1);
    const boosts = applyFactEdgeBoost(
      [{ slot: "real:slot", value: "v", score: 1 }],
      readBack,
      { ...DEFAULT_HEBBIAN_CONFIG, factEdgeBoost: 0.25 },
    );
    expect(boosts.size).toBe(0);
  });
});

describe("supersedes emitter", () => {
  it("emits endpoints as slot@value state pairs oriented new→prior", async () => {
    // Pass 1: canonical fact promoted from the old value alone.
    await writeChunkWithTyped(
      "chunk-000000-old",
      [makeTypedFact({ id: "tf-old", slot: "user:account_balance", value: "500.00" })],
      NOW,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW + 500 });
    // Pass 2: a newer chunk changes the value — supersession fires.
    await writeChunkWithTyped(
      "chunk-000001-new",
      [
        makeTypedFact({
          id: "tf-new",
          slot: "user:account_balance",
          value: "750.00",
          createdAt: NOW + 1_000,
        }),
      ],
      NOW + 1_000,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW + 2_000 });
    const edges = (await storage.readFactEdges()).filter((e) => e.edgeType === "supersedes");
    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    expect(edge.sourceKey).toBe("user:account_balance@750.00");
    expect(edge.targetKey).toBe("user:account_balance@500.00");
    // Bare-slot endpoints would be a self-loop — pin the state-pair shape.
    expect(edge.sourceKey).not.toBe("user:account_balance");
    expect(edge.targetKey).not.toBe("user:account_balance");
    expect(edge.confidence).toBe(1);
  });

  it("emits exactly one edge per value transition, none on reaffirm", async () => {
    await writeChunkWithTyped(
      "chunk-000000-old",
      [makeTypedFact({ id: "tf-old", slot: "user:account_balance", value: "500.00" })],
      NOW,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW + 500 });
    await writeChunkWithTyped(
      "chunk-000001-new",
      [
        makeTypedFact({
          id: "tf-new",
          slot: "user:account_balance",
          value: "750.00",
          createdAt: NOW + 1_000,
        }),
      ],
      NOW + 1_000,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW + 2_000 });
    expect(
      (await storage.readFactEdges()).filter((e) => e.edgeType === "supersedes"),
    ).toHaveLength(1);

    // Reaffirm pass: re-observe the same latest value — no new edge of any type.
    await writeChunkWithTyped(
      "chunk-000002-reaffirm",
      [
        makeTypedFact({
          id: "tf-again",
          slot: "user:account_balance",
          value: "750.00",
          createdAt: NOW + 3_000,
        }),
      ],
      NOW + 3_000,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW + 4_000 });
    const edges = await storage.readFactEdges();
    expect(edges).toHaveLength(1);
    expect(edges[0]!.edgeType).toBe("supersedes");
  });
});

describe("emitEntityShareEdges", () => {
  it("keys endpoints by slot — typed facts carry no dedupKey (0/5,569 live)", () => {
    const facts = [
      makeLongTermTyped("infra:primary_dns", "192.168.50.128"),
      makeLongTermTyped("infra:secondary_dns", "192.168.50.128"),
    ];
    const edges = emitEntityShareEdges(facts, NOW);
    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    expect(edge.sourceKey).toBe("infra:primary_dns");
    expect(edge.targetKey).toBe("infra:secondary_dns");
    // Bare slot endpoints — no @ state pair on entity-shares edges.
    expect(edge.sourceKey).not.toContain("@");
    expect(edge.targetKey).not.toContain("@");
    expect(edge.edgeType).toBe("entity-shares");
    expect(edge.confidence).toBeCloseTo(1, 6);
  });

  it("skips singleton entity buckets", () => {
    const facts = [
      makeLongTermTyped("infra:gateway", "192.168.1.1"),
      makeLongTermTyped("web:docs_host", "docs.example.com"),
    ];
    expect(emitEntityShareEdges(facts, NOW)).toEqual([]);
  });

  it("applies the per-entity pair cap per entity, not per pair or globally", () => {
    const facts: LongTermTypedFact[] = [];
    for (let i = 0; i < 12; i++) {
      facts.push(makeLongTermTyped(`infra:node_${i}`, "192.168.9.9"));
    }
    facts.push(makeLongTermTyped("infra:extra_a", "10.0.0.5"));
    facts.push(makeLongTermTyped("infra:extra_b", "10.0.0.5"));
    const edges = emitEntityShareEdges(facts, NOW);
    const clique = edges.filter(
      (e) => e.sourceKey.startsWith("infra:node_") || e.targetKey.startsWith("infra:node_"),
    );
    expect(clique).toHaveLength(8);
    const extra = edges.filter(
      (e) => e.sourceKey.startsWith("infra:extra_") || e.targetKey.startsWith("infra:extra_"),
    );
    expect(extra).toHaveLength(1);
  });

  it("J≥0.3 gate: single-entity facts pass at J=1.0 by construction; low-overlap multi-entity pairs are rejected", () => {
    const facts = [
      makeLongTermTyped("infra:srv_a", "shared-thing alpha-one beta-two"),
      makeLongTermTyped("infra:srv_b", "shared-thing gamma-three delta-four"),
      makeLongTermTyped("infra:dns_x", "192.168.7.7"),
      makeLongTermTyped("infra:dns_y", "192.168.7.7"),
    ];
    const edges = emitEntityShareEdges(facts, NOW);
    // srv_a/srv_b share only "shared-thing": J = 1/5 = 0.2 < 0.3 → rejected.
    expect(
      edges.filter((e) => e.sourceKey.startsWith("infra:srv_") || e.targetKey.startsWith("infra:srv_")),
    ).toHaveLength(0);
    // dns_x/dns_y share their only entity: J = 1.0 → emitted.
    const dns = edges.find(
      (e) =>
        (e.sourceKey === "infra:dns_x" && e.targetKey === "infra:dns_y") ||
        (e.sourceKey === "infra:dns_y" && e.targetKey === "infra:dns_x"),
    );
    expect(dns).toBeDefined();
    expect(dns!.confidence).toBeCloseTo(1, 6);
  });

  it("ignores archived facts", () => {
    const facts = [
      makeLongTermTyped("infra:live_a", "192.168.4.4"),
      makeLongTermTyped("infra:dead_b", "192.168.4.4", { archived: true, archivedAt: NOW }),
    ];
    expect(emitEntityShareEdges(facts, NOW)).toEqual([]);
  });
});
