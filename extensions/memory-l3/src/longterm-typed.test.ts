import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consolidateLongTermTyped,
  derivePerishability,
  deriveVolatilityClass,
} from "./longterm-typed.js";
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

describe("deriveVolatilityClass", () => {
  it("returns volatile for API slots", () => {
    expect(deriveVolatilityClass("infra:api_endpoint", "")).toBe("volatile");
  });

  it("returns volatile for config slots", () => {
    expect(deriveVolatilityClass("app:config", "")).toBe("volatile");
  });

  it("returns volatile for version slots", () => {
    expect(deriveVolatilityClass("pkg:version", "")).toBe("volatile");
  });

  it("returns volatile for path slots", () => {
    expect(deriveVolatilityClass("proj:root_path", "")).toBe("volatile");
  });

  it("returns volatile for token/password slots", () => {
    expect(deriveVolatilityClass("auth:api_token", "")).toBe("volatile");
    expect(deriveVolatilityClass("auth:password", "")).toBe("volatile");
  });

  it("returns stable for preference slots", () => {
    expect(deriveVolatilityClass("user:preference_theme", "")).toBe("stable");
  });

  it("returns stable for name slots", () => {
    expect(deriveVolatilityClass("user:name", "")).toBe("stable");
  });

  it("returns stable for relationship slots", () => {
    expect(deriveVolatilityClass("user:relationship_status", "")).toBe("stable");
  });

  it("returns stable for favorite/like slots", () => {
    expect(deriveVolatilityClass("user:favorite_color", "")).toBe("stable");
    expect(deriveVolatilityClass("user:dislike_food", "")).toBe("stable");
  });

  it("returns semi-volatile for unrecognized slots", () => {
    expect(deriveVolatilityClass("misc:note", "")).toBe("semi-volatile");
    expect(deriveVolatilityClass("unknown:thing", "")).toBe("semi-volatile");
  });

  it("prefers volatile over stable when both tokens match", () => {
    // "config" is volatile, "preference" is stable — volatile wins
    expect(deriveVolatilityClass("app:config_preference", "")).toBe("volatile");
  });
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
    expect(ltt.facts[0]!.slot).toBe("user:phone");
    expect(ltt.facts[0]!.value).toBe("555-1234");
    expect(ltt.facts[0]!.history).toEqual([]);
    expect(ltt.facts[0]!.recallCount).toBe(1);
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
    expect(ltt.facts[0]!.value).toBe("750.00");
    expect(ltt.facts[0]!.history).toHaveLength(1);
    expect(ltt.facts[0]!.history[0]!.value).toBe("500.00");
    expect(ltt.facts[0]!.recallCount).toBe(2);
  });

  it("sets conflictWith flag when a value is superseded by a contradictory one", async () => {
    await writeChunkWithTyped(
      "chunk-conf-old",
      [
        {
          id: "tf-conf-old",
          slot: "user:phone",
          value: "555-1234",
          sourceSpan: "my number is 555-1234",
          unit: null,
          confidence: 0.95,
          createdAt: NOW - 5 * DAY,
        },
      ],
      NOW - 5 * DAY,
    );
    // First pass promotes the old value.
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW - 5 * DAY });

    await writeChunkWithTyped(
      "chunk-conf-new",
      [
        {
          id: "tf-conf-new",
          slot: "user:phone",
          value: "555-9999",
          sourceSpan: "changed to 555-9999",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );
    // Second pass supersedes with the new value.
    const out = await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW });
    expect(out.supersededCount).toBe(1);

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.value).toBe("555-9999");
    expect(ltt.facts[0]!.conflictWith).toBeDefined();
    expect(ltt.facts[0]!.conflictWith).toBe(ltt.facts[0]!.id);
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
    expect(ltt.facts[0]!.value).toBe("192.168.50.128");
    expect(ltt.facts[0]!.history).toEqual([]);
    expect(ltt.facts[0]!.recallCount).toBe(2);
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
    expect(ltt.facts[0]!.value).toBe("750.00");
    expect(ltt.facts[0]!.history).toHaveLength(1);
    expect(ltt.facts[0]!.history[0]!.value).toBe("500.00");
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
      config: { maxAgeWithoutConfirmMs: 60 * DAY, minRecallCount: 1, maxPromotePerEpoch: 30 },
    });
    expect(out.archivedCount).toBe(1);
    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.archived).toBe(true);
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
    expect(ltt1.facts[0]!.lastVerifiedAt).toBe(NOW - 3 * DAY);

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
    expect(ltt2.facts[0]!.lastVerifiedAt).toBe(NOW);
    expect(ltt2.facts[0]!.recallCount).toBe(2);
  });

  it("assigns volatile class for config/API-related slots", async () => {
    await writeChunkWithTyped(
      "chunk-api",
      [
        {
          id: "tf-api",
          slot: "infra:api_endpoint",
          value: "https://api.example.com/v2",
          sourceSpan: "api is at https://api.example.com/v2",
          unit: null,
          confidence: 0.9,
          createdAt: NOW,
        },
      ],
      NOW,
    );

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.volatilityClass).toBe("volatile");
  });

  it("assigns stable class for preference/name slots", async () => {
    await writeChunkWithTyped(
      "chunk-pref",
      [
        {
          id: "tf-pref",
          slot: "user:preference_theme",
          value: "dark",
          sourceSpan: "prefers dark theme",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.volatilityClass).toBe("stable");
  });

  it("assigns semi-volatile for unrecognized slots", async () => {
    await writeChunkWithTyped(
      "chunk-generic",
      [
        {
          id: "tf-gen",
          slot: "misc:note",
          value: "some note",
          sourceSpan: "just a note",
          unit: null,
          confidence: 0.8,
          createdAt: NOW,
        },
      ],
      NOW,
    );

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.volatilityClass).toBe("semi-volatile");
  });

  it("preserves volatilityClass on reaffirmation", async () => {
    await writeChunkWithTyped(
      "chunk-1",
      [
        {
          id: "tf-1",
          slot: "infra:api_host",
          value: "api.example.com",
          sourceSpan: "api host is api.example.com",
          unit: null,
          confidence: 0.9,
          createdAt: NOW - 3 * DAY,
        },
      ],
      NOW - 3 * DAY,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW - 3 * DAY });

    // Reaffirm same value
    await writeChunkWithTyped(
      "chunk-2",
      [
        {
          id: "tf-2",
          slot: "infra:api_host",
          value: "api.example.com",
          sourceSpan: "still api.example.com",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.volatilityClass).toBe("volatile");
    expect(ltt.facts[0]!.recallCount).toBe(2);
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
      config: { maxAgeWithoutConfirmMs: 60 * DAY, minRecallCount: 1, maxPromotePerEpoch: 30 },
    });
    expect(out.archivedCount).toBe(0);
    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.archived).toBe(false);
  });

  it("stamps sourceSessionId on promoted facts when sessionId is provided", async () => {
    await writeChunkWithTyped(
      "chunk-sess",
      [
        {
          id: "tf-sess",
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

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      sessionId: "session-abc-123",
      modelId: "deepseek/deepseek-v4-pro",
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.sourceSessionId).toBe("session-abc-123");
    expect(ltt.facts[0]!.sourceModel).toBe("deepseek/deepseek-v4-pro");
  });

  it("leaves sourceSessionId unset when sessionId is not provided (backward compat)", async () => {
    await writeChunkWithTyped(
      "chunk-nosess",
      [
        {
          id: "tf-nosess",
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

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.sourceSessionId).toBeUndefined();
    expect(ltt.facts[0]!.sourceModel).toBeNull();
  });

  it("updates sourceSessionId on reaffirmation when a newer session is provided", async () => {
    await writeChunkWithTyped(
      "chunk-old",
      [
        {
          id: "tf-old",
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
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW - 3 * DAY,
      sessionId: "session-old",
    });

    await writeChunkWithTyped(
      "chunk-new",
      [
        {
          id: "tf-new",
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
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      sessionId: "session-new",
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.sourceSessionId).toBe("session-new");
    expect(ltt.facts[0]!.recallCount).toBe(2);
  });

  it("caps newly promoted slots at maxPromotePerEpoch (J-space capacity)", async () => {
    // Create 35 distinct slots — exceeds default cap of 30.
    // The top 30 by recallCount * confidence should be kept;
    // the bottom 5 should be dropped back to L2.
    const totalSlots = 35;
    const cap = 30;
    const slots: Array<{ id: number; recallCount: number; confidence: number }> = [];
    for (let i = 0; i < totalSlots; i++) {
      // Vary recallCount and confidence so we get a clear ordering.
      // High-index slots have lower scores and should be dropped.
      const recallCount = 1 + Math.floor(i / 5); // 0-4→1, 5-9→2, ..., 30-34→7
      const confidence = 0.5 + (totalSlots - i) * 0.01; // 0.85 down to ~0.51
      slots.push({ id: i, recallCount, confidence });
    }

    for (const s of slots) {
      // Write the same fact across `recallCount` chunks to build recall.
      for (let r = 0; r < s.recallCount; r++) {
        await writeChunkWithTyped(
          `chunk-cap-s${s.id}-r${r}`,
          [
            {
              id: `tf-cap-${s.id}-${r}`,
              slot: `test:slot_${String(s.id).padStart(2, "0")}`,
              value: `value_${s.id}`,
              sourceSpan: `source ${s.id}`,
              unit: null,
              confidence: s.confidence,
              createdAt: NOW,
            },
          ],
          NOW,
        );
      }
    }

    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });
    expect(out.promotedCount).toBe(cap);
    expect(out.activeCount).toBe(cap);

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts).toHaveLength(cap);

    // The kept slots should be the ones with the highest recallCount * confidence.
    // Sort slots by score, descending.
    const sorted = [...slots].toSorted(
      (a, b) => b.recallCount * b.confidence - a.recallCount * a.confidence,
    );
    const expectedKept = new Set(
      sorted.slice(0, cap).map((s) => `test:slot_${String(s.id).padStart(2, "0")}`),
    );
    const expectedDropped = new Set(
      sorted.slice(cap).map((s) => `test:slot_${String(s.id).padStart(2, "0")}`),
    );

    for (const fact of ltt.facts) {
      expect(expectedKept.has(fact.slot)).toBe(true);
      expect(expectedDropped.has(fact.slot)).toBe(false);
    }
  });

  // -----------------------------------------------------------------
  // QW-2: Retrieval-frequency boost in J-space capacity scoring
  // -----------------------------------------------------------------
  it("boosts frequently-retrieved L2 typed facts in J-space capacity cap", async () => {
    // Create 35 identical-score slots. Pre-populate retrieval signals for
    // 5 specific L2 typed fact IDs. Those 5 should survive the cap because
    // their retrieval-hit boost lifts their score above the rest.
    const totalSlots = 35;
    const cap = 30;
    const boostedSlots = new Set([
      "test:rh_30",
      "test:rh_31",
      "test:rh_32",
      "test:rh_33",
      "test:rh_34",
    ]);

    for (let i = 0; i < totalSlots; i++) {
      const slotName = `test:rh_${i}`;
      const factId = `tf-rh-${i}`;
      // Write 2 chunks per slot so recallCount = 2 (meets minRecallCount)
      for (let r = 0; r < 2; r++) {
        await writeChunkWithTyped(
          `chunk-rh-${i}-${r}`,
          [
            {
              id: `${factId}-${r}`,
              slot: slotName,
              value: `val_${i}`,
              sourceSpan: `source ${i}`,
              unit: null,
              confidence: 0.7,
              createdAt: NOW,
            },
          ],
          NOW,
        );
      }
    }

    // Pre-write retrieval signals for the L2 typed fact IDs of boosted slots.
    // The retrieval signal factId matches the L2 typed fact's id field.
    const signals = Array.from(boostedSlots).flatMap((slot) => {
      const i = parseInt(slot.split("_")[1], 10);
      return [
        {
          factId: `tf-rh-${i}-0`,
          recallCount: 20,
          lastRecalledAt: NOW,
          firstRecalledAt: NOW - DAY,
        },
        {
          factId: `tf-rh-${i}-1`,
          recallCount: 20,
          lastRecalledAt: NOW,
          firstRecalledAt: NOW - DAY,
        },
      ];
    });
    await storage.writeRetrievalSignals(signals);

    const out = await consolidateLongTermTyped({
      storage,
      agentId: "test",
      now: NOW,
      config: {
        maxAgeWithoutConfirmMs: 60 * DAY,
        minRecallCount: 1,
        maxPromotePerEpoch: cap,
        retrievalHitBoost: 1.0, // High boost to make the signal dominant
      },
    });
    expect(out.promotedCount).toBe(cap);

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts).toHaveLength(cap);

    // The 5 boosted slots must survive the cap.
    for (const slot of boostedSlots) {
      expect(ltt.facts.some((f) => f.slot === slot)).toBe(true);
    }
  });

  // -----------------------------------------------------------------
  // Provenance (QW-1: Typed-Fact Provenance Fields)
  // -----------------------------------------------------------------

  it("sets provenance on promotion with quote, chunkId, and sessionId", async () => {
    await writeChunkWithTyped(
      "chunk-prov-1",
      [
        {
          id: "tf-prov-1",
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

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      sessionId: "session-prov-1",
      modelId: "deepseek/deepseek-v4-pro",
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.provenance).toEqual({
      quote: "my phone is 555-1234",
      chunkId: "chunk-prov-1",
      sessionId: "session-prov-1",
    });
  });

  it("leaves provenance unset when sessionId is not provided", async () => {
    await writeChunkWithTyped(
      "chunk-noprov",
      [
        {
          id: "tf-noprov",
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

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.provenance).toBeUndefined();
  });

  it("updates provenance on supersession with the new value's source span", async () => {
    await writeChunkWithTyped(
      "chunk-prov-old",
      [
        {
          id: "tf-prov-old",
          slot: "user:account_balance",
          value: "500.00",
          sourceSpan: "balance is 500.00 USD",
          unit: "USD",
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
      sessionId: "session-old",
    });

    await writeChunkWithTyped(
      "chunk-prov-new",
      [
        {
          id: "tf-prov-new",
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
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      sessionId: "session-new",
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.value).toBe("750.00");
    expect(ltt.facts[0]!.provenance).toEqual({
      quote: "balance is now 750.00 USD",
      chunkId: "chunk-prov-new",
      sessionId: "session-new",
    });
  });

  it("updates provenance on reaffirmation with the latest source span", async () => {
    await writeChunkWithTyped(
      "chunk-reaffirm-old",
      [
        {
          id: "tf-reaffirm-old",
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
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW - 3 * DAY,
      sessionId: "session-a",
    });

    await writeChunkWithTyped(
      "chunk-reaffirm-new",
      [
        {
          id: "tf-reaffirm-new",
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
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      sessionId: "session-b",
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.provenance).toEqual({
      quote: "pi-hole still at 192.168.50.128",
      chunkId: "chunk-reaffirm-new",
      sessionId: "session-b",
    });
  });

  // -----------------------------------------------------------------
  // QW-3: Consolidation Skip for Stable Tiers (LeanMem-inspired)
  // -----------------------------------------------------------------

  it("skips reaffirmation for stable facts that are recently verified with multiple sources", async () => {
    // Write the same stable fact across 2 chunks to build recallCount=2
    const oldTime = NOW - 5 * DAY;
    await writeChunkWithTyped(
      "chunk-stable-1",
      [
        {
          id: "tf-stable-1",
          slot: "user:preference_theme",
          value: "dark",
          sourceSpan: "I prefer dark theme",
          unit: null,
          confidence: 0.95,
          createdAt: oldTime,
        },
      ],
      oldTime,
    );
    await writeChunkWithTyped(
      "chunk-stable-2",
      [
        {
          id: "tf-stable-2",
          slot: "user:preference_theme",
          value: "dark",
          sourceSpan: "still prefer dark",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );

    // First consolidation: promotes and establishes recallCount=2
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      sessionId: "session-1",
    });

    const ltt1 = await storage.readLongTermTyped();
    expect(ltt1.facts[0]!.volatilityClass).toBe("stable");
    expect(ltt1.facts[0]!.recallCount).toBe(2);
    expect(ltt1.facts[0]!.sourceSessionId).toBe("session-1");

    // Second pass: reaffirm with a third chunk from a different session
    // Since the fact is stable, recallCount > 1, and recently verified,
    // the consolidation skip should fire — provenance/sessionId unchanged.
    await writeChunkWithTyped(
      "chunk-stable-3",
      [
        {
          id: "tf-stable-3",
          slot: "user:preference_theme",
          value: "dark",
          sourceSpan: "dark theme is best",
          unit: null,
          confidence: 0.9,
          createdAt: NOW + DAY,
        },
      ],
      NOW + DAY,
    );

    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW + DAY,
      sessionId: "session-2",
    });

    // The skip means the fact was NOT re-processed — no reaffirmedCount bump.
    // (promotedCount=0, supersededCount=0, reaffirmedCount=0 for this slot)
    expect(out.reaffirmedCount).toBe(0);

    const ltt2 = await storage.readLongTermTyped();
    // Session ID should remain from the first pass (skip = no update)
    expect(ltt2.facts[0]!.sourceSessionId).toBe("session-1");
  });

  it("does NOT skip when stable fact value changes (supersession still fires)", async () => {
    const oldTime = NOW - 5 * DAY;
    await writeChunkWithTyped(
      "chunk-stable-old",
      [
        {
          id: "tf-so",
          slot: "user:favorite_color",
          value: "blue",
          sourceSpan: "favorite is blue",
          unit: null,
          confidence: 0.95,
          createdAt: oldTime,
        },
      ],
      oldTime,
    );
    await writeChunkWithTyped(
      "chunk-stable-old2",
      [
        {
          id: "tf-so2",
          slot: "user:favorite_color",
          value: "blue",
          sourceSpan: "still blue",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    // Now change the value
    await writeChunkWithTyped(
      "chunk-stable-new",
      [
        {
          id: "tf-sn",
          slot: "user:favorite_color",
          value: "green",
          sourceSpan: "now it's green",
          unit: null,
          confidence: 0.9,
          createdAt: NOW + DAY,
        },
      ],
      NOW + DAY,
    );
    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW + DAY,
    });

    expect(out.supersededCount).toBe(1);
    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.value).toBe("green");
    expect(ltt.facts[0]!.history).toHaveLength(1);
  });

  it("does NOT skip stable facts with recallCount === 1 (needs first consolidation)", async () => {
    await writeChunkWithTyped(
      "chunk-single",
      [
        {
          id: "tf-single",
          slot: "user:preference_theme",
          value: "dark",
          sourceSpan: "I prefer dark",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    // Second pass with a new chunk — recallCount=1 on the existing fact,
    // so shouldSkipStableMaintenance returns false and reaffirmation runs.
    await writeChunkWithTyped(
      "chunk-single-2",
      [
        {
          id: "tf-single-2",
          slot: "user:preference_theme",
          value: "dark",
          sourceSpan: "still dark",
          unit: null,
          confidence: 0.9,
          createdAt: NOW + DAY,
        },
      ],
      NOW + DAY,
    );
    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW + DAY,
    });
    expect(out.reaffirmedCount).toBe(1);
  });

  it("skips archival for stable recently-verified facts with no new candidates", async () => {
    // Create a stable fact with recallCount=2
    const oldTime = NOW - 40 * DAY;
    await writeChunkWithTyped(
      "chunk-stable-archive-1",
      [
        {
          id: "tf-sa1",
          slot: "user:name",
          value: "Joe",
          sourceSpan: "my name is Joe",
          unit: null,
          confidence: 0.99,
          createdAt: oldTime,
        },
      ],
      oldTime,
    );
    await writeChunkWithTyped(
      "chunk-stable-archive-2",
      [
        {
          id: "tf-sa2",
          slot: "user:name",
          value: "Joe",
          sourceSpan: "I'm Joe",
          unit: null,
          confidence: 0.99,
          createdAt: oldTime + DAY,
          lastVerifiedAt: NOW - 10 * DAY,
        },
      ],
      oldTime + DAY,
    );
    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: oldTime + DAY,
    });

    // Delete all chunks — no new candidates will appear
    for (const token of await storage.listL2ChunkPaths()) {
      await storage.deleteL2Chunk(token);
    }

    // Even though lastConfirmedAt is 40+ days old, the stable skip
    // prevents archival because lastVerifiedAt is only 10 days ago.
    const out = await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
      config: { maxAgeWithoutConfirmMs: 30 * DAY, minRecallCount: 1, maxPromotePerEpoch: 30 },
    });
    expect(out.archivedCount).toBe(0);
    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.archived).toBe(false);
  });

  // -----------------------------------------------------------------
  // QW-2: Source-Trust Provenance Tag (Memory Provenance Laundering)
  // -----------------------------------------------------------------

  it("defaults sourceTrust to 'user' when statedBy is absent", async () => {
    await writeChunkWithTyped(
      "chunk-trust-default",
      [
        {
          id: "tf-td",
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

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.sourceTrust).toBe("user");
  });

  it("sets sourceTrust to 'user' when statedBy is 'user'", async () => {
    await writeChunkWithTyped(
      "chunk-trust-user",
      [
        {
          id: "tf-tu",
          slot: "user:phone",
          value: "555-1234",
          sourceSpan: "my phone is 555-1234",
          unit: null,
          confidence: 0.9,
          createdAt: NOW,
          statedBy: "user",
        } as TypedFact,
      ],
      NOW,
    );

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.sourceTrust).toBe("user");
  });

  it("sets sourceTrust to 'web' when statedBy contains web/search patterns", async () => {
    await writeChunkWithTyped(
      "chunk-trust-web",
      [
        {
          id: "tf-tw",
          slot: "infra:public_ip",
          value: "203.0.113.5",
          sourceSpan: "IP is 203.0.113.5",
          unit: null,
          confidence: 0.7,
          createdAt: NOW,
          statedBy: "web-search-tool",
        } as TypedFact,
      ],
      NOW,
    );

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.sourceTrust).toBe("web");
  });

  it("sets sourceTrust to 'agent-inferred' when statedBy is 'assistant'", async () => {
    await writeChunkWithTyped(
      "chunk-trust-agent",
      [
        {
          id: "tf-ta",
          slot: "infra:estimated_uptime",
          value: "99.9%",
          sourceSpan: "estimated uptime is 99.9%",
          unit: "%",
          confidence: 0.6,
          createdAt: NOW,
          statedBy: "assistant",
        } as TypedFact,
      ],
      NOW,
    );

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.sourceTrust).toBe("agent-inferred");
  });

  it("updates sourceTrust on supersession with the new source's trust", async () => {
    // Original fact from user
    await writeChunkWithTyped(
      "chunk-trust-supersede-old",
      [
        {
          id: "tf-tso",
          slot: "user:phone",
          value: "555-old",
          sourceSpan: "my old phone",
          unit: null,
          confidence: 0.9,
          createdAt: NOW - 5 * DAY,
          statedBy: "user",
        } as TypedFact,
      ],
      NOW - 5 * DAY,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW - 5 * DAY });

    // New fact from assistant
    await writeChunkWithTyped(
      "chunk-trust-supersede-new",
      [
        {
          id: "tf-tsn",
          slot: "user:phone",
          value: "555-new",
          sourceSpan: "phone might be 555-new",
          unit: null,
          confidence: 0.6,
          createdAt: NOW,
          statedBy: "assistant",
        } as TypedFact,
      ],
      NOW,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.value).toBe("555-new");
    expect(ltt.facts[0]!.sourceTrust).toBe("agent-inferred");
  });

  // -----------------------------------------------------------------
  // QW-1: Per-Fact Perishability Coefficient (ScrubJay-MEM-inspired)
  // -----------------------------------------------------------------

  it("sets perishability on promotion", async () => {
    await writeChunkWithTyped(
      "chunk-perish-1",
      [
        {
          id: "tf-p1",
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

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.perishability).toBeDefined();
    expect(typeof ltt.facts[0]!.perishability).toBe("number");
    expect(ltt.facts[0]!.perishability).toBeGreaterThan(0);
    expect(ltt.facts[0]!.perishability).toBeLessThanOrEqual(1.2);
  });

  it("assigns lower perishability (more perishable) for volatile slots", async () => {
    await writeChunkWithTyped(
      "chunk-perish-vol",
      [
        {
          id: "tf-pv",
          slot: "infra:api_endpoint",
          value: "https://api.example.com",
          sourceSpan: "api at example.com",
          unit: null,
          confidence: 0.9,
          createdAt: NOW,
        },
      ],
      NOW,
    );
    await writeChunkWithTyped(
      "chunk-perish-stab",
      [
        {
          id: "tf-ps",
          slot: "user:name",
          value: "Joe",
          sourceSpan: "I'm Joe",
          unit: null,
          confidence: 0.9,
          createdAt: NOW,
        },
      ],
      NOW,
    );

    await consolidateLongTermTyped({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    const ltt = await storage.readLongTermTyped();
    const volatileFact = ltt.facts.find((f) => f.slot === "infra:api_endpoint");
    const stableFact = ltt.facts.find((f) => f.slot === "user:name");
    expect(volatileFact).toBeDefined();
    expect(stableFact).toBeDefined();
    expect(volatileFact!.perishability!).toBeLessThan(stableFact!.perishability!);
  });

  it("recomputes perishability on supersession", async () => {
    await writeChunkWithTyped(
      "chunk-perish-old",
      [
        {
          id: "tf-po",
          slot: "user:phone",
          value: "555-old",
          sourceSpan: "old phone",
          unit: null,
          confidence: 0.9,
          createdAt: NOW - 5 * DAY,
        },
      ],
      NOW - 5 * DAY,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW - 5 * DAY });

    const ltt1 = await storage.readLongTermTyped();
    const oldPerishability = ltt1.facts[0]!.perishability;

    await writeChunkWithTyped(
      "chunk-perish-new",
      [
        {
          id: "tf-pn",
          slot: "user:phone",
          value: "555-new",
          sourceSpan: "new phone",
          unit: null,
          confidence: 0.95,
          createdAt: NOW,
        },
      ],
      NOW,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW });

    const ltt2 = await storage.readLongTermTyped();
    expect(ltt2.facts[0]!.value).toBe("555-new");
    expect(ltt2.facts[0]!.perishability).toBeDefined();
    // Perishability should be recomputed (same slot/trust, so same value)
    expect(ltt2.facts[0]!.perishability).toBe(oldPerishability);
  });

  it("derivePerishability returns neutral for default semi-volatile", () => {
    const pi = derivePerishability({
      slot: "misc:note",
      value: "hello",
      volatilityClass: "semi-volatile",
      sourceTrust: "user",
    });
    // semi-volatile + user: 1.0 + 0.1 = 1.1
    expect(pi).toBeCloseTo(1.1, 2);
  });

  it("derivePerishability returns low value for volatile untrusted slot", () => {
    const pi = derivePerishability({
      slot: "infra:config_version",
      value: "v1.2.3",
      volatilityClass: "volatile",
      sourceTrust: "untrusted",
    });
    // volatile -0.3, perishable slot "version" is volatile token not perishable slot, untrusted -0.15
    // 1.0 - 0.3 - 0.15 = 0.55
    expect(pi).toBeLessThan(0.7);
  });

  it("derivePerishability returns high value for stable user-stated durable slot", () => {
    const pi = derivePerishability({
      slot: "user:name",
      value: "Joe",
      volatilityClass: "stable",
      sourceTrust: "user",
    });
    // stable +0.2, durable "name" +0.15, user +0.1 = 1.45, clamped to 1.2
    expect(pi).toBe(1.2);
  });
});

describe("QW5: temporalSpan + affect carry + scoring neutrality", () => {
  it("carries temporalSpan and affect through promotion", async () => {
    await writeChunkWithTyped(
      "chunk-000000-q5a",
      [
        {
          id: "tf-q5",
          slot: "schedule:standup",
          value: "9:00 AM MT",
          sourceSpan: "standup every Tuesday at 9:00 AM MT",
          unit: null,
          confidence: 0.9,
          createdAt: NOW,
          temporalSpan: "every Tuesday",
          affect: 0.4,
        },
      ],
      NOW,
    );
    await consolidateLongTermTyped({ storage, agentId: "j-rorqual", now: NOW });
    const ltt = await storage.readLongTermTyped();
    expect(ltt.facts[0]!.temporalSpan).toBe("every Tuesday");
    expect(ltt.facts[0]!.affect).toBe(0.4);
  });

  it("keeps promotion scoring neutral to the new fields", async () => {
    // Same slot/value/confidence consolidated in two independent stores; the
    // only difference is the presence of QW5 annotations. Every scoring-relevant
    // output must match exactly.
    const mkStorage = () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "l3-q5-neutral-"));
      return new Storage(path.join(dir, ".openclaw", "l3"));
    };
    const base = {
      slot: "user:phone",
      value: "555-1234",
      sourceSpan: "my number is 555-1234",
      unit: null as string | null,
      confidence: 0.8,
      createdAt: NOW,
    };
    const plainStore = mkStorage();
    const annotatedStore = mkStorage();
    try {
      for (const [store, extra] of [
        [plainStore, {}],
        [annotatedStore, { temporalSpan: "since 2024", affect: 0.9 }],
      ] as const) {
        await store.writeL2Chunk(
          {
            id: "chunk-000000-q5n",
            agentId: "j-rorqual",
            startTurnIndex: 0,
            endTurnIndex: 1,
            createdAt: NOW,
            facts: [],
            typedFacts: [{ id: "tf-q5-n", ...base, ...extra }],
            dedupKeys: [],
          },
          "",
        );
        await consolidateLongTermTyped({ storage: store, agentId: "j-rorqual", now: NOW });
      }
      const [plainFact] = (await plainStore.readLongTermTyped()).facts;
      const [annotatedFact] = (await annotatedStore.readLongTermTyped()).facts;
      expect(plainFact && annotatedFact).toBeTruthy();
      // Promotion/decay-relevant outputs must be identical.
      expect(annotatedFact!.confidence).toBe(plainFact!.confidence);
      expect(annotatedFact!.volatilityClass).toBe(plainFact!.volatilityClass);
      expect(annotatedFact!.recallCount).toBe(plainFact!.recallCount);
      expect(annotatedFact!.perishability).toEqual(plainFact!.perishability);
      expect(annotatedFact!.sourceTrust).toEqual(plainFact!.sourceTrust);
      // And the annotations themselves carried through.
      expect(annotatedFact!.temporalSpan).toBe("since 2024");
      expect(plainFact!.temporalSpan).toBeUndefined();
    } finally {
      rmSync(path.dirname(path.dirname(plainStore.root)), { recursive: true, force: true });
      rmSync(path.dirname(path.dirname(annotatedStore.root)), { recursive: true, force: true });
    }
  });
});
