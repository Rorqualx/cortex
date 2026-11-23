// PROBE SPIKE TESTS (card f19820b6, 2026-11-22) — decay math, normalization,
// category means, idempotency, dry-run no-write. Throwaway with the probe.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  categoryOfDedupKey,
  computeDecayedUtility,
  computeUtilityTables,
  daysBetween,
  main,
} from "./compute-retrieval-utility.mjs";

let tmpRoot: string;

function seedUseDb(dir: string, rows: Array<{ day: string; chunk_id: string; uses: number; tier?: string }>) {
  const db = new DatabaseSync(path.join(dir, "retrieval-use.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS retrieval_use_daily (
    day TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    uses INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, chunk_id, tier)
  );`);
  const ins = db.prepare(
    "INSERT OR REPLACE INTO retrieval_use_daily (day, chunk_id, tier, uses) VALUES (?, ?, ?, ?)",
  );
  for (const r of rows) ins.run(r.day, r.chunk_id, r.tier ?? "l2", r.uses);
  db.close();
}

function seedL3Db(dir: string, chunks: Array<{ id: string; frontmatter: unknown }>) {
  const db = new DatabaseSync(path.join(dir, "l3.sqlite"));
  db.exec(`CREATE TABLE IF NOT EXISTS l3_l2_chunks (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    frontmatter TEXT NOT NULL,
    body TEXT NOT NULL
  );`);
  const ins = db.prepare(
    "INSERT OR REPLACE INTO l3_l2_chunks (id, created_at, frontmatter, body) VALUES (?, ?, ?, ?)",
  );
  let t = 1;
  for (const c of chunks) ins.run(c.id, t++, JSON.stringify(c.frontmatter), "");
  db.close();
}

function tableNames(dir: string): string[] {
  const db = new DatabaseSync(path.join(dir, "retrieval-use.sqlite"), { readOnly: true });
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "compute-retrieval-utility-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("prefix + day laws", () => {
  it("daysBetween counts calendar days", () => {
    expect(daysBetween("2026-11-22", "2026-11-08")).toBe(14);
    expect(daysBetween("2026-11-22", "2026-11-22")).toBe(0);
  });
  it("categoryOfDedupKey mirrors the compaction prefix law", () => {
    expect(categoryOfDedupKey("alpha:x")).toBe("alpha");
    expect(categoryOfDedupKey("plain")).toBe("uncategorized");
    expect(categoryOfDedupKey(":lead")).toBe("uncategorized");
  });
});

describe("decay math (plan fixture)", () => {
  it("10 uses today + 10 @14d, halfLife 7 ⇒ decayed 12.5", () => {
    const rows = [
      { day: "2026-11-22", chunk_id: "c1", uses: 10 },
      { day: "2026-11-08", chunk_id: "c1", uses: 10 },
    ];
    const acc = computeDecayedUtility(rows, { halfLifeDays: 7, beforeDay: "2026-11-22" });
    expect(acc.get("c1")?.decayed).toBeCloseTo(12.5, 10);
    expect(acc.get("c1")?.usesTotal).toBe(20);
    expect(acc.get("c1")?.lastDay).toBe("2026-11-22");
  });
});

describe("computeUtilityTables normalization + category means", () => {
  it("normalizes to corpus max; category utility = mean over member chunks", () => {
    const useRows = [
      { day: "2026-11-22", chunk_id: "c1", uses: 10 },
      { day: "2026-11-08", chunk_id: "c1", uses: 10 }, // c1 decayed 12.5
      { day: "2026-11-08", chunk_id: "c2", uses: 10 }, // c2 decayed 2.5
    ];
    const chunkRows = [
      { id: "c1", frontmatter: JSON.stringify({ facts: [{ dedupKey: "alpha:x" }] }) },
      { id: "c2", frontmatter: JSON.stringify({ facts: [{ dedupKey: "beta:y" }] }) },
      {
        id: "c3",
        frontmatter: JSON.stringify({ facts: [{ dedupKey: "alpha:a" }, { dedupKey: "beta:b" }] }),
      },
    ];
    const tables = computeUtilityTables({ useRows, chunkRows, halfLifeDays: 7, beforeDay: "2026-11-22" });
    const byId = new Map(tables.chunkUtility.map((r) => [r.chunk_id, r]));
    expect(byId.get("c1")?.utility).toBeCloseTo(1.0, 10);
    expect(byId.get("c2")?.utility).toBeCloseTo(0.2, 10);
    expect(byId.get("c3")?.utility).toBe(0);
    const byCat = new Map(tables.categoryUtility.map((r) => [r.category, r]));
    expect(byCat.get("alpha")?.utility).toBeCloseTo(0.5, 10); // (1.0 + 0) / 2
    expect(byCat.get("beta")?.utility).toBeCloseTo(0.1, 10); // (0.2 + 0) / 2
    expect(byCat.get("alpha")?.chunk_count).toBe(2);
  });
});

describe("main CLI", () => {
  it("--dryRun writes nothing", async () => {
    seedUseDb(tmpRoot, [{ day: "2026-11-22", chunk_id: "c1", uses: 3 }]);
    seedL3Db(tmpRoot, [{ id: "c1", frontmatter: { facts: [{ dedupKey: "alpha:x" }] } }]);
    await main(["--dir", tmpRoot, "--before", "2026-11-22", "--dryRun"]);
    expect(tableNames(tmpRoot)).not.toContain("chunk_utility");
    expect(tableNames(tmpRoot)).not.toContain("category_utility");
  });

  it("writes idempotently (re-run leaves identical rows)", async () => {
    seedUseDb(tmpRoot, [
      { day: "2026-11-22", chunk_id: "c1", uses: 10 },
      { day: "2026-11-08", chunk_id: "c1", uses: 10 },
      { day: "2026-11-08", chunk_id: "c2", uses: 10 },
    ]);
    seedL3Db(tmpRoot, [
      { id: "c1", frontmatter: { facts: [{ dedupKey: "alpha:x" }] } },
      { id: "c2", frontmatter: { facts: [{ dedupKey: "beta:y" }] } },
    ]);
    await main(["--dir", tmpRoot, "--before", "2026-11-22"]);
    await main(["--dir", tmpRoot, "--before", "2026-11-22"]);
    const db = new DatabaseSync(path.join(tmpRoot, "retrieval-use.sqlite"), { readOnly: true });
    try {
      const chunks = db
        .prepare("SELECT chunk_id, utility FROM chunk_utility ORDER BY chunk_id")
        .all() as Array<{ chunk_id: string; utility: number }>;
      expect(chunks.map((r) => r.chunk_id)).toEqual(["c1", "c2"]);
      expect(chunks[0]?.utility).toBeCloseTo(1.0, 10);
      expect(chunks[1]?.utility).toBeCloseTo(0.2, 10);
      const cats = db
        .prepare("SELECT category, utility FROM category_utility ORDER BY category")
        .all() as Array<{ category: string; utility: number }>;
      expect(cats).toHaveLength(2);
      expect(cats[0]).toMatchObject({ category: "alpha" });
      expect(cats[0]?.utility).toBeCloseTo(1.0, 10);
      expect(cats[1]).toMatchObject({ category: "beta" });
      expect(cats[1]?.utility).toBeCloseTo(0.2, 10);
    } finally {
      db.close();
    }
  });

  it("absent DBs degrade to empty tables and create no state", async () => {
    await main(["--dir", tmpRoot, "--before", "2026-11-22", "--dryRun"]);
    expect(existsSync(path.join(tmpRoot, "retrieval-use.sqlite"))).toBe(false);
  });
});
