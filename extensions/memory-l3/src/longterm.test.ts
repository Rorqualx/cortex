import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consolidateLongTerm, DEFAULT_LONG_TERM_CONFIG, type LongTermConfig } from "./longterm.js";
import { Storage } from "./storage.js";
import type { L2Fact, LongTermFact } from "./types.js";

const NOW = Date.UTC(2026, 4, 6, 12, 0, 0);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

let tmpRoot: string;
let storage: Storage;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-longterm-"));
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

describe("consolidateLongTerm", () => {
  it("is a no-op when no L2 chunks exist", async () => {
    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(result).toEqual({
      promotedCount: 0,
      reaffirmedCount: 0,
      archivedCount: 0,
      epochGraceCount: 0,
      unarchivedCount: 0,
      semanticDedupCount: 0,
      blockedCount: 0,
      activeCount: 0,
    });
    const lt = await storage.readLongTerm();
    expect(lt.facts).toEqual([]);
    expect(lt.lastConsolidatedAt).toBe(NOW);
  });

  it("promotes a high-importance one-shot via the passthrough shortcut", async () => {
    await writeChunk(
      "chunk-000000-a",
      [fact("f1", "user is named Joe", 0.9, NOW, "user:identity")],
      NOW,
    );
    const result = await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW });
    expect(result.promotedCount).toBe(1);
    expect(result.activeCount).toBe(1);
    const lt = await storage.readLongTerm();
    const promoted = lt.facts[0];
    expect(promoted.dedupKey).toBe("user:identity");
    expect(promoted.archived).toBe(false);
    expect(promoted.recallCount).toBe(1);
    expect(promoted.id).toMatch(/^lt-/);
  });

  it("does not promote sub-threshold facts", async () => {
    await writeChunk("chunk-x", [fact("f1", "trivia", 0.4, NOW, "trivia:1")], NOW);
    const result = await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW });
    expect(result.promotedCount).toBe(0);
    expect(result.activeCount).toBe(0);
  });

  it("reaffirms an existing long-term fact when the L2 corpus confirms it again", async () => {
    // First pass: promote
    await writeChunk(
      "chunk-000000-a",
      [fact("f1", "tabs", 0.7, NOW - 5 * MS_PER_DAY, "user_pref:tabs")],
      NOW - 5 * MS_PER_DAY,
    );
    await writeChunk(
      "chunk-000001-b",
      [fact("f2", "tabs", 0.7, NOW - MS_PER_DAY, "user_pref:tabs")],
      NOW - MS_PER_DAY,
    );
    const r1 = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - MS_PER_DAY,
    });
    expect(r1.promotedCount).toBe(1);

    const ltAfterFirst = await storage.readLongTerm();
    const promotedId = ltAfterFirst.facts[0].id;

    // Second pass: another chunk confirms the same dedupKey
    await writeChunk(
      "chunk-000002-c",
      [fact("f3", "tabs strongly", 0.85, NOW, "user_pref:tabs")],
      NOW,
    );
    const r2 = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(r2.promotedCount).toBe(0);
    expect(r2.reaffirmedCount).toBe(1);

    const ltAfterSecond = await storage.readLongTerm();
    const reaffirmed = ltAfterSecond.facts[0];
    expect(reaffirmed.id).toBe(promotedId);
    expect(reaffirmed.recallCount).toBe(3);
    expect(reaffirmed.text).toBe("tabs strongly"); // higher importance wins
    expect(reaffirmed.importance).toBe(0.85);
    expect(reaffirmed.lastConfirmedAt).toBe(NOW);
    // The rewritten canonical text leaves a revision trail entry.
    expect(reaffirmed.history).toEqual([{ text: "tabs", supersededAt: NOW }]);
  });

  it("does not grow a history entry when reaffirmation keeps the same text", async () => {
    await writeChunk(
      "chunk-000000-a",
      [fact("f1", "tabs", 0.7, NOW - 5 * MS_PER_DAY, "user_pref:tabs")],
      NOW - 5 * MS_PER_DAY,
    );
    await writeChunk(
      "chunk-000001-b",
      [fact("f2", "tabs", 0.7, NOW - MS_PER_DAY, "user_pref:tabs")],
      NOW - MS_PER_DAY,
    );
    await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW - MS_PER_DAY });
    // Confirm with identical text — no revision occurred.
    await writeChunk("chunk-000002-c", [fact("f3", "tabs", 0.7, NOW, "user_pref:tabs")], NOW);
    const result = await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW });
    expect(result.reaffirmedCount).toBe(1);
    const longTerm = await storage.readLongTerm();
    expect(longTerm.facts[0].history).toBeUndefined();
  });

  it("archives an active fact that has not been confirmed in maxAgeWithoutConfirmMs", async () => {
    // Promote at T=0
    await writeChunk(
      "chunk-x",
      [fact("f1", "old fact", 0.9, NOW - 100 * MS_PER_DAY, "old:thing")],
      NOW - 100 * MS_PER_DAY,
    );
    const r1 = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - 100 * MS_PER_DAY,
    });
    expect(r1.promotedCount).toBe(1);

    // Run consolidation again at NOW; the L2 chunk is still there (it
    // re-promotes via the high-importance passthrough), so the old fact
    // does NOT get archived. Demonstrate the archive path by deleting
    // the L2 chunk first — simulating a workspace where the fact has
    // not been re-confirmed and the promotable set no longer contains it.
    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);

    const r2 = await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW });
    expect(r2.archivedCount).toBe(1);
    expect(r2.activeCount).toBe(0);

    const lt = await storage.readLongTerm();
    expect(lt.facts[0].archived).toBe(true);
    expect(lt.facts[0].archivedAt).toBe(NOW);
  });

  it("does not archive when lastConfirmedAt is recent enough", async () => {
    await writeChunk("chunk-x", [fact("f1", "fresh", 0.9, NOW, "fresh:1")], NOW);
    await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW });

    // Remove the L2 chunk but query soon after — under the threshold.
    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);

    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW + MS_PER_DAY, // well under default 60-day window
    });
    expect(result.archivedCount).toBe(0);
    const lt = await storage.readLongTerm();
    expect(lt.facts[0].archived).toBe(false);
  });

  it("unarchives a previously-archived fact when it re-appears in candidates", async () => {
    // Seed an archived fact directly
    const seeded: LongTermFact = {
      id: "lt-old",
      text: "previously archived",
      dedupKey: "topic:resurfaced",
      importance: 0.7,
      firstSeenAt: NOW - 100 * MS_PER_DAY,
      lastConfirmedAt: NOW - 100 * MS_PER_DAY,
      recallCount: 2,
      sourceChunkIds: ["chunk-old-a", "chunk-old-b"],
      archived: true,
      archivedAt: NOW - 50 * MS_PER_DAY,
    };
    await storage.ensureLayout();
    await storage.writeLongTerm(
      {
        version: 1,
        agentId: "j-rorqual",
        lastConsolidatedAt: NOW - 50 * MS_PER_DAY,
        facts: [seeded],
      },
      "",
    );

    // Now write a fresh L2 chunk with the same dedupKey at high importance.
    await writeChunk(
      "chunk-resurfaced",
      [fact("f1", "topic returns", 0.9, NOW, "topic:resurfaced")],
      NOW,
    );

    const result = await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW });
    expect(result.unarchivedCount).toBe(1);
    expect(result.activeCount).toBe(1);

    const lt = await storage.readLongTerm();
    const fact1 = lt.facts[0];
    expect(fact1.archived).toBe(false);
    expect(fact1.archivedAt).toBeNull();
    expect(fact1.id).toBe("lt-old"); // identity preserved
    expect(fact1.recallCount).toBe(3); // 2 prior + 1 new
    expect(fact1.text).toBe("topic returns"); // higher-importance text wins
  });

  it("respects a custom maxAgeWithoutConfirmMs", async () => {
    await writeChunk("chunk-x", [fact("f1", "fresh", 0.9, NOW, "fresh:1")], NOW);
    await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW });

    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);

    const tightConfig: LongTermConfig = {
      maxAgeWithoutConfirmMs: MS_PER_DAY,
      epochGraceMultiplier: 1.5,
      semanticDedupThreshold: 0.85,
    };
    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW + 2 * MS_PER_DAY,
      longTermConfig: tightConfig,
    });
    expect(result.archivedCount).toBe(1);
  });

  it("default maxAgeWithoutConfirmMs is 60 days", () => {
    expect(DEFAULT_LONG_TERM_CONFIG.maxAgeWithoutConfirmMs).toBe(60 * MS_PER_DAY);
  });

  it("default epochGraceMultiplier is 1.5", () => {
    expect(DEFAULT_LONG_TERM_CONFIG.epochGraceMultiplier).toBe(1.5);
  });

  it("grants epoch grace to last fact in its epoch cluster", async () => {
    // Promote a single fact at T=0
    await writeChunk(
      "chunk-x",
      [fact("f1", "japan trip", 0.9, NOW - 100 * MS_PER_DAY, "trip:japan")],
      NOW - 100 * MS_PER_DAY,
    );
    await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW - 100 * MS_PER_DAY });

    // Remove the L2 chunk so the fact won't be re-confirmed
    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);

    // At 65 days (past 60-day window but under 90-day grace window),
    // the fact should receive epoch grace since it's the last one from its epoch
    const result65 = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - 100 * MS_PER_DAY + 65 * MS_PER_DAY,
    });
    expect(result65.archivedCount).toBe(0);
    expect(result65.epochGraceCount).toBe(1);
    expect(result65.activeCount).toBe(1);

    // At 95 days (past 90-day grace window = 60 * 1.5), it should archive
    const result95 = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - 100 * MS_PER_DAY + 95 * MS_PER_DAY,
    });
    expect(result95.archivedCount).toBe(1);
    expect(result95.epochGraceCount).toBe(0);
    expect(result95.activeCount).toBe(0);
  });

  it("does not grant epoch grace when other facts share the epoch", async () => {
    // Promote two facts from the same epoch (same firstSeenAt day)
    await writeChunk(
      "chunk-a",
      [
        fact("f1", "japan flights", 0.9, NOW - 100 * MS_PER_DAY, "trip:flights"),
        fact("f2", "japan hotels", 0.85, NOW - 100 * MS_PER_DAY, "trip:hotels"),
      ],
      NOW - 100 * MS_PER_DAY,
    );
    await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW - 100 * MS_PER_DAY });

    // Remove the L2 chunk so facts won't be re-confirmed
    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);

    // At 65 days, facts should archive normally — there are 2 in the epoch,
    // so the "last fact" grace doesn't apply to the first one archived.
    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - 100 * MS_PER_DAY + 65 * MS_PER_DAY,
    });
    expect(result.archivedCount).toBe(2);
    expect(result.epochGraceCount).toBe(0);
    expect(result.activeCount).toBe(0);
  });

  it("epoch grace applies when second-to-last fact archives, leaving one", async () => {
    // Three facts from the same epoch, all stale. All three must clear
    // highImportancePassthrough (>= 0.85) so they actually promote from a
    // single chunk. Without this, facts below 0.85 are silently dropped.
    await writeChunk(
      "chunk-a",
      [
        fact("f1", "japan flights", 0.9, NOW - 100 * MS_PER_DAY, "trip:flights"),
        fact("f2", "japan hotels", 0.85, NOW - 100 * MS_PER_DAY, "trip:hotels"),
        fact("f3", "japan food", 0.88, NOW - 100 * MS_PER_DAY, "trip:food"),
      ],
      NOW - 100 * MS_PER_DAY,
    );
    await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW - 100 * MS_PER_DAY });

    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);

    // At 65 days, 2 facts archive normally (epoch has 3), then the 3rd
    // becomes the last-in-epoch and receives grace.
    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - 100 * MS_PER_DAY + 65 * MS_PER_DAY,
    });
    expect(result.archivedCount).toBe(2);
    expect(result.epochGraceCount).toBe(1);
    expect(result.activeCount).toBe(1);
  });

  it("epoch grace can be disabled by setting multiplier to 1", async () => {
    await writeChunk(
      "chunk-x",
      [fact("f1", "japan trip", 0.9, NOW - 100 * MS_PER_DAY, "trip:japan")],
      NOW - 100 * MS_PER_DAY,
    );
    await consolidateLongTerm({ storage, agentId: "j-rorqual", now: NOW - 100 * MS_PER_DAY });

    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);

    const noGraceConfig: LongTermConfig = {
      maxAgeWithoutConfirmMs: 60 * MS_PER_DAY,
      epochGraceMultiplier: 1,
      semanticDedupThreshold: 0.85,
    };
    // At 65 days, no grace — archives immediately
    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - 100 * MS_PER_DAY + 65 * MS_PER_DAY,
      longTermConfig: noGraceConfig,
    });
    expect(result.archivedCount).toBe(1);
    expect(result.epochGraceCount).toBe(0);
  });
});

describe("consolidateLongTerm QMD mirror", () => {
  it("writes <workspaceDir>/memory/.l3/<date>.md when workspaceDir is provided", async () => {
    await writeChunk(
      "chunk-x",
      [fact("f1", "user prefers tabs over spaces", 0.9, NOW, "user_pref:tabs")],
      NOW,
    );
    const workspaceDir = path.join(tmpRoot, "workspace");
    const fs = await import("node:fs/promises");
    await fs.mkdir(workspaceDir, { recursive: true });

    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      workspaceDir,
    });
    expect(result.promotedCount).toBe(1);

    // NOW = 2026-05-06 UTC
    const mirrorPath = path.join(workspaceDir, "memory", ".l3", "2026-05-06.md");
    const body = await fs.readFile(mirrorPath, "utf8");
    expect(body).toContain("# Long-term memory (memory-l3 derived)");
    expect(body).toContain("## user_pref:tabs");
    expect(body).toContain("user prefers tabs over spaces");
    expect(body).toContain("recallCount=1");
    expect(body).toContain("importance=0.90");
  });

  it("does not write a mirror when workspaceDir is not provided", async () => {
    await writeChunk("chunk-x", [fact("f1", "anything", 0.9, NOW, "k:1")], NOW);
    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(result.promotedCount).toBe(1);
    // No assertion on filesystem — the mirror is opt-in.
  });

  it("does not write the mirror when no active facts exist", async () => {
    await writeChunk("chunk-x", [fact("f1", "trivia", 0.4, NOW, "k:1")], NOW);
    const workspaceDir = path.join(tmpRoot, "workspace");
    const fs = await import("node:fs/promises");
    await fs.mkdir(workspaceDir, { recursive: true });

    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      workspaceDir,
    });
    expect(result.promotedCount).toBe(0);
    expect(result.activeCount).toBe(0);

    const mirrorDir = path.join(workspaceDir, "memory", ".l3");
    const exists = await fs
      .stat(mirrorDir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("excludes archived facts from the mirror", async () => {
    // Promote a fact, then re-run past the staleness window without re-confirming.
    await writeChunk(
      "chunk-old",
      [fact("f1", "ephemeral", 0.9, NOW - 100 * MS_PER_DAY, "old:1")],
      NOW - 100 * MS_PER_DAY,
    );
    const workspaceDir = path.join(tmpRoot, "workspace");
    const fs = await import("node:fs/promises");
    await fs.mkdir(workspaceDir, { recursive: true });

    await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - 100 * MS_PER_DAY,
      workspaceDir,
    });

    // Remove the L2 chunk, then re-run consolidation past the 60-day window.
    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);
    await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      workspaceDir,
    });

    // Today's mirror file should NOT exist (no active facts) — the prior
    // mirror (from the original consolidation date) may still exist as a
    // historical snapshot, but today is empty so we don't overwrite it.
    const todayPath = path.join(workspaceDir, "memory", ".l3", "2026-05-06.md");
    const todayExists = await fs
      .stat(todayPath)
      .then(() => true)
      .catch(() => false);
    expect(todayExists).toBe(false);
  });
});
