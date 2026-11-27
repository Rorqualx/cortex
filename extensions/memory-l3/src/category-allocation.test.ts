/**
 * Probe spike (f19820b6 v1 — utility-scaled category allocation). THROWAWAY:
 * feasibility proof for the probe stage; the 06:00 implementer rebuilds from
 * the report doc (memory/reports/lab/2026-11-26_f19820b6.md). Covers the
 * 11-25 plan §Probe spec: (a) allocateCategoryCaps pure laws, (b) budget-fn
 * threading (armed retention SET must change — the 11-22 inertness failure
 * inverted), (c) operators-lane per-group pressure, (d) compactSession
 * lazy-gate + absent-DB identity, (e) readUtilityMaps never-creates laws.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  allocateCategoryCaps,
  applyCategoryBudget,
  applyCategoryBudgetWithOperators,
  compactSession,
} from "./compaction.js";
import {
  closeRetrievalUseStoreForTest,
  readUtilityMaps,
  recordRetrievalUses,
} from "./retrieval-use-store.js";
import { IngestBuffer } from "./ingest.js";
import type { LlmCaller } from "./llm.js";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L3State } from "./types.js";

// Spy-wrap readUtilityMaps so the compactSession lazy-gate can be proven by
// call count (zero reads when weight = 0), while armed tests keep real behavior.
vi.mock("./retrieval-use-store.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("./retrieval-use-store.js")
  >();
  return { ...actual, readUtilityMaps: vi.fn(actual.readUtilityMaps) };
});

const userMsg = (text: string) => ({ role: "user", content: text }) as never;

/** Fact with a 36-char text ⇒ estimateFactTokens = ceil(36/4)+1 = 10 tokens. */
const fact = (key: string, importance: number) => ({
  text: `fact text for ${key} padded to length`.padEnd(36, "."),
  importance,
  dedupKey: key,
});

/** Write offline utility tables into <dir>/retrieval-use.sqlite (fixture). */
function writeUtilityTables(
  dir: string,
  opts: { wal?: boolean; categories?: Record<string, number>; chunks?: Record<string, number> },
): void {
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(path.join(dir, "retrieval-use.sqlite"));
  if (opts.wal) db.exec("PRAGMA journal_mode = WAL;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS chunk_utility (chunk_id TEXT PRIMARY KEY, utility REAL NOT NULL)",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS category_utility (category TEXT PRIMARY KEY, utility REAL NOT NULL)",
  );
  const chunkStmt = db.prepare(
    "INSERT OR REPLACE INTO chunk_utility (chunk_id, utility) VALUES (?, ?)",
  );
  for (const [k, v] of Object.entries(opts.chunks ?? {})) chunkStmt.run(k, v);
  const catStmt = db.prepare(
    "INSERT OR REPLACE INTO category_utility (category, utility) VALUES (?, ?)",
  );
  for (const [k, v] of Object.entries(opts.categories ?? {})) catStmt.run(k, v);
  db.close();
}

let tmpRoot: string;
let storage: Storage;
let buffer: IngestBuffer;
let state: L3State;

beforeEach(() => {
  vi.mocked(readUtilityMaps).mockClear();
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-utility-alloc-"));
  storage = new Storage(path.join(tmpRoot, ".openclaw", "l3"));
  buffer = new IngestBuffer();
  state = { ...INITIAL_L3_STATE, agentId: "j-rorqual" };
});

afterEach(() => {
  closeRetrievalUseStoreForTest();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("allocateCategoryCaps (pure laws)", () => {
  it("OFF identity: weight 0 ⇒ every cap = baseCap even with a non-flat map", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map([["a", 1], ["b", 0]]), 0);
    expect([...caps.values()]).toEqual([100, 100]);
  });

  it("empty utility map + weight > 0 ⇒ identity (never throws)", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map(), 0.5);
    expect([...caps.values()]).toEqual([100, 100]);
  });

  it("utility-flat identity: all present categories equal ⇒ all caps = baseCap", () => {
    const caps = allocateCategoryCaps(["a", "b", "c"], 100, new Map([["a", 0.6], ["b", 0.6]]), 0.5);
    expect([...caps.values()]).toEqual([100, 100, 100]);
  });

  it("armed redistribution: {a:1,b:0} w=0.5 ⇒ 125/75, sum = 2×base", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map([["a", 1], ["b", 0]]), 0.5);
    expect(caps.get("a")).toBe(125);
    expect(caps.get("b")).toBe(75);
    const sum = [...caps.values()].reduce((x, y) => x + y, 0);
    expect(sum).toBe(200);
  });

  it("starvation floor binds under extreme weight: w=2 {a:1,b:0} ⇒ cap_b = floor(100/4) = 25", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map([["a", 1], ["b", 0]]), 2);
    expect(caps.get("b")).toBe(25);
    expect(caps.get("a")).toBe(200);
  });

  it("unknown category gets u=0 while the mean covers present categories only", () => {
    const caps = allocateCategoryCaps(["a", "b", "c"], 100, new Map([["a", 1]]), 0.5);
    expect(caps.get("a")).toBe(100); // u = mean ⇒ base
    expect(caps.get("b")).toBe(50); // u = 0, mean = 1
    expect(caps.get("c")).toBe(50);
  });

  it("all categories absent from a non-empty map ⇒ identity", () => {
    const caps = allocateCategoryCaps(["x", "y"], 100, new Map([["a", 1]]), 0.5);
    expect([...caps.values()]).toEqual([100, 100]);
  });
});

describe("applyCategoryBudget threading", () => {
  const facts = [
    fact("alpha:1", 0.9),
    fact("alpha:2", 0.8),
    fact("beta:1", 0.7),
    fact("beta:2", 0.6),
  ];

  it("OFF identity: weight 0 + armed map ⇒ deep-equals unarmed (facts AND order)", () => {
    const unarmed = applyCategoryBudget(facts, 20);
    const armed = applyCategoryBudget(facts, 20, {
      categoryUtility: new Map([["alpha", 1], ["beta", 0]]),
      utilityAllocationWeight: 0,
    });
    expect(armed).toEqual(unarmed);
  });

  it("weight absent (opts omitted) ⇒ deep-equals unarmed", () => {
    const unarmed = applyCategoryBudget(facts, 20);
    expect(applyCategoryBudget(facts, 20, undefined)).toEqual(unarmed);
  });

  it("armed {alpha:1,beta:0} w=0.5 ⇒ retention SET changes (cap_beta 20→15 drops beta:2)", () => {
    const unarmed = applyCategoryBudget(facts, 20);
    const armed = applyCategoryBudget(facts, 20, {
      categoryUtility: new Map([["alpha", 1], ["beta", 0]]),
      utilityAllocationWeight: 0.5,
    });
    expect(armed).not.toEqual(unarmed);
    expect(unarmed.map((f) => f.dedupKey).sort()).toEqual(["alpha:1", "alpha:2", "beta:1", "beta:2"]);
    expect(armed.map((f) => f.dedupKey).sort()).toEqual(["alpha:1", "alpha:2", "beta:1"]);
  });
});

describe("applyCategoryBudgetWithOperators threading", () => {
  const facts = [
    fact("alpha:1", 0.9),
    fact("alpha:2", 0.8),
    fact("beta:1", 0.7),
    fact("beta:2", 0.6),
  ];

  it("OFF identity: weight 0 + armed map ⇒ deep-equals unarmed", async () => {
    const unarmed = await applyCategoryBudgetWithOperators({ facts, maxTokensPerCategory: 20 });
    const armed = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 20,
      categoryUtility: new Map([["alpha", 1], ["beta", 0]]),
      utilityAllocationWeight: 0,
    });
    expect(armed).toEqual(unarmed);
  });

  it("per-group cap flows into pressure: beta (cap 15) hits the merge lane, alpha (cap 25) does not", async () => {
    const unarmed = await applyCategoryBudgetWithOperators({ facts, maxTokensPerCategory: 20 });
    // Unarmed: both categories 20/20 tokens ⇒ pressure 0 ⇒ all 4 retained.
    expect(unarmed).toHaveLength(4);

    const armed = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 20,
      categoryUtility: new Map([["alpha", 1], ["beta", 0]]),
      utilityAllocationWeight: 0.5,
    });
    // Armed: alpha cap 25 keeps low-pressure retain (2 originals, unchanged);
    // beta cap 15 ⇒ pressure 1/3 ≥ 0.3 ⇒ merge lane: beta:1 retained, beta:2
    // overflows, cannot merge alone, exceeds remaining budget ⇒ dropped.
    expect(armed).toHaveLength(3);
    const alphaFacts = armed.filter((f) => f.dedupKey.startsWith("alpha:"));
    expect(alphaFacts).toEqual([
      expect.objectContaining({ dedupKey: "alpha:1" }),
      expect.objectContaining({ dedupKey: "alpha:2" }),
    ]);
    expect(armed.map((f) => f.dedupKey).sort()).toEqual(["alpha:1", "alpha:2", "beta:1"]);
  });
});

describe("readUtilityMaps (never-creates laws)", () => {
  it("absent dir ⇒ empty maps, no file created", () => {
    const dir = path.join(tmpRoot, "no-such-dir");
    const maps = readUtilityMaps({ dir });
    expect(maps.chunks.size).toBe(0);
    expect(maps.categories.size).toBe(0);
    expect(existsSync(path.join(dir, "retrieval-use.sqlite"))).toBe(false);
  });

  it("reads chunk and category utility tables when present", () => {
    const dir = path.join(tmpRoot, "util");
    writeUtilityTables(dir, {
      chunks: { "chunk-1": 0.25, "chunk-2": 1 },
      categories: { alpha: 1, beta: 0.4 },
    });
    const maps = readUtilityMaps({ dir });
    expect(maps.chunks.get("chunk-1")).toBe(0.25);
    expect(maps.chunks.get("chunk-2")).toBe(1);
    expect(maps.categories.get("alpha")).toBe(1);
    expect(maps.categories.get("beta")).toBe(0.4);
  });

  it("WAL-mode DB with utility tables (compute-script realistic shape) still reads", () => {
    const dir = path.join(tmpRoot, "wal");
    writeUtilityTables(dir, { wal: true, categories: { alpha: 1, beta: 0 } });
    const maps = readUtilityMaps({ dir });
    expect(maps.categories.get("alpha")).toBe(1);
    expect(maps.categories.get("beta")).toBe(0);
  });

  it("DB with only retrieval_use_daily (no utility tables) ⇒ empty maps", () => {
    const dir = path.join(tmpRoot, "daily-only");
    recordRetrievalUses({
      sessionId: "s",
      items: [{ chunkId: "chunk-1", tier: "l2" }],
      dir,
    });
    const maps = readUtilityMaps({ dir });
    expect(maps.chunks.size).toBe(0);
    expect(maps.categories.size).toBe(0);
  });

  it("corrupt DB file ⇒ empty maps, never throws", () => {
    const dir = path.join(tmpRoot, "corrupt");
    writeUtilityTables(dir, { categories: { alpha: 1 } });
    writeFileSync(path.join(dir, "retrieval-use.sqlite"), "not a database at all");
    const maps = readUtilityMaps({ dir });
    expect(maps.chunks.size).toBe(0);
    expect(maps.categories.size).toBe(0);
  });
});

describe("compactSession lazy gate + threading", () => {
  const caller: LlmCaller = vi.fn(async () =>
    JSON.stringify({
      facts: [
        { text: "fact text for alpha:1 padded to length".padEnd(36, "."), importance: 0.9, dedupKey: "alpha:1" },
        { text: "fact text for alpha:2 padded to length".padEnd(36, "."), importance: 0.8, dedupKey: "alpha:2" },
        { text: "fact text for beta:1 padded to length".padEnd(36, "."), importance: 0.7, dedupKey: "beta:1" },
        { text: "fact text for beta:2 padded to length".padEnd(36, "."), importance: 0.6, dedupKey: "beta:2" },
      ],
    }),
  ) as unknown as LlmCaller;

  async function runCompact(weight: number | undefined) {
    await storage.ensureLayout();
    const freshBuffer = new IngestBuffer();
    freshBuffer.push("s1", userMsg("hello with enough content to extract facts from"));
    return compactSession({
      sessionId: "s1",
      buffer: freshBuffer,
      storage,
      caller,
      state,
      categoryBudget: 20,
      ...(weight === undefined ? {} : { utilityAllocationWeight: weight }),
    });
  }

  it("weight 0 ⇒ ZERO store reads even with armed utility data on disk", async () => {
    writeUtilityTables(storage.root, { categories: { alpha: 1, beta: 0 } });
    const result = await runCompact(0);
    expect(result.factsAdded).toBe(4);
    expect(readUtilityMaps).not.toHaveBeenCalled();
  });

  it("weight 0.5 + absent DB ⇒ identity (factsAdded equals unarmed), store read exactly once", async () => {
    const baseline = await runCompact(0);
    const armed = await runCompact(0.5);
    expect(armed.factsAdded).toBe(baseline.factsAdded);
    expect(armed.factsAdded).toBe(4);
    expect(readUtilityMaps).toHaveBeenCalledTimes(1);
  });

  it("weight 0.5 + real utility tables ⇒ end-to-end armed retention change (4 → 3)", async () => {
    writeUtilityTables(storage.root, { categories: { alpha: 1, beta: 0 } });
    const armed = await runCompact(0.5);
    expect(armed.factsAdded).toBe(3);
    expect(readUtilityMaps).toHaveBeenCalledTimes(1);
  });
});
