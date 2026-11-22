/**
 * On-policy promotion-decision log for L3 (2026-11-22 quick-win,
 * OPD-precursor, arXiv:2611.14009).
 *
 * Every consolidation cycle emits one append-only row per candidate carrying
 * the features the threshold gate saw plus the promote/blocked verdict and a
 * machine-readable reason. This starts the training-data clock for a future
 * distilled promotion classifier with ZERO behavior change today — the store
 * is write-only telemetry; nothing reads it on any live path.
 *
 * Own SQLite file (`promotion-decisions.sqlite`) colocated with the l3 store,
 * mirroring `retrieval-use-store.ts` (same lifecycle discipline: droppable
 * wholesale, no shared-schema risk). Writes are tiny synchronous inserts;
 * callers swallow failures so logging can never break consolidation.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const DB_FILE = "promotion-decisions.sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS promotion_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  decided_at_ms INTEGER NOT NULL,
  day TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  recall_count INTEGER NOT NULL,
  importance REAL NOT NULL,
  dayspan_ms INTEGER NOT NULL,
  certainty TEXT NOT NULL,
  modality TEXT NOT NULL,
  retrieval_use_count INTEGER NOT NULL DEFAULT 0,
  source_chunk_count INTEGER NOT NULL
);`;

/** Verdict + features snapshot for one candidate at threshold time. */
export type PromotionDecisionRecord = {
  dedupKey: string;
  verdict: "promote" | "blocked";
  reason:
    | "high_importance_passthrough"
    | "promoted_thresholds"
    | "below_min_recall_count"
    | "below_min_dayspan"
    | "below_min_importance";
  recallCount: number;
  importance: number;
  dayspanMs: number;
  certainty: string;
  modality: string;
  retrievalUseCount: number;
  sourceChunkCount: number;
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
 * Append one batch of promotion decisions. Failures degrade to a no-op —
 * telemetry must never block consolidation.
 */
export function logPromotionDecisions(params: {
  decisions: readonly PromotionDecisionRecord[];
  dir: string;
  now?: number;
}): void {
  if (params.decisions.length === 0) {
    return;
  }
  const db = openDb(params.dir);
  const now = params.now ?? Date.now();
  const day = localDay(now);
  const stmt = db.prepare(
    `INSERT INTO promotion_decisions (
       decided_at_ms, day, dedup_key, verdict, reason,
       recall_count, importance, dayspan_ms, certainty, modality,
       retrieval_use_count, source_chunk_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of params.decisions) {
    stmt.run(
      now,
      day,
      d.dedupKey,
      d.verdict,
      d.reason,
      d.recallCount,
      d.importance,
      d.dayspanMs,
      d.certainty,
      d.modality,
      d.retrievalUseCount,
      d.sourceChunkCount,
    );
  }
}

/** Close cached handles. Test-only; production keeps the single-slot handle. */
export function closePromotionDecisionLogForTest(): void {
  for (const db of cachedDatabases.values()) {
    if (db.isOpen) {
      db.close();
    }
  }
  cachedDatabases.clear();
}
