/**
 * PROBE SPIKE (THROWAWAY) — ARCH-2 f19820b6: utility-scaled category
 * allocation. The cron worktree resets nightly; the finding lives in
 * memory/reports/lab/<cycleDate>_f19820b6.md, NOT here.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allocateCategoryCaps,
  applyCategoryBudget,
  applyCategoryBudgetWithOperators,
  compactSession,
} from "./compaction.js";
import { IngestBuffer } from "./ingest.js";
import type { LlmCaller } from "./llm.js";
import { readUtilityMaps } from "./retrieval-use-store.js";
import { Storage } from "./storage.js";
import { INITIAL_L3_STATE, type L3State } from "./types.js";

const userMsg = (text: string) => ({ role: "user", content: text }) as never;

// 30-char text => ceil(30/4)+1 = 9 tokens; 4 facts/category = 36 tokens.
const shortFact = (i: number, importance: number) => ({
  text: "a" + i + " " + "x".repeat(27),
  importance,
  dedupKey: "a:" + i,
});
const shortFactB = (i: number, importance: number) => ({
  text: "b" + i + " " + "y".repeat(27),
  importance,
  dedupKey: "b:" + i,
});

describe("allocateCategoryCaps (pure laws)", () => {
  it("weight 0 => baseCap everywhere (OFF-identity)", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map([["a", 1], ["b", 0]]), 0);
    expect([...caps.values()]).toEqual([100, 100]);
  });

  it("empty utility map + weight > 0 => identity", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map(), 0.5);
    expect([...caps.values()]).toEqual([100, 100]);
  });

  it("map present but no category matches => identity", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map([["z", 1]]), 0.5);
    expect([...caps.values()]).toEqual([100, 100]);
  });

  it("utility-flat: all present equal => baseCap for present categories", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map([["a", 0.4], ["b", 0.4]]), 0.5);
    expect(caps.get("a")).toBe(100);
    expect(caps.get("b")).toBe(100);
  });

  it("armed redistribution: {a:1,b:0} w=0.5 => cap_a > base > cap_b, total conserved", () => {
    const caps = allocateCategoryCaps(["a", "b"], 100, new Map([["a", 1], ["b", 0]]), 0.5);
    expect(caps.get("a")).toBe(125);
    expect(caps.get("b")).toBe(75);
    expect(caps.get("a")! + caps.get("b")!).toBe(200);
  });

  it("starvation floor: majority-hot fixture floors the cold category at max(1, base/4)", () => {
    // 5 categories: 4 hot (u=1), 1 cold (u=0). mean=0.8; raw cold cap
    // = round(100 * (1 - 0.8)) = 20 < floor 25 => floored.
    const cats = ["h1", "h2", "h3", "h4", "cold"];
    const util = new Map([["h1", 1], ["h2", 1], ["h3", 1], ["h4", 1]]);
    const caps = allocateCategoryCaps(cats, 100, util, 1);
    expect(caps.get("cold")).toBe(25);
    expect(caps.get("h1")).toBe(120);
  });

  it("unknown category => u=0 treatment; mean over present only", () => {
    const caps = allocateCategoryCaps(["a", "b", "c"], 100, new Map([["a", 1], ["b", 1]]), 0.5);
    expect(caps.get("a")).toBe(100);
    expect(caps.get("b")).toBe(100);
    expect(caps.get("c")!).toBeLessThan(100);
    expect(caps.get("c")!).toBeGreaterThanOrEqual(25);
  });
});

describe("applyCategoryBudget (plain lane threading)", () => {
  const facts = [
    shortFact(1, 0.9), shortFact(2, 0.8), shortFact(3, 0.7), shortFact(4, 0.6),
    shortFactB(1, 0.9), shortFactB(2, 0.8), shortFactB(3, 0.7), shortFactB(4, 0.6),
  ];

  it("OFF-identity: no opts => byte-identical to legacy call (facts AND order)", () => {
    const unarmed = applyCategoryBudget(facts, 20);
    const offOpts = applyCategoryBudget(facts, 20, {
      categoryUtility: new Map([["a", 1], ["b", 0]]),
      utilityAllocationWeight: 0,
    });
    expect(offOpts).toEqual(unarmed);
    const absentOpts = applyCategoryBudget(facts, 20, { utilityAllocationWeight: 0.5 });
    expect(absentOpts).toEqual(unarmed);
  });

  it("armed {a:1,b:0} w=1: retention SET actually changes (NOT deep-equal)", () => {
    const unarmed = applyCategoryBudget(facts, 20);
    const armed = applyCategoryBudget(facts, 20, {
      categoryUtility: new Map([["a", 1], ["b", 0]]),
      utilityAllocationWeight: 1,
    });
    // The 11-22 inertness failure inverted: armed must NOT deep-equal unarmed.
    expect(armed).not.toEqual(unarmed);
    const armedKeys = armed.map((f) => f.dedupKey);
    const aCount = armedKeys.filter((k) => k.startsWith("a:")).length;
    const bCount = armedKeys.filter((k) => k.startsWith("b:")).length;
    // cap_a = 30 (3 facts fit), cap_b = 10 (1 fact fits) vs 2/2 unarmed.
    expect(aCount).toBe(3);
    expect(bCount).toBe(1);
  });
});

describe("applyCategoryBudgetWithOperators (operators lane threading)", () => {
  const facts = [
    shortFact(1, 0.9), shortFact(2, 0.8), shortFact(3, 0.7), shortFact(4, 0.6),
    shortFactB(1, 0.9), shortFactB(2, 0.8), shortFactB(3, 0.7), shortFactB(4, 0.6),
  ];

  it("unarmed: both categories retain 2 (legacy behavior)", async () => {
    const res = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 20,
    });
    const aCount = res.filter((f) => f.dedupKey.startsWith("a:")).length;
    const bCount = res.filter((f) => f.dedupKey.startsWith("b:")).length;
    expect(aCount).toBe(2);
    expect(bCount).toBe(2);
  });

  it("armed: per-group cap flows through pressure — hot category retains 3, cold 1", async () => {
    const res = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 20,
      categoryUtility: new Map([["a", 1], ["b", 0]]),
      utilityAllocationWeight: 1,
    });
    const aCount = res.filter((f) => f.dedupKey.startsWith("a:")).length;
    const bCount = res.filter((f) => f.dedupKey.startsWith("b:")).length;
    // cap_a = 30 => pressure 0.2 < 0.3 => LOW branch => 3 facts fit.
    // cap_b = 10 => pressure 2.6 >= 0.3 => moderate => 1 retained, overflow
    // unmergeable (distinct subKeys) and below remaining budget => dropped.
    expect(aCount).toBe(3);
    expect(bCount).toBe(1);
  });

  it("OFF-identity: weight 0 => armed-eqs-unarmed deep-equal", async () => {
    const unarmed = await applyCategoryBudgetWithOperators({ facts, maxTokensPerCategory: 20 });
    const off = await applyCategoryBudgetWithOperators({
      facts,
      maxTokensPerCategory: 20,
      categoryUtility: new Map([["a", 1], ["b", 0]]),
      utilityAllocationWeight: 0,
    });
    expect(off).toEqual(unarmed);
  });
});

describe("readUtilityMaps (spike rebuild of plan piece 1)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-utility-maps-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("absent dir => empty maps; never creates the DB", () => {
    const dir = path.join(tmpRoot, "no-such-dir");
    const maps = readUtilityMaps({ dir });
    expect(maps.chunks.size).toBe(0);
    expect(maps.categories.size).toBe(0);
    expect(existsSync(path.join(dir, "retrieval-use.sqlite"))).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });

  it("DB present without utility tables => empty maps, no throw", () => {
    const dir = path.join(tmpRoot, "l3");
    mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(dir, "retrieval-use.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS retrieval_use_daily (day TEXT, chunk_id TEXT, tier TEXT, uses INTEGER)");
    db.close();
    const maps = readUtilityMaps({ dir });
    expect(maps.chunks.size).toBe(0);
    expect(maps.categories.size).toBe(0);
  });

  it("seeded utility tables round-trip", () => {
    const dir = path.join(tmpRoot, "l3");
    mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(path.join(dir, "retrieval-use.sqlite"));
    db.exec("CREATE TABLE chunk_utility (chunk_id TEXT PRIMARY KEY, utility REAL NOT NULL)");
    db.exec("CREATE TABLE category_utility (category TEXT PRIMARY KEY, utility REAL NOT NULL)");
    db.prepare("INSERT INTO chunk_utility VALUES (?, ?)").run("c1", 0.75);
    db.prepare("INSERT INTO category_utility VALUES (?, ?)").run("alpha", 1);
    db.prepare("INSERT INTO category_utility VALUES (?, ?)").run("beta", 0);
    db.close();
    const maps = readUtilityMaps({ dir });
    expect(maps.chunks.get("c1")).toBe(0.75);
    expect(maps.categories.get("alpha")).toBe(1);
    expect(maps.categories.get("beta")).toBe(0);
  });
});

describe("compactSession lazy-gate + end-to-end threading (probe law d)", () => {
  // alpha: 41 chars => 11 tokens; 5 facts = 55. beta: 100 chars => 26 tokens.
  const alphaFacts = [1, 2, 3, 4, 5].map((i) => ({
    text: "alpha fact " + i + " " + "x".repeat(30),
    importance: 0.9 - i * 0.05,
    dedupKey: "alpha:" + i,
  }));
  const betaFacts = [1, 2, 3, 4, 5].map((i) => ({
    text: "beta fact " + i + " " + "y".repeat(89),
    importance: 0.9 - i * 0.05,
    dedupKey: "beta:" + i,
  }));
  const caller: LlmCaller = vi.fn(async () =>
    JSON.stringify({ facts: [...alphaFacts, ...betaFacts] }),
  );
  const CATEGORY_BUDGET = 40;

  const runCompact = async (utilityAllocationWeight: number, seeded: boolean) => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "memory-l3-cs-alloc-"));
    const l3Root = path.join(tmpRoot, ".openclaw", "l3");
    const storage = new Storage(l3Root);
    await storage.ensureLayout();
    if (seeded) {
      mkdirSync(l3Root, { recursive: true });
      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(path.join(l3Root, "retrieval-use.sqlite"));
      db.exec("CREATE TABLE category_utility (category TEXT PRIMARY KEY, utility REAL NOT NULL)");
      db.prepare("INSERT INTO category_utility VALUES (?, ?)").run("alpha", 1);
      db.prepare("INSERT INTO category_utility VALUES (?, ?)").run("beta", 0);
      db.close();
    }
    const buffer = new IngestBuffer();
    buffer.push("s1", userMsg("we are discussing alpha and beta topics at length"));
    const state: L3State = { ...INITIAL_L3_STATE, agentId: "j-rorqual" };
    const result = await compactSession({
      sessionId: "s1",
      buffer,
      storage,
      caller,
      state,
      categoryBudget: CATEGORY_BUDGET,
      utilityAllocationWeight,
    });
    const dbCreated = existsSync(path.join(l3Root, "retrieval-use.sqlite"));
    rmSync(tmpRoot, { recursive: true, force: true });
    return { result, dbCreated };
  };

  it("weight > 0 + absent DB => identity vs weight 0, and no DB file created", async () => {
    const unarmed = await runCompact(0, false);
    const armedAbsent = await runCompact(1, false);
    expect(armedAbsent.result.factsAdded).toBe(unarmed.result.factsAdded);
    expect(armedAbsent.dbCreated).toBe(false);
  });

  it("weight > 0 + seeded DB => retention actually changes end-to-end", async () => {
    const unarmed = await runCompact(0, true);
    const armed = await runCompact(1, true);
    // Unarmed: cap 40 => alpha 3 (33 <= 40), beta 1 (26 <= 40) => 4 facts.
    // Armed: cap_alpha = 60 => all 5 alpha; cap_beta = 20 => 0 beta => 5.
    expect(unarmed.result.factsAdded).toBe(4);
    expect(armed.result.factsAdded).toBe(5);
  });
});
