/**
 * Retrieve-then-use telemetry for L3 (2026-10-04 quick-win, MemFold-inspired).
 *
 * Records which retrieved chunks were actually INJECTED into agent prompts —
 * not merely returned by `retrieveTopK`. The ReTopK cache can serve an
 * injection without a fresh retrieval, so the engine records on the
 * post-cache-resolution injection surface (both cache hits and fresh
 * retrievals).
 *
 * Day-bucketed per chunk, mirroring the grounding metrics store's volume
 * discipline: one counter row per (day, chunk, tier), so row count is
 * bounded by distinct injected chunks per day. Session-level attribution is
 * intentionally aggregated away (the payload passes through `sessionId` for
 * future per-session correlation, e.g. the Skill Forge outcome join).
 *
 * The behavioral-use signal feeds promotion scoring at consolidation time
 * (`ConsolidationCandidate.retrievalUseCount` in consolidation.ts). Own
 * SQLite file (`retrieval-use.sqlite`) colocated with the l3 store — same
 * lifecycle as l3.sqlite, droppable wholesale without shared-schema risk.
 * Writes are tiny synchronous upserts; callers swallow failures so
 * telemetry can never break the assemble path.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const DB_FILE = "retrieval-use.sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS retrieval_use_daily (
  day TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, chunk_id, tier)
);`;

/** One injected retrieval item — the unit the engine emits per prompt injection. */
export type RetrievedUseItem = {
  chunkId: string;
  tier: string;
};

export type ChunkUseSummary = {
  /** Total recorded prompt injections across all days. */
  uses: number;
  /** Most recent day (`YYYY-MM-DD`) this chunk was injected, if ever. */
  lastUsedDay: string | null;
};

// Single-slot per-dir handle cache; lifecycle-owned for the process.
const cachedDatabases = new Map<string, DatabaseSync>();

/** Local calendar day (`YYYY-MM-DD`) so day boundaries follow the host clock. */
function localDay(now: number): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function openDb(dir: string): DatabaseSync {
  const cached = cachedDatabases.get(dir);
  if (cached?.isOpen) {
    return cached;
  }
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, DB_FILE);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA_SQL);
  cachedDatabases.set(dir, db);
  return db;
}

/**
 * Record one assemble-time injection batch. `sessionId` is accepted for
 * future per-session correlation (Skill Forge outcome join) but rows
 * aggregate on (day, chunk, tier) to keep volume tiny.
 */
export function recordRetrievalUses(params: {
  sessionId: string;
  items: readonly RetrievedUseItem[];
  now?: number;
  dir: string;
}): void {
  if (params.items.length === 0) {
    return;
  }
  const db = openDb(params.dir);
  const day = localDay(params.now ?? Date.now());
  const stmt = db.prepare(
    `INSERT INTO retrieval_use_daily (day, chunk_id, tier, uses)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(day, chunk_id, tier) DO UPDATE SET uses = uses + 1`,
  );
  for (const item of params.items) {
    stmt.run(day, item.chunkId, item.tier);
  }
}

/** Aggregate cumulative per-chunk use counters for the given chunk ids. */
export function summarizeChunkUse(params: {
  chunkIds: readonly string[];
  dir: string;
}): Map<string, ChunkUseSummary> {
  const result = new Map<string, ChunkUseSummary>();
  if (params.chunkIds.length === 0) {
    return result;
  }
  const db = openDb(params.dir);
  const placeholders = params.chunkIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT chunk_id, SUM(uses) AS uses, MAX(day) AS last_day
       FROM retrieval_use_daily WHERE chunk_id IN (${placeholders})
       GROUP BY chunk_id`,
    )
    .all(...params.chunkIds) as Array<{
    chunk_id: string;
    uses: number | bigint;
    last_day: string | null;
  }>;
  for (const row of rows) {
    result.set(row.chunk_id, {
      uses: typeof row.uses === "bigint" ? Number(row.uses) : row.uses,
      lastUsedDay: row.last_day ?? null,
    });
  }
  return result;
}

/** Close cached handles. Test-only; production keeps the single-slot handle. */
export function closeRetrievalUseStoreForTest(): void {
  for (const db of cachedDatabases.values()) {
    if (db.isOpen) {
      db.close();
    }
  }
  cachedDatabases.clear();
}
