import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aggregateCandidates,
  type ConsolidationConfig,
  DEFAULT_CONSOLIDATION_CONFIG,
  passesPromotionThresholds,
  runVerificationGate,
  selectPromotable,
} from "./consolidation.js";
import { consolidateLongTermTyped } from "./longterm-typed.js";
import { Storage } from "./storage.js";
import type { L2Fact, TypedFact } from "./types.js";

const NOW = Date.UTC(2026, 4, 6, 12, 0, 0);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let tmpRoot: string;
let storage: Storage;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-consolidation-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const fact = (
  id: string,
  text: string,
  importance: number,
  createdAt: number,
  dedupKey: string,
): L2Fact => ({ id, text, importance, createdAt, dedupKey });

const writeChunk = async (id: string, facts: L2Fact[], createdAt: number = NOW): Promise<void> => {
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

describe("aggregateCandidates", () => {
  it("returns [] when no chunks exist", async () => {
    const result = await aggregateCandidates(storage);
    expect(result).toEqual([]);
  });

  it("groups facts by dedupKey across chunks", async () => {
    await writeChunk(
      "chunk-000000-a",
      [fact("f1", "tabs", 0.7, NOW - 5 * MS_PER_DAY, "user_pref:tabs")],
      NOW - 5 * MS_PER_DAY,
    );
    await writeChunk(
      "chunk-000001-b",
      [fact("f2", "tabs preferred", 0.8, NOW - Number(MS_PER_DAY), "user_pref:tabs")],
      NOW - Number(MS_PER_DAY),
    );
    const result = await aggregateCandidates(storage);
    expect(result).toHaveLength(1);
    const c = result[0]!;
    expect(c.dedupKey).toBe("user_pref:tabs");
    expect(c.recallCount).toBe(2);
    expect(c.firstSeenAt).toBe(NOW - 5 * MS_PER_DAY);
    expect(c.lastConfirmedAt).toBe(NOW - Number(MS_PER_DAY));
    expect(c.sourceChunkIds).toEqual(["chunk-000000-a", "chunk-000001-b"]);
  });

  it("picks higher-importance text as canonical", async () => {
    await writeChunk(
      "chunk-000000-a",
      [fact("f1", "weak phrasing", 0.4, NOW - 2 * MS_PER_DAY, "k:1")],
      NOW - 2 * MS_PER_DAY,
    );
    await writeChunk(
      "chunk-000001-b",
      [fact("f2", "strong phrasing", 0.9, NOW - Number(MS_PER_DAY), "k:1")],
      NOW - Number(MS_PER_DAY),
    );
    const c = (await aggregateCandidates(storage))[0]!;
    expect(c.text).toBe("strong phrasing");
    expect(c.importance).toBe(0.9);
  });

  it("breaks importance ties by recency", async () => {
    await writeChunk(
      "chunk-000000-a",
      [fact("f1", "old phrasing", 0.7, NOW - 5 * MS_PER_DAY, "k:1")],
      NOW - 5 * MS_PER_DAY,
    );
    await writeChunk(
      "chunk-000001-b",
      [fact("f2", "newer phrasing", 0.7, NOW - Number(MS_PER_DAY), "k:1")],
      NOW - Number(MS_PER_DAY),
    );
    const c = (await aggregateCandidates(storage))[0]!;
    expect(c.text).toBe("newer phrasing");
  });

  it("deduplicates sourceChunkIds when a chunk emits the same dedupKey twice", async () => {
    // Should not happen in practice (within-chunk dedup catches it) but verify
    // the aggregator is robust.
    await writeChunk("chunk-x", [
      fact("f1", "a", 0.5, NOW, "k:1"),
      fact("f2", "a", 0.5, NOW, "k:1"),
    ]);
    const c = (await aggregateCandidates(storage))[0]!;
    expect(c.sourceChunkIds).toEqual(["chunk-x"]);
  });
});

describe("passesPromotionThresholds", () => {
  const baseCfg: ConsolidationConfig = DEFAULT_CONSOLIDATION_CONFIG;

  it("rejects single-recall low-importance facts", () => {
    expect(
      passesPromotionThresholds(
        {
          dedupKey: "k:1",
          text: "weak",
          importance: 0.5,
          recallCount: 1,
          firstSeenAt: NOW,
          lastConfirmedAt: NOW,
          sourceChunkIds: ["chunk-1"],
          certainty: "confirmed",
        },
        baseCfg,
      ),
    ).toBe(false);
  });

  it("accepts a single-recall fact at high-importance shortcut", () => {
    expect(
      passesPromotionThresholds(
        {
          dedupKey: "k:1",
          text: "strong",
          importance: 0.9,
          recallCount: 1,
          firstSeenAt: NOW,
          lastConfirmedAt: NOW,
          sourceChunkIds: ["chunk-1"],
          certainty: "confirmed",
        },
        baseCfg,
      ),
    ).toBe(true);
  });

  it("rejects when recall count is met but dayspan is too small", () => {
    expect(
      passesPromotionThresholds(
        {
          dedupKey: "k:1",
          text: "shouldering through",
          importance: 0.7,
          recallCount: 3,
          firstSeenAt: NOW - Number(MS_PER_DAY), // only 1-day span
          lastConfirmedAt: NOW,
          sourceChunkIds: ["chunk-a", "chunk-b", "chunk-c"],
          certainty: "confirmed",
        },
        baseCfg,
      ),
    ).toBe(false);
  });

  it("accepts when recall + dayspan + importance all clear thresholds", () => {
    expect(
      passesPromotionThresholds(
        {
          dedupKey: "k:1",
          text: "evergreen",
          importance: 0.7,
          recallCount: 3,
          firstSeenAt: NOW - 5 * MS_PER_DAY,
          lastConfirmedAt: NOW,
          sourceChunkIds: ["chunk-a", "chunk-b", "chunk-c"],
          certainty: "confirmed",
        },
        baseCfg,
      ),
    ).toBe(true);
  });

  it("denies the high-importance shortcut to tentative facts", () => {
    expect(
      passesPromotionThresholds(
        {
          dedupKey: "k:1",
          text: "speculative one-shot",
          importance: 0.9,
          recallCount: 1,
          firstSeenAt: NOW,
          lastConfirmedAt: NOW,
          sourceChunkIds: ["chunk-1"],
          certainty: "tentative",
        },
        baseCfg,
      ),
    ).toBe(false);
  });

  it("holds tentative facts to the higher recall and dayspan bars", () => {
    const tentative = (recallCount: number, spanDays: number) =>
      passesPromotionThresholds(
        {
          dedupKey: "k:1",
          text: "tentative",
          importance: 0.7,
          recallCount,
          firstSeenAt: NOW - spanDays * MS_PER_DAY,
          lastConfirmedAt: NOW,
          sourceChunkIds: ["a", "b", "c"],
          certainty: "tentative",
        },
        baseCfg,
      );
    // Clears the confirmed bar (2 recalls / 3 days) but not the tentative bar.
    expect(tentative(2, 4)).toBe(false);
    expect(tentative(3, 4)).toBe(false);
    expect(tentative(3, 6)).toBe(true);
  });

  it("rejects when importance is below threshold even with high recall", () => {
    expect(
      passesPromotionThresholds(
        {
          dedupKey: "k:1",
          text: "low signal",
          importance: 0.4,
          recallCount: 5,
          firstSeenAt: NOW - 10 * MS_PER_DAY,
          lastConfirmedAt: NOW,
          sourceChunkIds: ["a", "b", "c", "d", "e"],
          certainty: "confirmed",
        },
        baseCfg,
      ),
    ).toBe(false);
  });
});

describe("selectPromotable", () => {
  it("returns only candidates that pass thresholds", async () => {
    // High-importance shortcut: single occurrence, importance 0.9
    await writeChunk(
      "chunk-000000-a",
      [fact("f1", "identity fact", 0.9, NOW, "user:identity")],
      NOW,
    );
    // Below-threshold: single occurrence, importance 0.5
    await writeChunk("chunk-000001-b", [fact("f2", "trivia", 0.5, NOW, "trivia:1")], NOW);
    // Recurring + dayspan + importance — should pass
    await writeChunk(
      "chunk-000002-c",
      [fact("f3", "tabs", 0.7, NOW - 5 * MS_PER_DAY, "user_pref:tabs")],
      NOW - 5 * MS_PER_DAY,
    );
    await writeChunk("chunk-000003-d", [fact("f4", "tabs again", 0.7, NOW, "user_pref:tabs")], NOW);

    const result = await selectPromotable(storage);
    const keys = result.map((r) => r.dedupKey).toSorted();
    expect(keys).toEqual(["user:identity", "user_pref:tabs"]);
  });
});

// ---------------------------------------------------------------------------
// ConvMemory v3 safety invariants (QW-2)
// Formal contracts that pin consolidation behavior. These are pure assertions —
// no production code changes required. They backstop QW-1 (bi-temporal fields),
// AR-1 (cross-address erase), and all future consolidation algorithm changes.
// ---------------------------------------------------------------------------

const typedTmp = () => ({
  root: mkdtempSync(path.join(os.tmpdir(), "memory-l3-cons-inv-")),
  storage: null as Storage | null,
});

const typedSetup = () => {
  const t = typedTmp();
  t.storage = new Storage(path.join(t.root, ".openclaw", "l3"));
  return t;
};

const typedTeardown = (t: ReturnType<typeof typedTmp>) => {
  rmSync(t.root, { recursive: true, force: true });
};

const writeTypedChunk = async (
  s: Storage,
  chunkId: string,
  typedFacts: TypedFact[],
  createdAt: number,
): Promise<void> => {
  await s.writeL2Chunk(
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
};

describe("ConvMemory v3 safety invariants", () => {
  // ── C1: Supersession monotonicity ──
  // Within a single LongTermTypedFact, history entries must have
  // non-decreasing supersededAt timestamps — the older value was
  // always superseded before (or at the same time as) a newer one.
  describe("C1: supersession monotonicity", () => {
    it("history entries have non-decreasing supersededAt timestamps", async () => {
      const t = typedSetup();
      try {
        // Chunk 1: balance = 100
        await writeTypedChunk(
          t.storage!,
          "chunk-1",
          [
            {
              id: "t1",
              slot: "fin:balance",
              value: "100",
              sourceSpan: "x",
              unit: "USD",
              confidence: 0.9,
              createdAt: NOW - 10 * MS_PER_DAY,
            },
          ],
          NOW - 10 * MS_PER_DAY,
        );
        await consolidateLongTermTyped({
          storage: t.storage!,
          agentId: "test",
          now: NOW - 10 * MS_PER_DAY,
        });

        // Chunk 2: balance = 200
        await writeTypedChunk(
          t.storage!,
          "chunk-2",
          [
            {
              id: "t2",
              slot: "fin:balance",
              value: "200",
              sourceSpan: "x",
              unit: "USD",
              confidence: 0.9,
              createdAt: NOW - 5 * MS_PER_DAY,
            },
          ],
          NOW - 5 * MS_PER_DAY,
        );
        await consolidateLongTermTyped({
          storage: t.storage!,
          agentId: "test",
          now: NOW - 5 * MS_PER_DAY,
        });

        // Chunk 3: balance = 300
        await writeTypedChunk(
          t.storage!,
          "chunk-3",
          [
            {
              id: "t3",
              slot: "fin:balance",
              value: "300",
              sourceSpan: "x",
              unit: "USD",
              confidence: 0.9,
              createdAt: NOW,
            },
          ],
          NOW,
        );
        await consolidateLongTermTyped({ storage: t.storage!, agentId: "test", now: NOW });

        const ltt = await t.storage!.readLongTermTyped();
        const fact = ltt.facts.find((f) => f.slot === "fin:balance")!;
        expect(fact).toBeDefined();
        expect(fact.value).toBe("300");
        expect(fact.history.length).toBeGreaterThanOrEqual(2);

        // Invariant: supersededAt timestamps are non-decreasing
        for (let i = 1; i < fact.history.length; i++) {
          expect(fact.history[i]?.supersededAt).toBeGreaterThanOrEqual(
            fact.history[i - 1]!.supersededAt,
          );
        }
      } finally {
        typedTeardown(t);
      }
    });
  });

  // ── C2: No orphan supersession ──
  // Every value in history[] was the canonical value before it was
  // superseded. No value appears in history without having lived as
  // the active value at some point.
  describe("C2: no orphan supersession", () => {
    it("every history value was once canonical", async () => {
      const t = typedSetup();
      try {
        await writeTypedChunk(
          t.storage!,
          "chunk-1",
          [
            {
              id: "t1",
              slot: "user:status",
              value: "active",
              sourceSpan: "x",
              unit: null,
              confidence: 0.9,
              createdAt: NOW - 10 * MS_PER_DAY,
            },
          ],
          NOW - 10 * MS_PER_DAY,
        );
        await consolidateLongTermTyped({
          storage: t.storage!,
          agentId: "test",
          now: NOW - 10 * MS_PER_DAY,
        });

        // Current canonical value at this point is "active"
        const afterFirst = await t.storage!.readLongTermTyped();
        expect(afterFirst.facts[0]?.value).toBe("active");
        expect(afterFirst.facts[0]?.history).toEqual([]);

        await writeTypedChunk(
          t.storage!,
          "chunk-2",
          [
            {
              id: "t2",
              slot: "user:status",
              value: "inactive",
              sourceSpan: "x",
              unit: null,
              confidence: 0.9,
              createdAt: NOW,
            },
          ],
          NOW,
        );
        await consolidateLongTermTyped({ storage: t.storage!, agentId: "test", now: NOW });

        const afterSecond = await t.storage!.readLongTermTyped();
        const fact = afterSecond.facts.find((f) => f.slot === "user:status")!;
        expect(fact.value).toBe("inactive");

        // C2 invariant: every history value was once the canonical value
        // The only history entry should be "active" — which was indeed the
        // canonical value after the first pass.
        expect(fact.history.length).toBe(1);
        expect(fact.history[0]?.value).toBe("active");
      } finally {
        typedTeardown(t);
      }
    });

    it("history value never equals current canonical value", async () => {
      const t = typedSetup();
      try {
        await writeTypedChunk(
          t.storage!,
          "chunk-1",
          [
            {
              id: "t1",
              slot: "cfg:theme",
              value: "dark",
              sourceSpan: "x",
              unit: null,
              confidence: 0.9,
              createdAt: NOW - 5 * MS_PER_DAY,
            },
          ],
          NOW - 5 * MS_PER_DAY,
        );
        await writeTypedChunk(
          t.storage!,
          "chunk-2",
          [
            {
              id: "t2",
              slot: "cfg:theme",
              value: "light",
              sourceSpan: "x",
              unit: null,
              confidence: 0.9,
              createdAt: NOW,
            },
          ],
          NOW,
        );
        await consolidateLongTermTyped({ storage: t.storage!, agentId: "test", now: NOW });

        const ltt = await t.storage!.readLongTermTyped();
        const fact = ltt.facts[0]!;

        // Invariant: no history entry holds the same value as the current canonical
        for (const h of fact.history) {
          expect(h.value).not.toBe(fact.value);
        }
      } finally {
        typedTeardown(t);
      }
    });
  });

  // ── C3: Archive exclusivity ──
  // Archived facts must never appear in active retrieval results.
  describe("C3: archive exclusivity", () => {
    it("archived facts are excluded from active count", async () => {
      const t = typedSetup();
      try {
        await writeTypedChunk(
          t.storage!,
          "chunk-stale",
          [
            {
              id: "t1",
              slot: "old:data",
              value: "stale",
              sourceSpan: "x",
              unit: null,
              confidence: 0.5,
              createdAt: NOW - 90 * MS_PER_DAY,
            },
          ],
          NOW - 90 * MS_PER_DAY,
        );
        await consolidateLongTermTyped({
          storage: t.storage!,
          agentId: "test",
          now: NOW - 90 * MS_PER_DAY,
        });

        // Clear all L2 chunks so the fact has no confirming source
        for (const token of await t.storage!.listL2ChunkPaths()) {
          await t.storage!.deleteL2Chunk(token);
        }

        const out = await consolidateLongTermTyped({
          storage: t.storage!,
          agentId: "test",
          now: NOW,
          config: {
            maxAgeWithoutConfirmMs: 60 * MS_PER_DAY,
            minRecallCount: 1,
            maxPromotePerEpoch: 30,
          },
        });
        expect(out.archivedCount).toBe(1);

        const ltt = await t.storage!.readLongTermTyped();
        const archived = ltt.facts.filter((f) => f.archived);
        const active = ltt.facts.filter((f) => !f.archived);

        // C3 invariant: archived count matches output
        expect(archived.length).toBe(out.archivedCount);
        // C3 invariant: active count excludes all archived facts
        expect(active.length).toBe(out.activeCount);
        expect(active.length + archived.length).toBe(ltt.facts.length);
        // C3 invariant: no fact is both archived and in active retrieval
        // (archived facts carry archived=true; active retrieval skips them)
        for (const a of archived) {
          expect(a.archived).toBe(true);
          expect(a.archivedAt).not.toBeNull();
        }
      } finally {
        typedTeardown(t);
      }
    });
  });

  // ── C4: Promotion floor ──
  // No fact with importance strictly below minImportance should ever
  // pass promotion thresholds, regardless of recall count or dayspan.
  describe("C4: promotion floor", () => {
    it("rejects facts below minImportance even with max recall and dayspan", () => {
      const veryLow = {
        dedupKey: "k:low",
        text: "barely there",
        importance: DEFAULT_CONSOLIDATION_CONFIG.minImportance - 0.01,
        recallCount: 100,
        firstSeenAt: NOW - 365 * MS_PER_DAY,
        lastConfirmedAt: NOW,
        sourceChunkIds: Array.from({ length: 100 }, (_, i) => `chunk-${i}`),
        certainty: "confirmed" as const,
      };
      expect(passesPromotionThresholds(veryLow)).toBe(false);
    });

    it("rejects facts at exactly zero importance", () => {
      const zero = {
        dedupKey: "k:zero",
        text: "zero importance",
        importance: 0,
        recallCount: 10,
        firstSeenAt: NOW - 100 * MS_PER_DAY,
        lastConfirmedAt: NOW,
        sourceChunkIds: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
        certainty: "confirmed" as const,
      };
      expect(passesPromotionThresholds(zero)).toBe(false);
    });

    it("accepts facts at exactly minImportance with sufficient recall+dayspan", () => {
      const atFloor = {
        dedupKey: "k:floor",
        text: "at floor",
        importance: DEFAULT_CONSOLIDATION_CONFIG.minImportance,
        recallCount: DEFAULT_CONSOLIDATION_CONFIG.minRecallCount,
        firstSeenAt: NOW - DEFAULT_CONSOLIDATION_CONFIG.minDayspanMs - 1,
        lastConfirmedAt: NOW,
        sourceChunkIds: ["a", "b"],
        certainty: "confirmed" as const,
      };
      expect(passesPromotionThresholds(atFloor)).toBe(true);
    });
  });

  // ── C5: Tentative isolation ──
  // Tentative-only facts must never use the high-importance passthrough
  // shortcut. A tentative fact, even at importance 0.99, must earn
  // promotion through recall + dayspan.
  describe("C5: tentative isolation", () => {
    it("tentative facts never take high-importance passthrough at any importance", () => {
      // Even at 0.99 importance (above the 0.85 shortcut threshold),
      // a tentative single-occurrence fact must be denied.
      for (const importance of [0.85, 0.9, 0.95, 0.99]) {
        expect(
          passesPromotionThresholds({
            dedupKey: "k:t",
            text: "speculative",
            importance,
            recallCount: 1,
            firstSeenAt: NOW,
            lastConfirmedAt: NOW,
            sourceChunkIds: ["chunk-1"],
            certainty: "tentative",
          }),
        ).toBe(false);
      }
    });

    it("instructional facts do take the shortcut (strongest certainty)", () => {
      expect(
        passesPromotionThresholds({
          dedupKey: "k:i",
          text: "instruction",
          importance: 0.9,
          recallCount: 1,
          firstSeenAt: NOW,
          lastConfirmedAt: NOW,
          sourceChunkIds: ["chunk-1"],
          certainty: "instructional",
        }),
      ).toBe(true);
    });
  });

  // ── C6: Idempotent epoch ──
  // Running consolidation twice on the same input must yield the same
  // canonical state: identical slots, values, confidence, recall counts,
  // and history lengths.
  describe("C6: idempotent epoch", () => {
    it("double consolidation on same L2 state yields identical typed facts", async () => {
      const t = typedSetup();
      try {
        await writeTypedChunk(
          t.storage!,
          "chunk-a",
          [
            {
              id: "t1",
              slot: "user:name",
              value: "Alice",
              sourceSpan: "x",
              unit: null,
              confidence: 0.9,
              createdAt: NOW - 5 * MS_PER_DAY,
            },
            {
              id: "t2",
              slot: "user:age",
              value: "30",
              sourceSpan: "x",
              unit: "years",
              confidence: 0.8,
              createdAt: NOW - 5 * MS_PER_DAY,
            },
          ],
          NOW - 5 * MS_PER_DAY,
        );
        await writeTypedChunk(
          t.storage!,
          "chunk-b",
          [
            {
              id: "t3",
              slot: "user:name",
              value: "Alice",
              sourceSpan: "x",
              unit: null,
              confidence: 0.95,
              createdAt: NOW - 2 * MS_PER_DAY,
            },
            {
              id: "t4",
              slot: "user:email",
              value: "alice@example.com",
              sourceSpan: "x",
              unit: null,
              confidence: 0.9,
              createdAt: NOW - 2 * MS_PER_DAY,
            },
          ],
          NOW - 2 * MS_PER_DAY,
        );

        // First pass
        await consolidateLongTermTyped({ storage: t.storage!, agentId: "test", now: NOW });
        const ltt1 = await t.storage!.readLongTermTyped();

        // Second pass — same L2 chunks, no changes
        await consolidateLongTermTyped({ storage: t.storage!, agentId: "test", now: NOW });
        const ltt2 = await t.storage!.readLongTermTyped();

        // C6 invariant: same number of facts
        expect(ltt2.facts.length).toBe(ltt1.facts.length);

        // C6 invariant: same set of slots in the same order
        expect(ltt2.facts.map((f) => f.slot)).toEqual(ltt1.facts.map((f) => f.slot));

        // C6 invariant: each fact's value, confidence, recall, and history are identical
        // (pass metadata like promoted/reaffirmed counts naturally differ — what
        // matters is the stored canonical state)
        for (let i = 0; i < ltt1.facts.length; i++) {
          const a = ltt1.facts[i]!;
          const b = ltt2.facts[i]!;
          expect(b.slot).toBe(a.slot);
          expect(b.value).toBe(a.value);
          expect(b.confidence).toBe(a.confidence);
          expect(b.recallCount).toBe(a.recallCount);
          expect(b.history).toEqual(a.history);
          expect(b.archived).toBe(a.archived);
        }
      } finally {
        typedTeardown(t);
      }
    });

    it("double aggregation on same L2 state yields identical candidates", async () => {
      await writeChunk(
        "chunk-000000-a",
        [fact("f1", "evergreen fact", 0.8, NOW - 5 * MS_PER_DAY, "topic:evergreen")],
        NOW - 5 * MS_PER_DAY,
      );
      await writeChunk(
        "chunk-000001-b",
        [fact("f2", "evergreen again", 0.7, NOW, "topic:evergreen")],
        NOW,
      );

      const first = await aggregateCandidates(storage);
      const second = await aggregateCandidates(storage);

      // C6 invariant: aggregation is deterministic
      expect(second).toEqual(first);
    });
  });

  describe("runVerificationGate", () => {
    it("passes all candidates when verification is disabled", async () => {
      await writeChunk("chunk-000000-a", [fact("f1", "test fact", 0.9, NOW, "topic:test")], NOW);
      const candidates = await selectPromotable(storage, {
        ...DEFAULT_CONSOLIDATION_CONFIG,
        minRecallCount: 1,
        minDayspanMs: 0,
      });
      const result = await runVerificationGate({
        candidates,
        storage,
        priorFacts: new Map(),
        llm: null,
        config: {
          enabled: false,
          thresholds: { coverage: 0.7, preservation: 0.7, faithfulness: 0.7 },
        },
      });
      expect(result.passed.length).toBe(1);
      expect(result.blockedCount).toBe(0);
    });

    it("passes all candidates when LLM is unavailable", async () => {
      await writeChunk("chunk-000000-a", [fact("f1", "test fact", 0.9, NOW, "topic:test")], NOW);
      const candidates = await selectPromotable(storage, {
        ...DEFAULT_CONSOLIDATION_CONFIG,
        minRecallCount: 1,
        minDayspanMs: 0,
      });
      const result = await runVerificationGate({
        candidates,
        storage,
        priorFacts: new Map(),
        llm: null,
        config: {
          enabled: true,
          thresholds: { coverage: 0.7, preservation: 0.7, faithfulness: 0.7 },
        },
      });
      expect(result.passed.length).toBe(1);
      expect(result.blockedCount).toBe(0);
    });

    it("blocks a candidate whose temporal score falls below threshold", async () => {
      await writeChunk(
        "chunk-000000-a",
        [fact("f1", "trip on 2026-05-01", 0.9, NOW, "topic:trip")],
        NOW,
      );
      const candidates = await selectPromotable(storage, {
        ...DEFAULT_CONSOLIDATION_CONFIG,
        minRecallCount: 1,
        minDayspanMs: 0,
      });
      const llm = (async () =>
        JSON.stringify({
          results: [{ coverage: 1, preservation: 1, faithfulness: 1, temporal: 0.2 }],
        })) as unknown as import("./llm.js").LlmCaller;
      const result = await runVerificationGate({
        candidates,
        storage,
        priorFacts: new Map(),
        llm,
        config: {
          enabled: true,
          thresholds: { coverage: 0.7, preservation: 0.7, faithfulness: 0.7, temporal: 0.7 },
        },
      });
      expect(result.passed.length).toBe(0);
      expect(result.blockedCount).toBe(1);
    });

    it("tolerates absent temporal score (legacy verifier responses pass)", async () => {
      await writeChunk("chunk-000000-a", [fact("f1", "test fact", 0.9, NOW, "topic:test")], NOW);
      const candidates = await selectPromotable(storage, {
        ...DEFAULT_CONSOLIDATION_CONFIG,
        minRecallCount: 1,
        minDayspanMs: 0,
      });
      const llm = (async () =>
        JSON.stringify({
          results: [{ coverage: 1, preservation: 1, faithfulness: 1 }],
        })) as unknown as import("./llm.js").LlmCaller;
      const result = await runVerificationGate({
        candidates,
        storage,
        priorFacts: new Map(),
        llm,
        config: {
          enabled: true,
          thresholds: { coverage: 0.7, preservation: 0.7, faithfulness: 0.7 },
        },
      });
      expect(result.passed.length).toBe(1);
      expect(result.blockedCount).toBe(0);
    });
  });
});
