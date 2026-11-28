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
);
CREATE TABLE IF NOT EXISTS retrieval_use_sessions (
  session_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  tier TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, chunk_id, tier)
);
CREATE INDEX IF NOT EXISTS retrieval_use_sessions_chunk ON retrieval_use_sessions (chunk_id);
CREATE TABLE IF NOT EXISTS session_outcomes (
  session_id TEXT PRIMARY KEY,
  outcome TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);`;

/** One injected retrieval item — the unit the engine emits per prompt injection. */
export type RetrievedUseItem = {
  chunkId: string;
  tier: string;
};

/**
 * QW-2 (2026-11-25): run outcome for a session, used by the outcome join.
 * Vocabulary mirrors the MERIT outcome-polarity taxonomy already in the
 * codebase: `positive` = the run/turn succeeded (retrieved-and-helped),
 * `negative` = it failed or was retried/abandoned (retrieved-and-ignored),
 * `neutral` = no outcome signal recorded.
 */
export type SessionOutcome = "positive" | "negative" | "neutral";

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
 * Record one assemble-time injection batch. `sessionId` is now persisted in
 * the per-session table (QW-2, 2026-11-25) for the outcome join, while the
 * daily table keeps its original day-aggregated shape.
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
  const now = params.now ?? Date.now();
  const day = localDay(now);
  const stmt = db.prepare(
    `INSERT INTO retrieval_use_daily (day, chunk_id, tier, uses)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(day, chunk_id, tier) DO UPDATE SET uses = uses + 1`,
  );
  const sessionStmt = db.prepare(
    `INSERT INTO retrieval_use_sessions (session_id, chunk_id, tier, uses, last_used_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(session_id, chunk_id, tier) DO UPDATE SET uses = uses + 1, last_used_at = excluded.last_used_at`,
  );
  for (const item of params.items) {
    stmt.run(day, item.chunkId, item.tier);
    sessionStmt.run(params.sessionId, item.chunkId, item.tier, now);
  }
}

/**
 * QW-2 (2026-11-25): record the run outcome for a session — the write side
 * of the outcome join ("retrieved-and-helped vs retrieved-and-ignored",
 * the Skill Forge outcome join this store's header anticipated). Callers
 * that know whether a turn/run succeeded (replay judges, runtimes, metrics
 * collectors) record the verdict once per session; re-recording overwrites
 * with the latest verdict. Same best-effort discipline as the injection
 * writes: failures are swallowed by callers, never block the hot path.
 */
export function recordSessionOutcome(params: {
  sessionId: string;
  outcome: SessionOutcome;
  now?: number;
  dir: string;
}): void {
  const db = openDb(params.dir);
  const now = params.now ?? Date.now();
  db.prepare(
    `INSERT INTO session_outcomes (session_id, outcome, recorded_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET outcome = excluded.outcome, recorded_at = excluded.recorded_at`,
  ).run(params.sessionId, params.outcome, now);
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

/**
 * QW-2 (2026-11-25): per-chunk utility summary — the outcome join. Joins
 * per-session injection rows with recorded session outcomes so each chunk
 * carries (a) cumulative injection volume, (b) recency (last injection),
 * and (c) injections attributable to positive/negative/neutral-outcome
 * sessions. Chunks injected before the session table existed (or with no
 * recorded outcome) report zero outcome counts — the join degrades to the
 * plain use summary, never blocks consolidation.
 */
export type ChunkUtilitySummary = {
  /** Total recorded prompt injections across all sessions. */
  uses: number;
  /** Most recent injection day (`YYYY-MM-DD`, local), if ever. */
  lastUsedDay: string | null;
  /** Most recent injection timestamp (ms), if ever. */
  lastUsedAtMs: number | null;
  /** Injections that happened in sessions later recorded `positive`. */
  positiveUses: number;
  /** Injections that happened in sessions later recorded `negative`. */
  negativeUses: number;
  /** Injections in sessions recorded `neutral`, or with no outcome record. */
  neutralUses: number;
};

/** Aggregate per-chunk utility (injections + outcome attribution) for the given chunk ids. */
export function summarizeChunkUtility(params: {
  chunkIds: readonly string[];
  dir: string;
}): Map<string, ChunkUtilitySummary> {
  const result = new Map<string, ChunkUtilitySummary>();
  if (params.chunkIds.length === 0) {
    return result;
  }
  const db = openDb(params.dir);
  const placeholders = params.chunkIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT s.chunk_id AS chunk_id,
              SUM(s.uses) AS uses,
              MAX(s.last_used_at) AS last_used_at,
              SUM(CASE WHEN o.outcome = 'positive' THEN s.uses ELSE 0 END) AS positive_uses,
              SUM(CASE WHEN o.outcome = 'negative' THEN s.uses ELSE 0 END) AS negative_uses,
              SUM(CASE WHEN o.outcome = 'neutral' OR o.outcome IS NULL THEN s.uses ELSE 0 END) AS neutral_uses
       FROM retrieval_use_sessions s
       LEFT JOIN session_outcomes o ON o.session_id = s.session_id
       WHERE s.chunk_id IN (${placeholders})
       GROUP BY s.chunk_id`,
    )
    .all(...params.chunkIds) as Array<{
    chunk_id: string;
    uses: number | bigint | null;
    last_used_at: number | bigint | null;
    positive_uses: number | bigint | null;
    negative_uses: number | bigint | null;
    neutral_uses: number | bigint | null;
  }>;
  for (const row of rows) {
    const lastUsedAtMs =
      row.last_used_at === null || row.last_used_at === undefined ? null : Number(row.last_used_at);
    result.set(row.chunk_id, {
      uses: Number(row.uses ?? 0),
      lastUsedDay: lastUsedAtMs === null ? null : localDay(lastUsedAtMs),
      lastUsedAtMs,
      positiveUses: Number(row.positive_uses ?? 0),
      negativeUses: Number(row.negative_uses ?? 0),
      neutralUses: Number(row.neutral_uses ?? 0),
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
