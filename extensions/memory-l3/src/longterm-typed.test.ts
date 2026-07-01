import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consolidateLongTermTyped } from "./longterm-typed.js";
import { Storage } from "./storage.js";
import type { TypedFact } from "./types.js";

let tmpRoot: string;
let storage: Storage;

const NOW = Date.UTC(2026, 4, 7, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-longterm-typed-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const writeChunkWithTyped = async (
  chunkId: string,
  typedFacts: TypedFact[],
  createdAt: number,
): Promise<void> => {
  await storage.writeL2Chunk(
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

describe("consolidateLongTermTyped", () => {
  it("promotes a single-occurrence typed fact into the canonical view", async () => {
    await writeChunkWithTyped(
      "chunk-000000-a",
      [
        {
          id: "tf-1",
          slot: "user:phone",
          value: "555-1234",
          sourceSpan: "my phone is 555-1234",
          unit: null,
          confidence: 0.9,
          createdAt: NOW,
        },
      ],
      NOW,
    );

    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(out.promotedCount).toBe(1);
    expect(out.activeCount).toBe(1);

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts).toHaveLength(1);
    expect(ltt.facts[0].slot).toBe("user:phone");
    expect(ltt.facts[0].value).toBe("555-1234");
    expect(ltt.facts[0].history).toEqual([]);
    expect(ltt.facts[0].recallCount).toBe(1);
  });

  it("supersedes when the same slot's value changes across chunks", async () => {
    await writeChunkWithTyped(
      "chunk-000000-old",
      [
        {
          id: "tf-old",
          slot: "user:account_balance",
          value: "500.00",
          sourceSpan: "balance is 500.00 USD",
          unit: "USD",
          confidence: 0.95,
          createdAt: NOW - 5 * DAY,
        },
      ],
      NOW - 5 * DAY,
    );
    await writeChunkWithTyped(
      "chunk-000001-new",
      [
        {
          id: "tf-new",
          slot: "user:account_balance",
          value: "750.00",
          sourceSpan: "balance is now 750.00 USD",
          unit: "USD",
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );

    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(out.promotedCount).toBe(1);

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0].value).toBe("750.00");
    expect(ltt.facts[0].history).toHaveLength(1);
    expect(ltt.facts[0].history[0].value).toBe("500.00");
    expect(ltt.facts[0].recallCount).toBe(2);
  });

  it("re-affirms when value is identical across chunks (no history entry)", async () => {
    await writeChunkWithTyped(
      "chunk-1",
      [
        {
          id: "tf-1",
          slot: "infra:pi_hole_ip",
          value: "192.168.50.128",
          sourceSpan: "pi-hole at 192.168.50.128",
          unit: null,
          confidence: 0.9,
          createdAt: NOW - 3 * DAY,
        },
      ],
      NOW - 3 * DAY,
    );
    await writeChunkWithTyped(
      "chunk-2",
      [
        {
          id: "tf-2",
          slot: "infra:pi_hole_ip",
          value: "192.168.50.128",
          sourceSpan: "pi-hole still at 192.168.50.128",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );

    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(out.promotedCount).toBe(1);

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0].value).toBe("192.168.50.128");
    expect(ltt.facts[0].history).toEqual([]);
    expect(ltt.facts[0].recallCount).toBe(2);
  });

  it("supersedes existing canonical entry on a second pass", async () => {
    await writeChunkWithTyped(
      "chunk-old",
      [
        {
          id: "tf-old",
          slot: "user:account_balance",
          value: "500.00",
          sourceSpan: "balance 500.00",
          unit: null,
          confidence: 0.9,
          createdAt: NOW - 5 * DAY,
        },
      ],
      NOW - 5 * DAY,
    );
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW - 5 * DAY,
    });

    await writeChunkWithTyped(
      "chunk-new",
      [
        {
          id: "tf-new",
          slot: "user:account_balance",
          value: "750.00",
          sourceSpan: "balance 750.00",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );
    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(out.supersededCount).toBe(1);
    expect(out.promotedCount).toBe(0);

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0].value).toBe("750.00");
    expect(ltt.facts[0].history).toHaveLength(1);
    expect(ltt.facts[0].history[0].value).toBe("500.00");
  });

  it("archives entries that aren't seen for longer than maxAgeWithoutConfirmMs", async () => {
    await writeChunkWithTyped(
      "chunk-stale",
      [
        {
          id: "tf-stale",
          slot: "ephemeral:thing",
          value: "x",
          sourceSpan: "the thing is x",
          unit: null,
          confidence: 0.5,
          createdAt: NOW - 90 * DAY,
        },
      ],
      NOW - 90 * DAY,
    );
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW - 90 * DAY,
    });

    for (const token of await storage.listL2ChunkPaths()) {
      await storage.deleteL2Chunk(token);
    }

    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      config: { maxAgeWithoutConfirmMs: 60 * DAY, minRecallCount: 1 },
    });
    expect(out.archivedCount).toBe(1);
    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0].archived).toBe(true);
  });

  it("sets lastVerifiedAt on promotion and updates it on reaffirmation", async () => {
    await writeChunkWithTyped(
      "chunk-1",
      [
        {
          id: "tf-1",
          slot: "user:phone",
          value: "555-1234",
          sourceSpan: "my phone is 555-1234",
          unit: null,
          confidence: 0.9,
          createdAt: NOW - 3 * DAY,
        },
      ],
      NOW - 3 * DAY,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW - 3 * DAY });

    const ltt1 = await storage.readLongTermTyped();
    expect(ltt1.facts[0].lastVerifiedAt).toBe(NOW - 3 * DAY);

    // Reaffirm with a newer chunk
    await writeChunkWithTyped(
      "chunk-2",
      [
        {
          id: "tf-2",
          slot: "user:phone",
          value: "555-1234",
          sourceSpan: "still 555-1234",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW });

    const ltt2 = await storage.readLongTermTyped();
    expect(ltt2.facts[0].lastVerifiedAt).toBe(NOW);
    expect(ltt2.facts[0].recallCount).toBe(2);
  });

  it("uses lastVerifiedAt to prevent archival when value was recently verified", async () => {
    // First chunk: old confirmation
    await writeChunkWithTyped(
      "chunk-old",
      [
        {
          id: "tf-old",
          slot: "infra:ip",
          value: "192.168.50.1",
          sourceSpan: "ip is 192.168.50.1",
          unit: null,
          confidence: 0.9,
          createdAt: NOW - 90 * DAY,
          lastVerifiedAt: NOW - 10 * DAY,
        },
      ],
      NOW - 90 * DAY,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW - 90 * DAY });

    // Delete old L2 chunks so no new confirmations exist
    for (const token of await storage.listL2ChunkPaths()) {
      await storage.deleteL2Chunk(token);
    }

    // Archival threshold is 60 days. lastConfirmedAt is 90 days old, but
    // lastVerifiedAt is only 10 days old — should survive.
    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      config: { maxAgeWithoutConfirmMs: 60 * DAY, minRecallCount: 1 },
    });
    expect(out.archivedCount).toBe(0);
    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0].archived).toBe(false);
  });
});
