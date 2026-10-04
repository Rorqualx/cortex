import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeRetrievalUseStoreForTest,
  recordRetrievalUses,
  summarizeChunkUse,
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
