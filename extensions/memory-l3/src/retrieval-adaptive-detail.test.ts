// ARCH-2: Adaptive fact granularity in L3 retrieval (REFACT-inspired,
// arXiv:2507.15147) — test manifest T1–T7 per the 2026-11-16 test-stage doc
// (ERRATUM applied: T2 fixture carries a 7-word head clause; guard stays 6).
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compressFactsForResult,
  DEFAULT_RETRIEVAL_CONFIG,
  retrieveTopK,
  truncateToFirstClause,
  type RetrievedFact,
} from "./retrieval.js";
import { Storage } from "./storage.js";
import type { L2ChunkFrontmatter } from "./types.js";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const zeroSignals = (): RetrievedFact["signals"] => ({
  lexical: 0,
  bm25: 0,
  importance: 0,
  recency: 0,
  l3Boost: 0,
  semantic: 0,
  informationGain: 0,
  goalRelevance: 0,
  reliability: 0,
  semanticEntropy: 0,
  validity: 1,
  entityScore: 0,
  temporalAlignment: 0,
  polarityMultiplier: 1,
});

const retrievedFact = (
  id: string,
  text: string,
  chunkId: string,
  tier: RetrievedFact["tier"],
): RetrievedFact => ({
  fact: {
    id,
    text,
    importance: 0.5,
    createdAt: NOW,
    dedupKey: `k:${id}`,
  },
  score: 1,
  signals: zeroSignals(),
  chunkId,
  tier,
});

describe("adaptive fact detail", () => {
  // T1 — OFF contract: no flags ⇒ every intent returns the input by reference.
  it("flags OFF: all three intents return input by reference", () => {
    const facts = [
      retrievedFact(
        "p1",
        "Joe lives in the Denver metro area, which sits at the foot of the Rockies.",
        "c1",
        "l2",
      ),
      retrievedFact("t1", "home_city = Denver", "c1", "typed"),
      retrievedFact("lt1", "timezone = America/Denver", "c2", "longterm-typed"),
    ];
    for (const intent of ["factual", "multihop", "synthesis"] as const) {
      const out = compressFactsForResult(facts, intent);
      expect(out).toBe(facts); // same array reference — no clone
      expect(out[0]).toBe(facts[0]); // same element references — no text change
      expect(out[1]).toBe(facts[1]);
      expect(out[2]).toBe(facts[2]);
    }
  });

  // T2 — factual + adaptive: 7-word head clause (ERRATUM fixture) is trimmed
  // at the first comma boundary with an ellipsis suffix.
  it("factual + adaptiveFactDetail: long head clause trimmed", () => {
    const facts = [
      retrievedFact(
        "p1",
        "Joe lives in the Denver metro area, which sits at the foot of the Rockies, and likes manga.",
        "c1",
        "l2",
      ),
    ];
    const out = compressFactsForResult(facts, "factual", { adaptiveFactDetail: true });
    expect(out[0]?.fact.text).toBe("Joe lives in the Denver metro area …");
  });

  // T3 — 6-word guard: a short head clause falls back to the first sentence
  // (unchanged when the text IS one sentence).
  it("short head clause: first-sentence fallback", () => {
    const facts = [retrievedFact("p1", "He moved, recently, to Denver.", "c1", "l2")];
    const out = compressFactsForResult(facts, "factual", { adaptiveFactDetail: true });
    expect(out[0]?.fact.text).toBe("He moved, recently, to Denver.");

    // Guard unit cases: short comma clause and no comma at all.
    expect(truncateToFirstClause("He moved, recently, to Denver.")).toBe(
      "He moved, recently, to Denver.",
    );
    expect(truncateToFirstClause("One sentence without any comma here.")).toBe(
      "One sentence without any comma here.",
    );
  });

  // T4 — multihop: the adaptive flag is a no-op (output identical to OFF).
  it("multihop: adaptive flag is a no-op", () => {
    const facts = [
      retrievedFact(
        "p1",
        "The pi-hole filters DNS for the whole LAN, and the router forwards queries to it first. It has run since June without incidents.",
        "c1",
        "l2",
      ),
    ];
    const out = compressFactsForResult(facts, "multihop", { adaptiveFactDetail: true });
    expect(out).toBe(facts); // identical to the flags-OFF run — same reference
  });

  // T5 — synthesis + provenance: prose facts gain a "(source: <chunkId>)"
  // suffix; with the flag OFF the input comes back by reference.
  it("synthesis + includeFactProvenance: suffix appended", () => {
    const facts = [
      retrievedFact("p1", "Joe tracks a underground greenhouse build.", "c1", "l2"),
      retrievedFact("p2", "HueyTheDestroyer runs the docker stack.", "c2", "l2"),
    ];
    const out = compressFactsForResult(facts, "synthesis", { includeFactProvenance: true });
    expect(out[0]?.fact.text).toBe("Joe tracks a underground greenhouse build. (source: c1)");
    expect(out[1]?.fact.text).toBe("HueyTheDestroyer runs the docker stack. (source: c2)");

    const off = compressFactsForResult(facts, "synthesis");
    expect(off).toBe(facts); // OFF → same reference (re-asserted scoped)
  });

  // T6 — typed tiers pass through by reference under BOTH flags.
  it("typed tiers never altered by either flag", () => {
    const facts = [
      retrievedFact("t1", "home_city = Denver", "c1", "typed"),
      retrievedFact("lt1", "timezone = America/Denver", "c1", "longterm-typed"),
      retrievedFact(
        "p1",
        "Joe lives in the Denver metro area, which sits at the foot of the Rockies.",
        "c1",
        "l2",
      ),
    ];
    const out = compressFactsForResult(facts, "factual", {
      adaptiveFactDetail: true,
      includeFactProvenance: true,
    });
    expect(out[0]).toBe(facts[0]); // typed: same object
    expect(out[1]).toBe(facts[1]); // longterm-typed: same object
    expect(out[2]?.fact.text).toBe("Joe lives in the Denver metro area …"); // prose still trimmed
  });

  // T7 — integration: compression runs BEFORE the token-budget trim, so
  // provenance suffix tokens are budget-counted (F2: the store must be
  // seeded — a chunkless store early-returns []).
  describe("budget interplay (integration)", () => {
    let tmpRoot: string;
    let storage: Storage;

    beforeEach(() => {
      tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-adaptive-"));
      storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
    });

    afterEach(() => {
      rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("suffix tokens are budget-counted", async () => {
      const facts: L2ChunkFrontmatter["facts"] = [
        {
          id: "f-match",
          text: "The denver manga shelf holds a complete One Piece run.",
          importance: 0.5,
          createdAt: NOW,
          dedupKey: "k:1",
        },
        {
          id: "f-filler-1",
          text: "A second unrelated sentence describing weather patterns across the high plains and mountains.",
          importance: 0.5,
          createdAt: NOW,
          dedupKey: "k:2",
        },
        {
          id: "f-filler-2",
          text: "Another filler sentence about unrelated topics like furniture arrangement and renovation.",
          importance: 0.5,
          createdAt: NOW,
          dedupKey: "k:3",
        },
      ];
      await storage.writeL2Chunk(
        {
          id: "c-1",
          agentId: "j-rorqual",
          startTurnIndex: 0,
          endTurnIndex: 1,
          createdAt: NOW,
          facts,
          typedFacts: [],
          dedupKeys: facts.map((f) => f.dedupKey),
        },
        "",
      );

      const { facts: result } = await retrieveTopK({
        query: "summarize the denver manga shelf", // routed → synthesis intent
        storage,
        topK: 5,
        now: NOW,
        retrievalConfig: {
          ...DEFAULT_RETRIEVAL_CONFIG,
          mode: "routed",
          includeFactProvenance: true,
          maxInjectedTokens: 100,
        },
      });

      // Budget trim dropped low-score facts despite the suffix inflating
      // survivor line lengths (compress-before-trim ordering).
      expect(result.length).toBeGreaterThan(0);
      expect(result.length).toBeLessThan(3);
      for (const rf of result) {
        expect(rf.fact.text).toContain("(source: c-1)");
      }
    });
  });
});
