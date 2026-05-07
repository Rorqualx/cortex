import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compactSession } from "./compaction.js";
import { IngestBuffer } from "./ingest.js";
import type { LlmCaller } from "./llm.js";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L3State } from "./types.js";

const userMsg = (text: string) => ({ role: "user", content: text }) as never;

let tmpRoot: string;
let storage: Storage;
let buffer: IngestBuffer;
let state: L3State;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-compaction-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  buffer = new IngestBuffer();
  state = { ...INITIAL_L3_STATE, agentId: "j-rorqual" };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("compactSession", () => {
  it("returns an empty result when buffer is empty", async () => {
    const caller = vi.fn(async () => "{}");
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result).toEqual({
      chunkId: null,
      factsAdded: 0,
      tokensBefore: 0,
      messagesIngested: 0,
    });
    expect(caller).not.toHaveBeenCalled();
  });

  it("extracts facts, persists an L2 chunk, and drains the buffer", async () => {
    buffer.push("s1", userMsg("I prefer morning standups."));
    buffer.push("s1", userMsg("Yes, every weekday."));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "user prefers morning standups",
            importance: 0.8,
            dedupKey: "user_preference:morning_standups",
          },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.chunkId).not.toBeNull();
    expect(result.factsAdded).toBe(1);
    expect(result.messagesIngested).toBe(2);
    expect(buffer.size("s1")).toBe(0);
    expect(state.l2ChunkIndex).toBe(1);
    expect(state.lastChunkId).toBe(result.chunkId);

    const paths = await storage.listL2ChunkPaths();
    expect(paths).toHaveLength(1);
    const doc = await storage.readL2ChunkAtPath(paths[0]);
    expect(doc?.frontmatter.facts).toHaveLength(1);
    expect(doc?.frontmatter.facts[0].text).toBe("user prefers morning standups");
    expect(doc?.frontmatter.dedupKeys).toEqual(["user_preference:morning_standups"]);
  });

  it("drops facts whose dedupKey is already in a recent chunk", async () => {
    await storage.ensureLayout();
    await storage.writeL2Chunk(
      {
        id: "chunk-prior",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: Date.now(),
        facts: [],
        dedupKeys: ["user_preference:morning_standups"],
      },
      "",
    );

    buffer.push("s1", userMsg("morning standups again"));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          {
            text: "user prefers morning standups",
            importance: 0.8,
            dedupKey: "user_preference:morning_standups",
          },
          {
            text: "user uses tabs not spaces",
            importance: 0.6,
            dedupKey: "code_style:tabs",
          },
        ],
      }),
    );

    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.factsAdded).toBe(1);
    const paths = await storage.listL2ChunkPaths();
    const newChunkPath = paths.find((p) => !p.includes("chunk-prior"));
    expect(newChunkPath).toBeDefined();
    const doc = await storage.readL2ChunkAtPath(newChunkPath as string);
    expect(doc?.frontmatter.dedupKeys).toEqual(["code_style:tabs"]);
  });

  it("dedupes within-chunk when the LLM emits the same dedupKey twice", async () => {
    buffer.push("s1", userMsg("anything"));
    const caller: LlmCaller = vi.fn(async () =>
      JSON.stringify({
        facts: [
          { text: "first emission", importance: 0.8, dedupKey: "k:dup" },
          { text: "second emission", importance: 0.3, dedupKey: "k:dup" },
        ],
      }),
    );
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.factsAdded).toBe(1);
    const paths = await storage.listL2ChunkPaths();
    const doc = await storage.readL2ChunkAtPath(paths[0]);
    expect(doc?.frontmatter.facts[0].text).toBe("first emission");
    expect(doc?.frontmatter.facts[0].importance).toBe(0.8);
  });

  it("writes the L1 archive with the original messages", async () => {
    buffer.push("s1", userMsg("first"));
    buffer.push("s1", userMsg("second"));
    const caller: LlmCaller = vi.fn(async () => JSON.stringify({ facts: [] }));
    await storage.ensureLayout();
    const result = await compactSession({ sessionId: "s1", buffer, storage, caller, state });
    expect(result.chunkId).not.toBeNull();
    const archivePath = path.join(storage.root, "l1_archive", `${result.chunkId}.jsonl`);
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(archivePath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ role: "user", content: "first" });
    expect(JSON.parse(lines[1])).toEqual({ role: "user", content: "second" });
  });
});
