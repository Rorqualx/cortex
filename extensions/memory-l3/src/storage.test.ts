import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Storage } from "./storage.js";
import {
  INITIAL_L3_STATE,
  type L2ChunkFrontmatter,
  type L3EpochFrontmatter,
  type LongTermFact,
  type LongTermFrontmatter,
  type MessageChunk,
} from "./types.js";

let tmpRoot: string;
let storage: Storage;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-test-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Storage path resolution", () => {
  it("fromWorkspace anchors under <workspaceDir>/.openclaw/l3/", () => {
    const ws = "/tmp/agents/some-agent";
    const s = Storage.fromWorkspace(ws);
    expect(s.root).toBe("/tmp/agents/some-agent/.openclaw/l3");
  });

  it("fromWorkspace falls back to a temp dir when workspaceDir is missing", () => {
    const s = Storage.fromWorkspace(undefined);
    expect(s.root).toContain(os.tmpdir());
    expect(s.root).toContain("openclaw-memory-l3-");
  });
});

describe("Storage state I/O", () => {
  it("readState returns INITIAL_L3_STATE when file does not exist", async () => {
    const state = await storage.readState();
    expect(state).toEqual(INITIAL_L3_STATE);
  });

  it("writeState then readState round-trips faithfully", async () => {
    await storage.ensureLayout();
    const written = {
      ...INITIAL_L3_STATE,
      agentId: "j-rorqual",
      bufferTokenCount: 1234,
      l2ChunkIndex: 7,
      lastEpochAt: 1_700_000_000_000,
      lastChunkId: "chunk-007",
    } as const;
    await storage.writeState(written);
    const readBack = await storage.readState();
    expect(readBack).toEqual(written);
  });

  it("writeState merges with INITIAL_L3_STATE on partial files", async () => {
    await storage.ensureLayout();
    await storage.writeState({
      ...INITIAL_L3_STATE,
      bufferTokenCount: 42,
    });
    const readBack = await storage.readState();
    expect(readBack.bufferTokenCount).toBe(42);
    expect(readBack.version).toBe(1);
  });
});

describe("Storage L2 chunks", () => {
  it("writes and reads back an L2 chunk with frontmatter intact", async () => {
    const frontmatter: L2ChunkFrontmatter = {
      id: "chunk-abc123",
      agentId: "j-rorqual",
      startTurnIndex: 0,
      endTurnIndex: 23,
      createdAt: Date.UTC(2026, 4, 6, 12, 0, 0),
      facts: [
        {
          id: "fact-1",
          text: "The user prefers morning standups.",
          importance: 0.7,
          createdAt: Date.UTC(2026, 4, 6, 12, 0, 0),
          dedupKey: "user_preference:morning_standups",
        },
      ],
      dedupKeys: ["user_preference:morning_standups"],
    };
    const written = await storage.writeL2Chunk(frontmatter, "Summary body text.");
    expect(written).toContain("/l2/2026-05-06/chunk-abc123.md");
    const readBack = await storage.readL2Chunk("chunk-abc123", frontmatter.createdAt);
    expect(readBack).not.toBeNull();
    expect(readBack?.frontmatter).toEqual(frontmatter);
    expect(readBack?.body).toBe("Summary body text.\n");
  });

  it("readL2Chunk returns null when the file does not exist", async () => {
    const result = await storage.readL2Chunk("missing", Date.now());
    expect(result).toBeNull();
  });

  it("listL2ChunkPaths returns all chunks sorted by partition then filename", async () => {
    const day1 = Date.UTC(2026, 4, 5, 12, 0, 0);
    const day2 = Date.UTC(2026, 4, 6, 12, 0, 0);
    await storage.writeL2Chunk(makeChunk("chunk-002", day1), "");
    await storage.writeL2Chunk(makeChunk("chunk-001", day1), "");
    await storage.writeL2Chunk(makeChunk("chunk-003", day2), "");
    const paths = await storage.listL2ChunkPaths();
    expect(paths).toHaveLength(3);
    expect(paths[0]).toContain("/l2/2026-05-05/chunk-001.md");
    expect(paths[1]).toContain("/l2/2026-05-05/chunk-002.md");
    expect(paths[2]).toContain("/l2/2026-05-06/chunk-003.md");
  });

  it("listL2ChunkPaths returns [] when no chunks have been written", async () => {
    const paths = await storage.listL2ChunkPaths();
    expect(paths).toEqual([]);
  });
});

describe("Storage L3 epochs", () => {
  it("writes and reads back an L3 epoch", async () => {
    const epoch: L3EpochFrontmatter = {
      id: "epoch-001",
      agentId: "j-rorqual",
      startChunkId: "chunk-001",
      endChunkId: "chunk-004",
      createdAt: Date.UTC(2026, 4, 6, 12, 0, 0),
      representativeFacts: [],
    };
    await storage.writeL3Epoch(epoch, "Digest covering chunks 001..004.");
    const readBack = await storage.readL3Epoch("epoch-001");
    expect(readBack?.frontmatter).toEqual(epoch);
    expect(readBack?.body).toBe("Digest covering chunks 001..004.\n");
  });
});

describe("Storage L1 archive", () => {
  it("appendL1Archive writes one JSONL line per call and survives multiple calls", async () => {
    await storage.appendL1Archive("chunk-001", { role: "user", content: "first" });
    await storage.appendL1Archive("chunk-001", { role: "assistant", content: "second" });
    const archivePath = path.join(storage.root, "l1_archive", "chunk-001.jsonl");
    const { readFileSync } = await import("node:fs");
    const contents = readFileSync(archivePath, "utf8");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const [line0, line1] = lines;
    if (line0 === undefined || line1 === undefined) {
      throw new Error("expected two archive lines");
    }
    expect(JSON.parse(line0)).toEqual({ role: "user", content: "first" });
    expect(JSON.parse(line1)).toEqual({ role: "assistant", content: "second" });
  });
});

describe("Storage message-chunk actor/channel facets (QW3 2026-10-15)", () => {
  const baseChunk = (
    id: string,
    seq: number,
    chunkId: string,
    over?: { actor?: string | null; channel?: string | null },
  ): MessageChunk => ({
    id,
    seq,
    startMsgIndex: seq * 2,
    endMsgIndex: seq * 2 + 2,
    text: `text-${id}`,
    embedding: [0.1, 0.2],
    createdAt: 1_700_000_000_000,
    chunkId,
    actor: over?.actor ?? null,
    channel: over?.channel ?? null,
  });

  it("round-trips actor and channel facets (null-safe)", async () => {
    await storage.writeMessageChunks([
      baseChunk("m0", 0, "chunk-facets", { actor: "user", channel: "telegram" }),
      baseChunk("m1", 1, "chunk-facets", { actor: null, channel: null }),
    ]);
    const rows = await storage.readMessageChunks("chunk-facets");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.actor).toBe("user");
    expect(rows[0]?.channel).toBe("telegram");
    expect(rows[1]?.actor).toBeNull();
    expect(rows[1]?.channel).toBeNull();
  });

  it("facet filters narrow reads, exclude NULL facet rows, and empty filters read all", async () => {
    await storage.writeMessageChunks([
      baseChunk("a0", 0, "chunk-facets", { actor: "user", channel: "telegram" }),
      baseChunk("a1", 1, "chunk-facets", { actor: "assistant", channel: "telegram" }),
      baseChunk("a2", 2, "chunk-facets", { actor: null, channel: null }),
    ]);
    const byActor = await storage.readMessageChunks("chunk-facets", { actors: ["user"] });
    expect(byActor).toHaveLength(1);
    expect(byActor[0]?.id).toBe("a0");
    expect(
      await storage.readMessageChunks("chunk-facets", { channels: ["telegram"] }),
    ).toHaveLength(2);
    expect(
      await storage.readMessageChunks("chunk-facets", { actors: ["user"], channels: ["telegram"] }),
    ).toHaveLength(1);
    // Empty lists mean "no filter" — NULL-facet rows survive.
    expect(await storage.readMessageChunks("chunk-facets", { actors: [] })).toHaveLength(3);
    expect(await storage.readMessageChunks("chunk-facets", {})).toHaveLength(3);
  });

  it("migrates a pre-facet database by adding actor/channel columns (legacy rows read null)", async () => {
    const { requireNodeSqlite } =
      await import("openclaw/plugin-sdk/memory-core-host-engine-storage");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(storage.root, { recursive: true });
    const raw = new (requireNodeSqlite().DatabaseSync)(path.join(storage.root, "l3.sqlite"));
    raw.exec(
      "CREATE TABLE l3_message_chunks (" +
        "id TEXT PRIMARY KEY, chunk_id TEXT NOT NULL, seq INTEGER NOT NULL, " +
        "start_msg_index INTEGER NOT NULL, end_msg_index INTEGER NOT NULL, " +
        "text TEXT NOT NULL, embedding TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    raw
      .prepare(
        "INSERT INTO l3_message_chunks " +
          "(id, chunk_id, seq, start_msg_index, end_msg_index, text, embedding, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-1", "chunk-legacy", 0, 0, 2, "old text", "[0.1]", 1_700_000_000_000);
    raw.close();

    // Opening through Storage must add the facet columns and keep the row.
    const rows = await storage.readMessageChunks("chunk-legacy");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBeNull();
    expect(rows[0]?.channel).toBeNull();

    // New facet-bearing writes work against the migrated table.
    await storage.writeMessageChunks([
      baseChunk("m0", 0, "chunk-legacy", { actor: "user", channel: "cli" }),
    ]);
    const after = await storage.readMessageChunks("chunk-legacy");
    expect(after).toHaveLength(1);
    expect(after[0]?.actor).toBe("user");
    expect(after[0]?.channel).toBe("cli");
  });

  it("backfills actor facets from the L1 archive (NULL-safe, idempotent, pre-stamped rows untouched)", async () => {
    const archive = [
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a2" },
    ];
    for (const line of archive) {
      await storage.appendL1Archive("chunk-bf", line);
    }
    const mk = (
      id: string,
      chunkId: string,
      seq: number,
      start: number,
      end: number,
      actor: string | null,
    ): MessageChunk => ({
      id,
      seq,
      startMsgIndex: start,
      endMsgIndex: end,
      text: `t-${id}`,
      embedding: [0.1],
      createdAt: 1,
      chunkId,
      actor,
      channel: null,
    });
    await storage.writeMessageChunks([
      mk("b0", "chunk-bf", 0, 0, 2, null),
      mk("b1", "chunk-bf", 1, 2, 4, null),
      mk("b2", "chunk-bf", 2, 4, 5, null),
      // Pre-stamped row whose window would re-derive as "user" — must stay.
      mk("b3", "chunk-bf", 3, 0, 1, "assistant"),
    ]);
    await storage.writeMessageChunks([mk("n0", "chunk-noarchive", 0, 0, 1, null)]);

    const updated = await storage.backfillMessageChunkActors();
    expect(updated).toBe(3);
    const rows = await storage.readMessageChunks("chunk-bf");
    expect(rows.map((r) => r.actor)).toEqual(["user", "mixed", "assistant", "assistant"]);
    const orphan = await storage.readMessageChunks("chunk-noarchive");
    expect(orphan[0]?.actor).toBeNull();

    // Idempotent: nothing left to backfill.
    expect(await storage.backfillMessageChunkActors()).toBe(0);
  });
});

describe("Storage long-term tier I/O", () => {
  it("readLongTerm returns initial frontmatter when the file does not exist", async () => {
    const lt = await storage.readLongTerm();
    expect(lt.version).toBe(1);
    expect(lt.agentId).toBeNull();
    expect(lt.lastConsolidatedAt).toBe(0);
    expect(lt.facts).toEqual([]);
  });

  it("writeLongTerm then readLongTerm round-trips faithfully", async () => {
    await storage.ensureLayout();
    const fact: LongTermFact = {
      id: "lt-1",
      text: "user prefers morning standups",
      dedupKey: "user_pref:morning_standups",
      importance: 0.9,
      firstSeenAt: 1000,
      lastConfirmedAt: 5000,
      recallCount: 3,
      sourceChunkIds: ["chunk-000000-aaaa", "chunk-000003-bbbb", "chunk-000005-cccc"],
      archived: false,
      archivedAt: null,
    };
    const fm: LongTermFrontmatter = {
      version: 1,
      agentId: "j-rorqual",
      lastConsolidatedAt: 7000,
      facts: [fact],
    };
    await storage.writeLongTerm(fm, "## Long-term facts\n- user prefers morning standups");
    const round = await storage.readLongTerm();
    expect(round).toEqual(fm);
  });

  it("writeLongTerm overwrites the existing file atomically", async () => {
    await storage.ensureLayout();
    const fmA: LongTermFrontmatter = {
      version: 1,
      agentId: null,
      lastConsolidatedAt: 1,
      facts: [],
    };
    await storage.writeLongTerm(fmA, "v1");
    const fmB: LongTermFrontmatter = {
      version: 1,
      agentId: "j-rorqual",
      lastConsolidatedAt: 2,
      facts: [
        {
          id: "lt-2",
          text: "always tabs",
          dedupKey: "user_pref:tabs",
          importance: 0.7,
          firstSeenAt: 100,
          lastConfirmedAt: 200,
          recallCount: 2,
          sourceChunkIds: ["chunk-x", "chunk-y"],
          archived: false,
          archivedAt: null,
        },
      ],
    };
    await storage.writeLongTerm(fmB, "v2");
    const round = await storage.readLongTerm();
    expect(round.lastConsolidatedAt).toBe(2);
    expect(round.facts).toHaveLength(1);
    expect(round.facts[0]?.dedupKey).toBe("user_pref:tabs");
  });

  it("preserves archived facts on round-trip", async () => {
    await storage.ensureLayout();
    const fm: LongTermFrontmatter = {
      version: 1,
      agentId: "j-rorqual",
      lastConsolidatedAt: 9000,
      facts: [
        {
          id: "lt-old",
          text: "deprecated preference",
          dedupKey: "old:thing",
          importance: 0.4,
          firstSeenAt: 1000,
          lastConfirmedAt: 1500,
          recallCount: 2,
          sourceChunkIds: ["chunk-z"],
          archived: true,
          archivedAt: 8500,
        },
      ],
    };
    await storage.writeLongTerm(fm, "");
    const round = await storage.readLongTerm();
    expect(round.facts[0]?.archived).toBe(true);
    expect(round.facts[0]?.archivedAt).toBe(8500);
  });
});

describe("Storage cost-attribution metrics (QW5 2026-08-16)", () => {
  it("recordMetric appends rows that readMetrics returns, honoring the since filter", async () => {
    await storage.ensureLayout();
    await storage.recordMetric(
      {
        sessionId: "session-a",
        consolidations: 3,
        promotions: 2,
        demotions: 1,
        merges: 4,
        tokensSpent: 1234,
      },
      1_000,
    );
    await storage.recordMetric(
      {
        sessionId: "session-b",
        consolidations: 1,
        promotions: 0,
        demotions: 0,
        merges: 0,
        tokensSpent: 100,
      },
      2_000,
    );
    const all = await storage.readMetrics();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      sessionId: "session-a",
      consolidations: 3,
      promotions: 2,
      demotions: 1,
      merges: 4,
      tokensSpent: 1234,
      createdAt: 1_000,
    });
    const since = await storage.readMetrics(2_000);
    expect(since).toHaveLength(1);
    expect(since[0]?.sessionId).toBe("session-b");
  });

  it("clamps negative counters to zero so callers cannot corrupt aggregates", async () => {
    await storage.ensureLayout();
    await storage.recordMetric(
      {
        sessionId: "session-c",
        consolidations: -5,
        promotions: -1,
        demotions: -2,
        merges: -3,
        tokensSpent: -99,
      },
      3_000,
    );
    const rows = await storage.readMetrics();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consolidations: 0,
      promotions: 0,
      demotions: 0,
      merges: 0,
      tokensSpent: 0,
    });
  });
});

function makeChunk(id: string, createdAt: number): L2ChunkFrontmatter {
  return {
    id,
    agentId: "j-rorqual",
    startTurnIndex: 0,
    endTurnIndex: 0,
    createdAt,
    facts: [],
    dedupKeys: [],
  };
}
