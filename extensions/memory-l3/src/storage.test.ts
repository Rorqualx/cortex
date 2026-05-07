import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L2ChunkFrontmatter, type L3EpochFrontmatter } from "./types.js";

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
    expect(JSON.parse(lines[0])).toEqual({ role: "user", content: "first" });
    expect(JSON.parse(lines[1])).toEqual({ role: "assistant", content: "second" });
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
