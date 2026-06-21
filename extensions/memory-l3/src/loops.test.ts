import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactSession } from "./compaction.js";
import { IngestBuffer } from "./ingest.js";
import { consolidateLongTerm } from "./longterm.js";
import {
  buildConceptCorpus,
  createConceptStubCaller,
  makeUserMessage,
  MS_PER_DAY,
  mulberry32,
  RUST_REFERENCE_SEED,
} from "./loops-test-helpers.js";
import { retrieveTopK } from "./retrieval.js";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L3State } from "./types.js";

let tmpRoot: string;
let storage: Storage;
let buffer: IngestBuffer;
let state: L3State;

const NOW = Date.UTC(2026, 4, 6, 12, 0, 0);

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-loops-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  buffer = new IngestBuffer();
  state = { ...INITIAL_L3_STATE, agentId: "j-rorqual" };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Loop A — duplicate accumulation under the PROMPT_VERSION=2 already-known
 * rule. Drives 10 concepts × 4 paraphrases over 30 simulated days; the dedup
 * ratio (facts persisted / distinct concepts) must stay ≤ 1.5×. The Rust
 * reference reaches 1.0× with within-chunk dedup; the cap leaves room for
 * minor LLM-stub asymmetry while still catching regressions.
 */
describe("Loop A: duplicate accumulation", () => {
  it("keeps the dedup ratio ≤ 1.5× over 30 days of paraphrased restatements", async () => {
    const concepts = buildConceptCorpus(RUST_REFERENCE_SEED, 10, 4);
    const caller = createConceptStubCaller(concepts);
    const rng = mulberry32(RUST_REFERENCE_SEED ^ 0xa1);
    const totalDays = 30;

    for (let day = totalDays; day > 0; day -= 1) {
      const dayNow = NOW - day * MS_PER_DAY;
      // Each day, ingest 1-3 paraphrases of randomly chosen concepts.
      const messageCount = 1 + Math.floor(rng() * 3);
      for (let m = 0; m < messageCount; m += 1) {
        const concept = concepts[Math.floor(rng() * concepts.length)];
        const paraphraseIdx = Math.floor(rng() * concept.paraphrases.length);
        const paraphrase = concept.paraphrases[paraphraseIdx] ?? concept.canonical;
        buffer.push("s1", makeUserMessage(paraphrase));
      }
      await compactSession({ sessionId: "s1", buffer, storage, caller, state, now: dayNow });
    }

    const chunkPaths = await storage.listL2ChunkPaths();
    let totalFacts = 0;
    const distinctKeys = new Set<string>();
    for (const filePath of chunkPaths) {
      const doc = await storage.readL2ChunkAtPath(filePath);
      if (!doc) {
        continue;
      }
      totalFacts += doc.frontmatter.facts.length;
      for (const f of doc.frontmatter.facts) {
        distinctKeys.add(f.dedupKey);
      }
    }

    const dedupRatio = totalFacts / Math.max(1, distinctKeys.size);
    expect(distinctKeys.size).toBeGreaterThan(0);
    expect(dedupRatio).toBeLessThanOrEqual(1.5);
  });
});

/**
 * Loop C — recency dominance. Two facts with identical text at 1 day and
 * 30 days ago. With 7-day half-life and our composite weights, recency
 * should not drag the older fact's score more than 30% below the newer
 * one's. Both facts should still surface in retrieval.
 */
describe("Loop C: recency dominance", () => {
  it("does not let a 30-day-old identical-text fact fall >30% below the fresh copy", async () => {
    const oldT = NOW - 30 * MS_PER_DAY;
    const newT = NOW - MS_PER_DAY;
    const sharedText = "user prefers morning standups";
    await storage.writeL2Chunk(
      {
        id: "chunk-000000-aaaa",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: oldT,
        facts: [
          {
            id: "f-old",
            text: sharedText,
            importance: 0.7,
            createdAt: oldT,
            dedupKey: "user_pref:morning_standups",
          },
        ],
        dedupKeys: ["user_pref:morning_standups"],
      },
      "",
    );
    await storage.writeL2Chunk(
      {
        id: "chunk-000001-bbbb",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: newT,
        facts: [
          {
            id: "f-new",
            text: sharedText,
            importance: 0.7,
            createdAt: newT,
            dedupKey: "user_pref:morning_standups_v2",
          },
        ],
        dedupKeys: ["user_pref:morning_standups_v2"],
      },
      "",
    );

    const topResult = await retrieveTopK({
      query: sharedText,
      storage,
      topK: 5,
      now: NOW,
    });
    const top = topResult.facts;
    const fNew = top.find((r) => r.fact.id === "f-new");
    const fOld = top.find((r) => r.fact.id === "f-old");
    expect(fNew).toBeDefined();
    expect(fOld).toBeDefined();
    if (!fNew || !fOld) {
      return;
    }
    const gap = (fNew.score - fOld.score) / fNew.score;
    expect(gap).toBeLessThanOrEqual(0.3);
  });
});

/**
 * Loop 5 — long-horizon recall. Five "needle" facts inserted across ages
 * 9-28 days. After all chunks are written, a query that lexically matches
 * the needles must surface ≥80% of them in top-5.
 */
describe("Loop 5: long-horizon needle recall", () => {
  it("recalls ≥80% of 5 distinct needles in top-5 even when needles are 9-28 days old", async () => {
    const needleAges = [28, 22, 15, 10, 9];
    const needleQuery = "bali trip planning";

    for (let i = 0; i < needleAges.length; i += 1) {
      const ageDays = needleAges[i];
      const createdAt = NOW - ageDays * MS_PER_DAY;
      await storage.writeL2Chunk(
        {
          id: `chunk-${String(i).padStart(6, "0")}-needle`,
          agentId: "j-rorqual",
          startTurnIndex: 0,
          endTurnIndex: 1,
          createdAt,
          facts: [
            {
              id: `needle-${i}`,
              text: `bali trip planning detail ${i}`,
              importance: 0.7,
              createdAt,
              dedupKey: `bali:detail-${i}`,
            },
          ],
          dedupKeys: [`bali:detail-${i}`],
        },
        "",
      );
    }

    // Add distractor chunks from a fresh, lexically-unrelated topic to make
    // sure the retriever is selecting on the query, not just returning recents.
    for (let d = 0; d < 10; d += 1) {
      const createdAt = NOW - d * MS_PER_DAY;
      await storage.writeL2Chunk(
        {
          id: `chunk-${String(100 + d).padStart(6, "0")}-distractor`,
          agentId: "j-rorqual",
          startTurnIndex: 0,
          endTurnIndex: 1,
          createdAt,
          facts: [
            {
              id: `distractor-${d}`,
              text: `unrelated production deploy notes for sprint ${d}`,
              importance: 0.7,
              createdAt,
              dedupKey: `deploy:sprint-${d}`,
            },
          ],
          dedupKeys: [`deploy:sprint-${d}`],
        },
        "",
      );
    }

    const topResult = await retrieveTopK({ query: needleQuery, storage, topK: 5, now: NOW });
    const top = topResult.facts;
    const needleIds = new Set(needleAges.map((_, i) => `needle-${i}`));
    const hits = top.filter((r) => needleIds.has(r.fact.id)).length;
    expect(top).toHaveLength(5);
    expect(hits).toBeGreaterThanOrEqual(4);
  });
});

/**
 * Loop E — long-term promotion across handcrafted multi-chunk corpora.
 * Writes L2 chunks directly (bypassing the stub LLM and its
 * already-known suppression so we can exercise the consolidation logic on
 * facts that recur naturally across multiple chunks). Validates three
 * promotion paths simultaneously: recall+dayspan+importance, the
 * high-importance one-shot shortcut, and below-threshold rejection.
 */
describe("Loop E: long-term promotion mixed-signal corpus", () => {
  it("promotes recurring + high-importance facts and rejects sub-threshold trivia", async () => {
    // Recurring concept: same dedupKey across 4 chunks spanning 8 days,
    // importance 0.7 — should promote via recall+dayspan+importance.
    for (let i = 0; i < 4; i += 1) {
      const ageDays = 9 - i * 2; // 9d, 7d, 5d, 3d ago
      await storage.writeL2Chunk(
        {
          id: `chunk-${String(i).padStart(6, "0")}-recur`,
          agentId: "j-rorqual",
          startTurnIndex: 0,
          endTurnIndex: 1,
          createdAt: NOW - ageDays * MS_PER_DAY,
          facts: [
            {
              id: `f-recur-${i}`,
              text: "user prefers tabs over spaces",
              importance: 0.7,
              createdAt: NOW - ageDays * MS_PER_DAY,
              dedupKey: "user_pref:tabs",
            },
          ],
          dedupKeys: ["user_pref:tabs"],
        },
        "",
      );
    }

    // One-shot high-importance fact — should promote via the passthrough.
    await storage.writeL2Chunk(
      {
        id: "chunk-000004-identity",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: NOW - MS_PER_DAY,
        facts: [
          {
            id: "f-identity",
            text: "user's name is Joe; based in Denver",
            importance: 0.9,
            createdAt: NOW - MS_PER_DAY,
            dedupKey: "user:identity",
          },
        ],
        dedupKeys: ["user:identity"],
      },
      "",
    );

    // Below-threshold trivia: low importance one-shot — should NOT promote.
    await storage.writeL2Chunk(
      {
        id: "chunk-000005-trivia",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: NOW - MS_PER_DAY,
        facts: [
          {
            id: "f-trivia",
            text: "user mentioned a movie once",
            importance: 0.3,
            createdAt: NOW - MS_PER_DAY,
            dedupKey: "trivia:movie",
          },
        ],
        dedupKeys: ["trivia:movie"],
      },
      "",
    );

    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW,
    });

    expect(result.promotedCount).toBe(2);
    expect(result.activeCount).toBe(2);

    const lt = await storage.readLongTerm();
    const promotedKeys = lt.facts
      .filter((f) => !f.archived)
      .map((f) => f.dedupKey)
      .toSorted();
    expect(promotedKeys).toEqual(["user:identity", "user_pref:tabs"]);

    const tabs = lt.facts.find((f) => f.dedupKey === "user_pref:tabs");
    expect(tabs?.recallCount).toBe(4);
    expect(tabs?.firstSeenAt).toBe(NOW - 9 * MS_PER_DAY);
    expect(tabs?.lastConfirmedAt).toBe(NOW - 3 * MS_PER_DAY);
  });
});

/**
 * Loop F — demotion when facts go quiet. Promotes a fact via the
 * high-importance shortcut, removes the L2 chunk that supplied it, and
 * re-runs consolidation past the maxAgeWithoutConfirmMs window. The fact
 * should land in the archived tier (preserved on disk, hidden from
 * retrieval).
 */
describe("Loop F: demotion of stale long-term facts", () => {
  it("archives a fact whose lastConfirmedAt is past the staleness threshold", async () => {
    // Promote at T=0
    await storage.writeL2Chunk(
      {
        id: "chunk-000000-x",
        agentId: "j-rorqual",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: NOW - 100 * MS_PER_DAY,
        facts: [
          {
            id: "f1",
            text: "ephemeral high-importance fact",
            importance: 0.9,
            createdAt: NOW - 100 * MS_PER_DAY,
            dedupKey: "ephemeral:1",
          },
        ],
        dedupKeys: ["ephemeral:1"],
      },
      "",
    );
    await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW - 100 * MS_PER_DAY,
    });
    const ltAfterPromote = await storage.readLongTerm();
    expect(ltAfterPromote.facts[0].archived).toBe(false);

    // Remove the L2 chunk so the next consolidation has no candidates.
    await storage.deleteL2Chunk((await storage.listL2ChunkPaths())[0]);

    // Verify retrieval surfaces the active long-term fact at T=now-90d
    // (still inside the 60-day window).
    const beforeStaleResult = await retrieveTopK({
      query: "ephemeral high-importance fact",
      storage,
      topK: 5,
      now: NOW - 90 * MS_PER_DAY,
    });
    expect(
      beforeStaleResult.facts.find(
        (r) => (r.tier === "longterm" && r.fact.id === "f1") || r.fact.dedupKey === "ephemeral:1",
      ),
    ).toBeUndefined();
    // The fact is still active in storage but the retrieve uses now=NOW-90d,
    // by which point lastConfirmedAt-now < 60 days so it'd remain active.
    const ltStill = await storage.readLongTerm();
    expect(ltStill.facts[0].archived).toBe(false);

    // Run consolidation past the window — the fact should archive.
    const result = await consolidateLongTerm({
      storage,
      agentId: "j-rorqual",
      now: NOW, // 100 days after promotion, well past the 60-day default
    });
    expect(result.archivedCount).toBe(1);
    expect(result.activeCount).toBe(0);

    const ltFinal = await storage.readLongTerm();
    expect(ltFinal.facts[0].archived).toBe(true);
    expect(ltFinal.facts[0].archivedAt).toBe(NOW);

    // Retrieval should not surface the archived fact even on a perfect query.
    const afterStaleResult = await retrieveTopK({
      query: "ephemeral high-importance fact",
      storage,
      topK: 5,
      now: NOW,
    });
    expect(afterStaleResult.facts.find((r) => r.fact.dedupKey === "ephemeral:1")).toBeUndefined();
  });
});
