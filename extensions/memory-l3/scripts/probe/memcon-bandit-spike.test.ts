/**
 * PROBE (throwaway) — ARCH-2 MemCon Bandit Wrapper feasibility spike.
 * Card 9b9efeea. Validates the 2026-11-07 plan's three probe questions:
 *   (i)   temp l3.sqlite: boot creates both tables idempotently;
 *         event+outcome round-trip; in-memory join matches report aggregation
 *   (ii)  pinned by code read: terminal wait site has entry.requesterSessionKey;
 *         engine assemble() receives sessionKey → join key = session_key
 *   (iii) 2-event engine fixture proving the non-fatal wrapper shape
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HierarchicalL3Engine } from "../../src/engine.js";
import type { LlmCaller } from "../../src/llm.js";
import { retrieveTopK } from "../../src/retrieval.js";
import { Storage } from "../../src/storage.js";

const caller: LlmCaller = async () => "{}";

function findDbFile(root: string): string {
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (/\.sqlite3?$/.test(name)) return p;
    }
    return null;
  };
  const hit = walk(root);
  if (!hit) throw new Error("no sqlite file under " + root);
  return hit;
}

/** Storage subclass whose telemetry lane throws — proves non-fatal shape. */
class ThrowingTelemetryStorage extends Storage {
  async recordRetrievalEvent(): Promise<void> {
    throw new Error("telemetry down");
  }
}

async function seedFact(storage: Storage): Promise<void> {
  const now = Date.now();
  await storage.writeLongTerm(
    {
      version: 1,
      agentId: "probe-agent",
      lastConsolidatedAt: now,
      facts: [
        {
          id: "lt-probe0001",
          text: "The greenhouse is dug 2.4 meters deep with a rammed-earth north wall",
          dedupKey: "greenhouse-depth",
          importance: 0.95,
          firstSeenAt: now,
          lastConfirmedAt: now,
          recallCount: 3,
          sourceChunkIds: ["chunk-000001-aaaaaaaa"],
          archived: false,
          archivedAt: null,
          supersededBy: null,
          status: "confirmed",
        },
      ],
    },
    "## Facts\n- The greenhouse is dug 2.4 meters deep\n",
  );
  // retrieveTopK early-returns {facts: []} when listL2ChunkPaths() is empty
  // (probe finding: longterm/typed tiers are unreachable on a chunkless
  // store) — so seed one minimal L2 chunk carrying the same prose fact.
  await storage.writeL2Chunk(
    {
      id: "chunk-000001-aaaaaaaa",
      agentId: "probe-agent",
      startTurnIndex: 0,
      endTurnIndex: 2,
      createdAt: now,
      facts: [
        {
          id: "fact-probe0001",
          text: "The greenhouse is dug 2.4 meters deep with a rammed-earth north wall",
          importance: 0.95,
          createdAt: now,
          dedupKey: "greenhouse-depth",
          certainty: "confirmed",
        },
      ],
      typedFacts: [],
      dedupKeys: ["greenhouse-depth"],
      contextWindow: 2,
      deterministic: {
        toolNames: [],
        filePaths: [],
        turnCount: 2,
        timeSpan: { start: now, end: now + 1000 },
      },
    },
    "## Facts\n- The greenhouse is dug 2.4 meters deep\n\n## Conversation\n2 message(s) compacted.\n",
  );
}

describe("memcon bandit spike", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "l3-memcon-spike-"));
  });

  afterAll(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("(i) storage: idempotent boot creates both tables; round-trip; join math", async () => {
    const storage = new Storage(root);
    await storage.ensureLayout();
    // second boot on same root — SCHEMA_SQL must be idempotent
    const storage2 = new Storage(root);
    await storage2.ensureLayout();

    const dbPath = findDbFile(root);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    db.close();
    expect(tables).toContain("retrieval_events");
    expect(tables).toContain("retrieval_outcomes");

    // two events: one joinable (has sessionKey + matching outcome), one not
    await storage.recordRetrievalEvent({
      sessionId: "sess-1",
      sessionKey: "telegram:probe:123",
      intentClass: "factual",
      preset: 5,
      topK: 1,
      factIds: ["chunk-000001-aaaaaaaa"],
      estTokens: 120,
      source: "engine-fresh",
    });
    await storage.recordRetrievalEvent({
      sessionId: "sess-2",
      sessionKey: null,
      intentClass: "synthesis",
      preset: 4,
      topK: 2,
      factIds: ["a", "b"],
      estTokens: 80,
      source: "engine-fresh",
    });
    await storage.recordRetrievalOutcome({ sessionKey: "telegram:probe:123", ok: true, detail: "success" });

    const events = await storage.listRetrievalEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.factIds).toEqual(["chunk-000001-aaaaaaaa"]);
    expect(events[0]!.sessionKey).toBe("telegram:probe:123");
    expect(events[1]!.sessionKey).toBeNull();

    const outcomes = await storage.listRetrievalOutcomes();
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(true);
    expect(outcomes[0]!.sessionKey).toBe("telegram:probe:123");

    // in-memory join + aggregation (report-script core, per intentClass×preset bucket)
    const byKey = new Map(outcomes.map((o) => [o.sessionKey, o]));
    const buckets = new Map<string, { n: number; joined: number; okCount: number }>();
    let joinedTotal = 0;
    for (const e of events) {
      const bkey = `${e.intentClass}×${e.preset}`;
      const b = buckets.get(bkey) ?? { n: 0, joined: 0, okCount: 0 };
      b.n += 1;
      const outcome = e.sessionKey ? byKey.get(e.sessionKey) : undefined;
      if (outcome) {
        b.joined += 1;
        joinedTotal += 1;
        if (outcome.ok) b.okCount += 1;
      }
      buckets.set(bkey, b);
    }
    expect(joinedTotal).toBe(1);
    const factual = buckets.get("factual×5")!;
    expect(factual).toEqual({ n: 1, joined: 1, okCount: 1 });
    expect(factual.joined / factual.n).toBe(1);
    const unjoinedRate = 1 - joinedTotal / events.length;
    expect(unjoinedRate).toBeCloseTo(0.5);

    // prune lane
    const pruned = await storage.pruneRetrievalEvents(Date.now() + 1000);
    expect(pruned).toBe(2);
    expect(await storage.listRetrievalEvents()).toHaveLength(0);
  });

  it("(iii) engine: events recorded on assemble; telemetry failure is non-fatal", async () => {
    // healthy storage: two assembles over the seeded fact → 2 fresh-lane events
    const healthy = new Storage(root);
    await healthy.ensureLayout();
    await seedFact(healthy);
    // direct probe: does the seeded fact surface in raw retrieval?
    const seeded = await healthy.readLongTerm();
    console.log("[spike] seeded longterm facts:", seeded.facts.length, seeded.facts.map((f) => f.dedupKey));
    const topDirect = await retrieveTopK({ query: "how deep is the greenhouse?", storage: healthy, topK: 5 });
    console.log(
      "[spike] direct retrieveTopK facts:",
      topDirect.facts.length,
      topDirect.facts.map((f) => ({ tier: (f as any).tier, chunkId: (f as any).chunkId, keys: Object.keys(f).slice(0, 8) })),
    );
    const engine = new HierarchicalL3Engine(healthy, { caller, agentDir: root });
    await engine.bootstrap();

    const r1 = await engine.assemble({
      sessionId: "sess-parent-1",
      sessionKey: "telegram:probe:123",
      messages: [],
      prompt: "how deep is the greenhouse?",
    });
    expect(r1.systemPromptAddition).toBeDefined();
    const r2 = await engine.assemble({
      sessionId: "sess-parent-1",
      sessionKey: "telegram:probe:123",
      messages: [],
      prompt: "how deep is the greenhouse?",
    });
    expect(r2.systemPromptAddition).toBeDefined();

    const events = await healthy.listRetrievalEvents();
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every((e) => e.sessionKey === "telegram:probe:123")).toBe(true);
    expect(events.every((e) => e.source.startsWith("engine-"))).toBe(true);
    expect(events[0]!.intentClass).toBeTruthy();

    // throwing storage: assemble must still return the section (non-fatal shape)
    const throwing = new ThrowingTelemetryStorage(root);
    await throwing.ensureLayout();
    await seedFact(throwing);
    const engine2 = new HierarchicalL3Engine(throwing, { caller, agentDir: root });
    await engine2.bootstrap();
    const r3 = await engine2.assemble({
      sessionId: "sess-parent-2",
      sessionKey: "telegram:probe:456",
      messages: [],
      prompt: "how deep is the greenhouse?",
    });
    expect(r3.systemPromptAddition).toBeDefined();
  });
});
