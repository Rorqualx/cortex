import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeRetrievalUseStoreForTest,
  recordRetrievalUses,
  recordSessionOutcome,
  summarizeChunkUse,
  summarizeChunkUtility,
} from "./retrieval-use-store.js";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-retrieval-use-"));
});

afterEach(() => {
  closeRetrievalUseStoreForTest();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("retrieval-use-store", () => {
  it("buckets repeated injections of one chunk into a single day counter", () => {
    for (let i = 0; i < 3; i++) {
      recordRetrievalUses({
        sessionId: "session-a",
        items: [{ chunkId: "chunk-1", tier: "l2" }],
        now: NOW,
        dir: tmpRoot,
      });
    }
    const summary = summarizeChunkUse({ chunkIds: ["chunk-1"], dir: tmpRoot });
    expect(summary.get("chunk-1")).toEqual({ uses: 3, lastUsedDay: "2026-10-04" });
  });

  it("keeps distinct tiers and days separate and accumulates across days", () => {
    recordRetrievalUses({
      sessionId: "s",
      items: [
        { chunkId: "chunk-1", tier: "l2" },
        { chunkId: "chunk-1", tier: "typed" },
      ],
      now: NOW,
      dir: tmpRoot,
    });
    recordRetrievalUses({
      sessionId: "s",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW + DAY_MS,
      dir: tmpRoot,
    });
    const summary = summarizeChunkUse({ chunkIds: ["chunk-1"], dir: tmpRoot });
    // Cumulative across days and tiers for the chunk…
    expect(summary.get("chunk-1")?.uses).toBe(3);
    // …with the most recent injection day reported.
    expect(summary.get("chunk-1")?.lastUsedDay).toBe("2026-10-05");
  });

  it("returns empty summaries for never-injected chunks", () => {
    const summary = summarizeChunkUse({ chunkIds: ["missing"], dir: tmpRoot });
    expect(summary.size).toBe(0);
  });

  it("is a no-op for empty injection batches", () => {
    recordRetrievalUses({ sessionId: "s", items: [], now: NOW, dir: tmpRoot });
    expect(summarizeChunkUse({ chunkIds: ["chunk-1"], dir: tmpRoot }).size).toBe(0);
  });
});

describe("retrieval-use-store QW-2 session attribution + outcome join", () => {
  it("records per-session rows: repeated injections accumulate per (session, chunk)", () => {
    recordRetrievalUses({
      sessionId: "session-a",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW,
      dir: tmpRoot,
    });
    recordRetrievalUses({
      sessionId: "session-a",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW + 1000,
      dir: tmpRoot,
    });
    recordRetrievalUses({
      sessionId: "session-b",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW + 2000,
      dir: tmpRoot,
    });
    const utility = summarizeChunkUtility({ chunkIds: ["chunk-1"], dir: tmpRoot });
    const u = utility.get("chunk-1")!;
    expect(u.uses).toBe(3);
    expect(u.lastUsedAtMs).toBe(NOW + 2000);
    // No outcomes recorded → everything lands in the neutral bucket.
    expect(u.neutralUses).toBe(3);
    expect(u.positiveUses).toBe(0);
    expect(u.negativeUses).toBe(0);
  });

  it("joins injections with recorded session outcomes (retrieved-and-helped vs ignored)", () => {
    // chunk-1 injected twice in a positive session, once in a negative one,
    // once in a session with no recorded outcome.
    recordRetrievalUses({
      sessionId: "s-good",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW,
      dir: tmpRoot,
    });
    recordRetrievalUses({
      sessionId: "s-good",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW + 1000,
      dir: tmpRoot,
    });
    recordRetrievalUses({
      sessionId: "s-bad",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW + 2000,
      dir: tmpRoot,
    });
    recordRetrievalUses({
      sessionId: "s-unknown",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW + 3000,
      dir: tmpRoot,
    });
    recordSessionOutcome({
      sessionId: "s-good",
      outcome: "positive",
      now: NOW + 5000,
      dir: tmpRoot,
    });
    recordSessionOutcome({
      sessionId: "s-bad",
      outcome: "negative",
      now: NOW + 5000,
      dir: tmpRoot,
    });
    const utility = summarizeChunkUtility({ chunkIds: ["chunk-1"], dir: tmpRoot });
    const u = utility.get("chunk-1")!;
    expect(u.uses).toBe(4);
    expect(u.positiveUses).toBe(2);
    expect(u.negativeUses).toBe(1);
    expect(u.neutralUses).toBe(1); // session with no outcome record
    expect(u.lastUsedAtMs).toBe(NOW + 3000);
  });

  it("re-recording a session outcome overwrites with the latest verdict", () => {
    recordRetrievalUses({
      sessionId: "s",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW,
      dir: tmpRoot,
    });
    recordSessionOutcome({ sessionId: "s", outcome: "positive", now: NOW, dir: tmpRoot });
    recordSessionOutcome({ sessionId: "s", outcome: "negative", now: NOW + 1000, dir: tmpRoot });
    const utility = summarizeChunkUtility({ chunkIds: ["chunk-1"], dir: tmpRoot });
    expect(utility.get("chunk-1")?.negativeUses).toBe(1);
    expect(utility.get("chunk-1")?.positiveUses).toBe(0);
  });

  it("keeps the legacy daily summary shape unchanged for existing readers", () => {
    recordRetrievalUses({
      sessionId: "s",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      now: NOW,
      dir: tmpRoot,
    });
    const summary = summarizeChunkUse({ chunkIds: ["chunk-1"], dir: tmpRoot });
    expect(summary.get("chunk-1")).toEqual({ uses: 1, lastUsedDay: "2026-10-04" });
  });

  it("returns an empty map for unknown chunk ids", () => {
    const utility = summarizeChunkUtility({ chunkIds: ["chunk-never"], dir: tmpRoot });
    expect(utility.size).toBe(0);
  });
});
