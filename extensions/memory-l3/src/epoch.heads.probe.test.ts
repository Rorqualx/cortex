/**
 * PROBE (throwaway) — ARCH-1 MHM partitioned epoch representatives.
 * Proves: invariant, seeding, LRU structural shield across two epochs through
 * real Storage round-trips, nearest-head topic routing, underfull-head fill.
 * Card 331b7007 · cycle 2026-09-10.
 */
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HEAD_COUNT,
  SLOTS_PER_HEAD,
  maybeWriteEpoch,
  REPRESENTATIVE_FACT_COUNT,
  seedHeads,
  updateSelectedHead,
} from "./epoch.js";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L2Fact, type L3State } from "./types.js";

let tmpRoot: string;
let storage: Storage;
let state: L3State;
const T1 = Date.UTC(2026, 8, 10, 12, 0, 0);
const T2 = Date.UTC(2026, 8, 10, 13, 0, 0);

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-epoch-probe-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  state = { ...INITIAL_L3_STATE, agentId: "j-rorqual" };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const fact = (id: string, text: string, importance: number, createdAt: number = T1): L2Fact => ({
  id,
  text,
  importance,
  createdAt,
  dedupKey: `k:${id}`,
});

const writeChunk = async (id: string, facts: L2Fact[], createdAt: number = T1): Promise<void> => {
  await storage.writeL2Chunk(
    {
      id,
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

/** Fill one epoch window (4 chunks) with the given facts, then fire the write. */
const runEpoch = async (n: number, facts: L2Fact[], now: number, headEpochs = true) => {
  const per = Math.ceil(facts.length / 4) || 1;
  for (let c = 0; c < 4; c++) {
    await writeChunk(`c${n}-${c}`, facts.slice(c * per, (c + 1) * per), now);
  }
  state.l2ChunkIndex = 4 * n;
  return maybeWriteEpoch({ storage, state, now, headEpochs });
};

const latestEpoch = async () => {
  const paths = await storage.listL3EpochPaths();
  expect(paths.length).toBeGreaterThan(0);
  return (await storage.readL3EpochAtPath(paths[paths.length - 1]))!;
};

describe("MHM head-structured epoch representatives (probe)", () => {
  it("invariant: HEAD_COUNT × SLOTS_PER_HEAD === REPRESENTATIVE_FACT_COUNT", () => {
    expect(HEAD_COUNT * SLOTS_PER_HEAD).toBe(REPRESENTATIVE_FACT_COUNT);
  });

  it("first flag-on epoch seeds 4 heads × 2 slots; representativeFacts = union (8 facts)", async () => {
    const facts = Array.from({ length: 10 }, (_, i) =>
      fact(`f${i}`, `seed fact ${i} about topic alpha`, 0.5 + i / 100),
    );
    const id = await runEpoch(1, facts, T1);
    expect(id).toBe("epoch-0000");
    const doc = await latestEpoch();
    const heads = doc.frontmatter.heads!;
    expect(heads).toHaveLength(HEAD_COUNT);
    for (const h of heads) {
      expect(h.slots.length).toBeLessThanOrEqual(SLOTS_PER_HEAD);
    }
    // Seeding from importance-sorted top-8: union is exactly the top-8 facts
    // (importance 0.5+i/100, i=0..9 → top-8 = f2..f9).
    const unionIds = heads.flatMap((h) => h.slots.map((s) => s.id)).sort();
    expect(unionIds).toEqual(["f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"]);
    expect(doc.frontmatter.representativeFacts.map((f) => f.id).sort()).toEqual(unionIds);
    // Only head 0 was updated at T1 (LRU tie-break → lowest id).
    expect(heads.filter((h) => h.lastUpdatedAt === T1)).toHaveLength(1);
    expect(heads[0].lastUpdatedAt).toBe(T1);
  });

  it("LRU: only the least-recently-updated head changes; others byte-identical (shield)", async () => {
    const topicA = Array.from({ length: 6 }, (_, i) =>
      fact(`a${i}`, `rust compiler borrow checker detail ${i}`, 0.6 + i / 50),
    );
    await runEpoch(1, topicA, T1);
    const first = (await latestEpoch()).frontmatter.heads!;

    const topicB = Array.from({ length: 6 }, (_, i) =>
      fact(`b${i}`, `manga panel layout composition rule ${i}`, 0.6 + i / 50),
    );
    await runEpoch(2, topicB, T2);
    const second = (await latestEpoch()).frontmatter.heads!;

    expect(second).toHaveLength(HEAD_COUNT);
    // Head 0 was updated at T1 → LRU picks head 1 at T2.
    const updated = second.filter((h) => h.lastUpdatedAt === T2);
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(1);
    // Shield: heads 0, 2, 3 carry identical slot objects (byte-identical JSON).
    for (const h of second) {
      if (h.id === 1) continue;
      const before = first.find((x) => x.id === h.id)!;
      expect(JSON.stringify(h.slots)).toBe(JSON.stringify(before.slots));
      expect(h.lastUpdatedAt).toBe(before.lastUpdatedAt);
    }
    // FINDING: with a 6-fact window, seeding fills only 3 heads; the empty
    // head persists until its LRU turn (up to HEAD_COUNT-1 epochs), so the
    // union is 6 — matching legacy min(8, window) count. Union ≤ 8 always.
    expect(second.reduce((n, h) => n + h.slots.length, 0)).toBe(6);
  });

  it("routing: nearest-head token-Jaccard splits a two-topic corpus across heads", async () => {
    const topicA = Array.from({ length: 6 }, (_, i) =>
      fact(`a${i}`, `docker container networking bridge mode ${i}`, 0.7),
    );
    await runEpoch(1, topicA, T1);
    const first = (await latestEpoch()).frontmatter.heads!;
    // All seed facts are topic A; head 0 got rebuilt from them at T1.

    const topicB = Array.from({ length: 6 }, (_, i) =>
      fact(`b${i}`, `postgres index btree vacuum analysis ${i}`, 0.8),
    );
    await runEpoch(2, topicB, T2);
    const second = (await latestEpoch()).frontmatter.heads!;
    const head1 = second.find((h) => h.id === 1)!;
    // Head 1 was the LRU pick; its rebuilt slots must come from the routed
    // topic-B facts (higher importance dominated the shielded A-slots in fill).
    expect(head1.slots.every((s) => s.id.startsWith("b"))).toBe(true);
    // Shielded heads still hold topic A facts.
    const shielded = second.filter((h) => h.id !== 1).flatMap((h) => h.slots);
    expect(shielded.every((s) => s.id.startsWith("a"))).toBe(true);
  });

  it("underfull head: routed < SLOTS_PER_HEAD fills from pool by importance", () => {
    const heads = seedHeads([
      fact("s0", "seed zero", 0.9),
      fact("s1", "seed one", 0.8),
      fact("s2", "seed two", 0.7),
      fact("s3", "seed three", 0.6),
      fact("s4", "seed four", 0.5),
      fact("s5", "seed five", 0.4),
      fact("s6", "seed six", 0.3),
      fact("s7", "seed seven", 0.2),
    ]);
    const routed = [fact("r0", "lone routed fact", 0.55)];
    const pool = [fact("p0", "pool low", 0.1), fact("p1", "pool high", 0.95)];
    const updated = updateSelectedHead(heads[0], routed, pool, T2);
    expect(updated.slots.map((s) => s.id)).toEqual(["r0", "p1"]); // importance order
    expect(updated.lastUpdatedAt).toBe(T2);
    expect(updated.id).toBe(heads[0].id);
  });

  it("flag off → no heads field (legacy byte-shape preserved)", async () => {
    const facts = Array.from({ length: 6 }, (_, i) => fact(`f${i}`, `plain fact ${i}`, 0.5));
    await runEpoch(1, facts, T1, false);
    const doc = await latestEpoch();
    expect(doc.frontmatter.heads).toBeUndefined();
    expect(doc.frontmatter.representativeFacts.map((f) => f.id)).toEqual([
      "f0", "f1", "f2", "f3", "f4", "f5",
    ]);
  });
});
