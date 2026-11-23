#!/usr/bin/env node
/**
 * Offline retrieval-utility computation (ARCH-2: information-need forecasting,
 * card f19820b6 — probe spike 2026-11-22). PROBE CODE: throwaway feasibility
 * evidence; the implement cron recreates from the report doc, not this file.
 *
 * Reads:
 *   <dir>/retrieval-use.sqlite  · retrieval_use_daily(day, chunk_id, tier, uses)
 *   <dir>/l3.sqlite             · l3_l2_chunks(id, created_at, frontmatter, body)
 * Writes into retrieval-use.sqlite (idempotent INSERT OR REPLACE):
 *   chunk_utility(chunk_id PK, utility REAL, uses_total INT, last_day TEXT, computed_at TEXT)
 *   category_utility(category PK, utility REAL, chunk_count INT, computed_at TEXT)
 *
 * utility = decayed retrieval uses, normalized to corpus max:
 *   decayed(chunk) = Σ_rows 0.5^(Δdays / halfLifeDays)   (tiers collapsed)
 *   utility = decayed / maxDecayed ∈ [0,1]
 * Categories derive from chunk frontmatter fact/typedFact dedupKeys
 * (prefix before first ":", else "uncategorized" — compaction.ts law).
 * Offline operator tool only — never runs inside the engine; consumers
 * degrade to neutral 0 when tables are absent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const USE_DB_FILE = "retrieval-use.sqlite";
const L3_DB_FILE = "l3.sqlite";

const UTILITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chunk_utility (
  chunk_id TEXT PRIMARY KEY,
  utility REAL NOT NULL,
  uses_total INTEGER NOT NULL,
  last_day TEXT,
  computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS category_utility (
  category TEXT PRIMARY KEY,
  utility REAL NOT NULL,
  chunk_count INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);`;

export function categoryOfDedupKey(dedupKey) {
  const idx = dedupKey.indexOf(":");
  return idx > 0 ? dedupKey.slice(0, idx) : "uncategorized";
}

export function daysBetween(laterDay, earlierDay) {
  const [ly, lm, ld] = laterDay.split("-").map(Number);
  const [ey, em, ed] = earlierDay.split("-").map(Number);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ey, em - 1, ed)) / 86_400_000);
}

export function computeDecayedUtility(useRows, { halfLifeDays, beforeDay }) {
  const acc = new Map();
  for (const row of useRows) {
    const entry = acc.get(row.chunk_id) ?? { decayed: 0, usesTotal: 0, lastDay: null };
    const delta = daysBetween(beforeDay, row.day);
    const decay = delta <= 0 ? 1 : 0.5 ** (delta / halfLifeDays);
    entry.decayed += row.uses * decay;
    entry.usesTotal += row.uses;
    if (!entry.lastDay || row.day > entry.lastDay) entry.lastDay = row.day;
    acc.set(row.chunk_id, entry);
  }
  return acc;
}

export function buildChunkCategories(chunkRows) {
  const out = new Map();
  for (const row of chunkRows) {
    const cats = new Set();
    try {
      const fm = JSON.parse(row.frontmatter);
      for (const fact of fm.facts ?? []) {
        if (fact?.dedupKey) cats.add(categoryOfDedupKey(fact.dedupKey));
      }
      for (const typed of fm.typedFacts ?? []) {
        if (typed?.dedupKey) cats.add(categoryOfDedupKey(typed.dedupKey));
      }
    } catch {
      // unparseable frontmatter — chunk contributes no categories
    }
    out.set(row.id, cats);
  }
  return out;
}

export function computeUtilityTables({ useRows, chunkRows, halfLifeDays, beforeDay }) {
  const decayed = computeDecayedUtility(useRows, { halfLifeDays, beforeDay });
  const chunkCats = buildChunkCategories(chunkRows);
  const ids = new Set([...decayed.keys(), ...chunkCats.keys()]);
  let maxDecayed = 0;
  for (const entry of decayed.values()) {
    if (entry.decayed > maxDecayed) maxDecayed = entry.decayed;
  }
  const chunkUtility = [];
  for (const id of ids) {
    const entry = decayed.get(id) ?? { decayed: 0, usesTotal: 0, lastDay: null };
    chunkUtility.push({
      chunk_id: id,
      utility: maxDecayed > 0 ? entry.decayed / maxDecayed : 0,
      uses_total: entry.usesTotal,
      last_day: entry.lastDay,
    });
  }
  chunkUtility.sort((a, b) => (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0));
  const utilityById = new Map(chunkUtility.map((r) => [r.chunk_id, r.utility]));
  const catAcc = new Map();
  for (const [id, cats] of chunkCats) {
    const u = utilityById.get(id) ?? 0;
    for (const cat of cats) {
      const a = catAcc.get(cat) ?? { sum: 0, count: 0 };
      a.sum += u;
      a.count += 1;
      catAcc.set(cat, a);
    }
  }
  const categoryUtility = [...catAcc.entries()]
    .map(([category, a]) => ({
      category,
      utility: a.count > 0 ? a.sum / a.count : 0,
      chunk_count: a.count,
    }))
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return { chunkUtility, categoryUtility, maxDecayed };
}

export function writeUtilityTables(db, tables, computedAt) {
  db.exec(UTILITY_SCHEMA_SQL);
  const insChunk = db.prepare(
    `INSERT OR REPLACE INTO chunk_utility (chunk_id, utility, uses_total, last_day, computed_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const r of tables.chunkUtility) {
    insChunk.run(r.chunk_id, r.utility, r.uses_total, r.last_day, computedAt);
  }
  const insCat = db.prepare(
    `INSERT OR REPLACE INTO category_utility (category, utility, chunk_count, computed_at)
     VALUES (?, ?, ?, ?)`,
  );
  for (const r of tables.categoryUtility) {
    insCat.run(r.category, r.utility, r.chunk_count, computedAt);
  }
}

function parseArgs(argv) {
  const opts = {
    dir: path.join(os.homedir(), ".openclaw", "l3"),
    halfLifeDays: 7,
    before: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--halfLifeDays") opts.halfLifeDays = Number(argv[++i]);
    else if (a === "--before") opts.before = argv[++i];
    else if (a === "--dryRun") opts.dryRun = true;
    else throw new Error(`unknown arg ${a} — usage: --dir <l3 dir> [--halfLifeDays 7] [--before YYYY-MM-DD] [--dryRun]`);
  }
  if (!Number.isFinite(opts.halfLifeDays) || opts.halfLifeDays <= 0) {
    throw new Error("--halfLifeDays must be a positive number");
  }
  return opts;
}

function queryRows(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const beforeDay = opts.before ?? new Date().toISOString().slice(0, 10);
  const useDbPath = path.join(opts.dir, USE_DB_FILE);
  const l3DbPath = path.join(opts.dir, L3_DB_FILE);
  const useRows = fs.existsSync(useDbPath)
    ? queryRows(useDbPath, "SELECT day, chunk_id, SUM(uses) AS uses FROM retrieval_use_daily GROUP BY day, chunk_id")
    : [];
  const chunkRows = fs.existsSync(l3DbPath)
    ? queryRows(l3DbPath, "SELECT id, frontmatter FROM l3_l2_chunks")
    : [];
  const tables = computeUtilityTables({ useRows, chunkRows, halfLifeDays: opts.halfLifeDays, beforeDay });
  console.log(
    `[compute-retrieval-utility] dir=${opts.dir} before=${beforeDay} halfLife=${opts.halfLifeDays}d chunks=${tables.chunkUtility.length} categories=${tables.categoryUtility.length}`,
  );
  for (const r of tables.chunkUtility.slice(0, 20)) {
    console.log(`  chunk ${r.chunk_id}: utility=${r.utility.toFixed(4)} uses=${r.uses_total} last=${r.last_day ?? "-"}`);
  }
  for (const r of tables.categoryUtility) {
    console.log(`  category ${r.category}: utility=${r.utility.toFixed(4)} chunks=${r.chunk_count}`);
  }
  if (opts.dryRun) {
    console.log("[dry-run] no rows written.");
    return;
  }
  if (tables.chunkUtility.length === 0 && tables.categoryUtility.length === 0) {
    console.log("nothing to write (no used chunks, no L2 chunks).");
    return;
  }
  const db = new DatabaseSync(useDbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    writeUtilityTables(db, tables, new Date().toISOString());
  } finally {
    db.close();
  }
  console.log(
    `wrote ${tables.chunkUtility.length} chunk rows + ${tables.categoryUtility.length} category rows -> ${useDbPath}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
