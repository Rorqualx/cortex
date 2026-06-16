import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aggregateCandidates,
  type ConsolidationConfig,
  DEFAULT_CONSOLIDATION_CONFIG,
  passesPromotionThresholds,
  selectPromotable,
} from "./consolidation.js";
import { Storage } from "./storage.js";
import type { L2Fact } from "./types.js";

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
    const c = result[0];
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
    const [c] = await aggregateCandidates(storage);
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
    const [c] = await aggregateCandidates(storage);
    expect(c.text).toBe("newer phrasing");
  });

  it("deduplicates sourceChunkIds when a chunk emits the same dedupKey twice", async () => {
    // Should not happen in practice (within-chunk dedup catches it) but verify
    // the aggregator is robust.
    await writeChunk("chunk-x", [
      fact("f1", "a", 0.5, NOW, "k:1"),
      fact("f2", "a", 0.5, NOW, "k:1"),
    ]);
    const [c] = await aggregateCandidates(storage);
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
