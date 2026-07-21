import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EPOCH_CHUNK_THRESHOLD, maybeWriteEpoch, REPRESENTATIVE_FACT_COUNT } from "./epoch.js";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L2Fact, type L3State } from "./types.js";

let tmpRoot: string;
let storage: Storage;
let state: L3State;
const NOW = Date.UTC(2026, 4, 6, 12, 0, 0);

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-epoch-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  state = { ...INITIAL_L3_STATE, agentId: "j-rorqual" };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const fact = (id: string, importance: number, createdAt: number = NOW): L2Fact => ({
  id,
  text: `fact ${id}`,
  importance,
  createdAt,
  dedupKey: `k:${id}`,
});

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

describe("maybeWriteEpoch", () => {
  it("returns null when l2ChunkIndex is 0", async () => {
    expect(await maybeWriteEpoch({ storage, state, now: NOW })).toBeNull();
  });

  it("returns null when l2ChunkIndex is below threshold", async () => {
    state.l2ChunkIndex = EPOCH_CHUNK_THRESHOLD - 1;
    expect(await maybeWriteEpoch({ storage, state, now: NOW })).toBeNull();
  });

  it("returns null when l2ChunkIndex is not a multiple of threshold", async () => {
    state.l2ChunkIndex = EPOCH_CHUNK_THRESHOLD + 1;
    expect(await maybeWriteEpoch({ storage, state, now: NOW })).toBeNull();
  });

  it("writes an epoch covering the last threshold chunks at the boundary", async () => {
    for (let i = 0; i < EPOCH_CHUNK_THRESHOLD; i += 1) {
      await writeChunk(`chunk-${i.toString().padStart(3, "0")}`, [fact(`f${i}`, 0.5)]);
    }
    state.l2ChunkIndex = EPOCH_CHUNK_THRESHOLD;
    const epochId = await maybeWriteEpoch({ storage, state, now: NOW });
    expect(epochId).toBe("epoch-0000");
    expect(state.lastEpochAt).toBe(NOW);
    const doc = await storage.readL3Epoch("epoch-0000");
    expect(doc).not.toBeNull();
    expect(doc?.frontmatter.startChunkId).toBe("chunk-000");
    expect(doc?.frontmatter.endChunkId).toBe(`chunk-00${EPOCH_CHUNK_THRESHOLD - 1}`);
  });

  it("sorts representative facts by importance descending", async () => {
    await writeChunk("chunk-000", [fact("low", 0.2), fact("high", 0.9)]);
    for (let i = 1; i < EPOCH_CHUNK_THRESHOLD; i += 1) {
      await writeChunk(`chunk-${i.toString().padStart(3, "0")}`, [fact(`mid${i}`, 0.5)]);
    }
    state.l2ChunkIndex = EPOCH_CHUNK_THRESHOLD;
    await maybeWriteEpoch({ storage, state, now: NOW });
    const doc = await storage.readL3Epoch("epoch-0000");
    expect(doc?.frontmatter.representativeFacts[0]?.id).toBe("high");
  });

  it("caps representative facts at REPRESENTATIVE_FACT_COUNT", async () => {
    for (let i = 0; i < EPOCH_CHUNK_THRESHOLD; i += 1) {
      const facts = Array.from({ length: 5 }, (_, j) => fact(`f-${i}-${j}`, 0.5));
      await writeChunk(`chunk-${i.toString().padStart(3, "0")}`, facts);
    }
    state.l2ChunkIndex = EPOCH_CHUNK_THRESHOLD;
    await maybeWriteEpoch({ storage, state, now: NOW });
    const doc = await storage.readL3Epoch("epoch-0000");
    expect(doc?.frontmatter.representativeFacts.length).toBeLessThanOrEqual(
      REPRESENTATIVE_FACT_COUNT,
    );
  });

  it("rolls subsequent epochs (epoch-0001 covers the next batch)", async () => {
    for (let i = 0; i < EPOCH_CHUNK_THRESHOLD * 2; i += 1) {
      await writeChunk(`chunk-${i.toString().padStart(3, "0")}`, [fact(`f${i}`, 0.5)]);
    }
    state.l2ChunkIndex = EPOCH_CHUNK_THRESHOLD * 2;
    const epochId = await maybeWriteEpoch({ storage, state, now: NOW });
    expect(epochId).toBe("epoch-0001");
  });
});
