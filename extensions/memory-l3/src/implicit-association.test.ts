/**
 * Implicit-association test suite for the LongMemEval harness.
 *
 * Ported from InMind's 125-task benchmark pattern (arXiv:2607.24368):
 * tests whether facts correctly stored and directly recallable are also
 * surfaced for *indirect* queries that require the fact without naming it.
 *
 * **Expected behaviour:** Direct queries should always pass (sanity check).
 * Indirect queries will likely FAIL — this is the diagnostic value. The
 * retrieval pipeline scores primarily on BM25 lexical overlap, so an
 * indirect query like "should I try the almond macarons?" won't match
 * the fact text "user has a tree-nut allergy" through any lexical signal.
 *
 * When these tests fail, they demonstrate the gap that ARCH-1 (persistent-
 * context routing for high-consequence facts) is designed to close.
 */

import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPLICIT_ASSOCIATION_CASES } from "./implicit-association-cases.js";
import { retrieveTopK } from "./retrieval.js";
import { Storage } from "./storage.js";
import type { L2ChunkFrontmatter, TypedFact } from "./types.js";

let tmpRoot: string;
let storage: Storage;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-implicit-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** Write a single chunk containing all prose + typed facts from a test case. */
async function ingestCase(
  caseId: string,
  facts: L2ChunkFrontmatter["facts"],
  typedFacts: TypedFact[],
  createdAt: number,
): Promise<void> {
  await storage.writeL2Chunk(
    {
      id: `chunk-${caseId}`,
      agentId: "test-agent",
      startTurnIndex: 0,
      endTurnIndex: 1,
      createdAt,
      facts,
      typedFacts,
      dedupKeys: facts.map((f) => f.dedupKey),
    },
    "",
  );
}

describe("implicit-association: direct queries (sanity checks)", () => {
  // Each case should pass direct recall — if it doesn't, the storage or
  // scoring pipeline is broken, not the indirect-association logic.
  for (const tc of IMPLICIT_ASSOCIATION_CASES) {
    it(`direct: ${tc.id} — "${tc.directQuery}"`, async () => {
      const ts = tc.factsToIngest[0]?.createdAt ?? Date.UTC(2026, 6, 15);
      await ingestCase(tc.id, tc.factsToIngest, tc.typedFactsToIngest ?? [], ts);

      const { facts } = await retrieveTopK({
        query: tc.directQuery,
        storage,
        topK: 5,
        now: ts + 86400000,
      });

      expect(facts.length).toBeGreaterThan(0);
      const combined = facts.map((f) => f.fact.text).join(" ");
      expect(combined.toLowerCase()).toContain(tc.expectedSubstring.toLowerCase());
    });
  }
});

describe("implicit-association: indirect queries (diagnostic)", () => {
  // These tests probe whether facts surface for queries that share minimal
  // lexical overlap with the fact text. They are EXPECTED TO FAIL initially —
  // the diagnostic value is in documenting the retrieval blind spot.
  //
  // When ARCH-1 (persistent-context routing) lands, flip these from
  // it.fails() to it() and expect them to pass.
  for (const tc of IMPLICIT_ASSOCIATION_CASES) {
    it.fails(`indirect: ${tc.id} — "${tc.indirectQuery}" should surface "${tc.expectedSubstring}"`, async () => {
      const ts = tc.factsToIngest[0]?.createdAt ?? Date.UTC(2026, 6, 15);
      await ingestCase(tc.id, tc.factsToIngest, tc.typedFactsToIngest ?? [], ts);

      const { facts } = await retrieveTopK({
        query: tc.indirectQuery,
        storage,
        topK: 5,
        now: ts + 86400000,
      });

      // This assertion is expected to fail: the indirect query shares
      // almost no tokens with the stored fact, so BM25 won't match.
      const combined = facts.map((f) => f.fact.text).join(" ");
      expect(combined.toLowerCase()).toContain(tc.expectedSubstring.toLowerCase());
    });
  }
});
