// G4 pattern completion: a fact that does NOT match the query but is edge-linked
// to a strong hit is pulled into the results when expandTopN > 0 (CA3-style
// completion), and stays absent otherwise.
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HEBBIAN_CONFIG } from "./hebbian.js";
import { retrieveTopK } from "./retrieval.js";
import { Storage } from "./storage.js";

const NOW = Date.UTC(2026, 4, 7, 12, 0, 0);
let tmpRoot: string;
let storage: Storage;

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-hebexp-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  // One chunk, two facts: A matches "pi-hole" queries, B (NUC RAM) does not.
  await storage.writeL2Chunk(
    {
      id: "chunk-1",
      agentId: "a",
      startTurnIndex: 0,
      endTurnIndex: 1,
      createdAt: NOW,
      facts: [
        {
          id: "fa",
          text: "Pi-hole lives on the NUC",
          importance: 0.7,
          createdAt: NOW,
          dedupKey: "infra:pihole",
        },
        {
          id: "fb",
          text: "NUC has 32GB RAM",
          importance: 0.6,
          createdAt: NOW,
          dedupKey: "infra:nuc-ram",
        },
      ],
      dedupKeys: ["infra:pihole", "infra:nuc-ram"],
    },
    "body",
  );
  // Strong co-occurrence edge between the two (keys sorted: nuc-ram < pihole).
  await storage.writeEdgeMap([{ a: "infra:nuc-ram", b: "infra:pihole", weight: 5 }]);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const QUERY = "where does the pi-hole live";

describe("Hebbian expansion (G4 pattern completion)", () => {
  it("does NOT surface the non-matching neighbor without expansion", async () => {
    const res = await retrieveTopK({
      query: QUERY,
      storage,
      topK: 1,
      now: NOW,
      hebbianConfig: { ...DEFAULT_HEBBIAN_CONFIG, expandTopN: 0 },
    });
    expect(res.facts.some((f) => f.fact.dedupKey === "infra:pihole")).toBe(true);
    expect(res.facts.some((f) => f.fact.dedupKey === "infra:nuc-ram")).toBe(false);
  });

  it("pulls the edge-linked neighbor into results when expandTopN > 0", async () => {
    const res = await retrieveTopK({
      query: QUERY,
      storage,
      topK: 1,
      now: NOW,
      hebbianConfig: { ...DEFAULT_HEBBIAN_CONFIG, expandTopN: 1 },
    });
    const hit = res.facts.find((f) => f.fact.dedupKey === "infra:pihole");
    const completed = res.facts.find((f) => f.fact.dedupKey === "infra:nuc-ram");
    expect(hit).toBeDefined();
    expect(completed).toBeDefined();
    // The pulled neighbor ranks below the genuine match.
    expect(completed!.score).toBeLessThan(hit!.score);
  });
});

// F8 (2026-08-28): definition-pull regression — when a kept referent's
// definition fact is edge-linked to a strong hit, pattern completion must
// surface the definition chunk. This is the verification half of the
// dangling-reference finding: the soft mechanism should already cover the
// "referent kept, definition dropped" failure mode, so a regression here
// is the trigger to build a hard definition-pull.
describe("Hebbian expansion (F8 definition pull)", () => {
  const NOW2 = Date.UTC(2026, 7, 28, 12, 0, 0);
  let defRoot: string;
  let defStorage: Storage;

  beforeEach(async () => {
    defRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-hebdef-"));
    defStorage = new Storage(path.join(defRoot, ".openclaw", "l3"));
    await defStorage.writeL2Chunk(
      {
        id: "chunk-def",
        agentId: "a",
        startTurnIndex: 0,
        endTurnIndex: 1,
        createdAt: NOW2,
        facts: [
          {
            id: "fd-usage",
            text: "QMD compression was enabled on the gateway",
            importance: 0.8,
            createdAt: NOW2,
            dedupKey: "infra:qmd-enabled",
          },
          {
            id: "fd-def",
            text: "QMD = query metadata dedup cache (definition)",
            importance: 0.5,
            createdAt: NOW2,
            dedupKey: "glossary:qmd",
          },
        ],
        dedupKeys: ["infra:qmd-enabled", "glossary:qmd"],
      },
      "body",
    );
    await defStorage.writeEdgeMap([{ a: "glossary:qmd", b: "infra:qmd-enabled", weight: 4 }]);
  });

  afterEach(() => {
    rmSync(defRoot, { recursive: true, force: true });
  });

  it("pulls the edge-linked definition for a kept referent", async () => {
    const res = await retrieveTopK({
      query: "is QMD compression enabled on the gateway",
      storage: defStorage,
      topK: 1,
      now: NOW2,
      hebbianConfig: { ...DEFAULT_HEBBIAN_CONFIG, expandTopN: 1 },
    });
    const hit = res.facts.find((f) => f.fact.dedupKey === "infra:qmd-enabled");
    const definition = res.facts.find((f) => f.fact.dedupKey === "glossary:qmd");
    expect(hit).toBeDefined();
    expect(definition).toBeDefined();
    expect(definition!.score).toBeLessThan(hit!.score);
  });
});
