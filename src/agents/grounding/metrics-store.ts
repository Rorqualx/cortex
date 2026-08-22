/**
 * Dedicated SQLite store for grounding-faithfulness metrics.
 *
 * Isolated from the shared state DB on purpose: this is experimental-feature
 * observability with its own lifecycle, so it lives in its own
 * `grounding-metrics.sqlite` and can be dropped wholesale when the feature
 * graduates or is removed (no shared-schema migration). Counters are
 * day-bucketed per agent to keep volume tiny regardless of traffic.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqliteDir } from "../../state/openclaw-state-db.paths.js";

export type GroundingCheckOutcome = "grounded" | "ungrounded" | "skipped";

export type GroundingMetricsSummary = {
  fromDay: string;
  checked: number;
  grounded: number;
  ungrounded: number;
  revised: number;
  skipped: number;
  /** Average pre-confidence across all checks (0–1), undefined when no confidence data. */
  avgPreConfidence?: number;
  /** Average post-confidence across all checks (0–1), undefined when no confidence data. */
  avgPostConfidence?: number;
  byAgent: Array<{
    agentId: string;
    checked: number;
    ungrounded: number;
    revised: number;
  }>;
};

const DB_FILE = "grounding-metrics.sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS grounding_daily (
  day TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  grounded INTEGER NOT NULL DEFAULT 0,
  ungrounded INTEGER NOT NULL DEFAULT 0,
  revised INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  pre_confidence REAL,
  post_confidence REAL,
  PRIMARY KEY (day, agent_id)
);
CREATE TABLE IF NOT EXISTS reacquisition_daily (
  day TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  retrieval_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, agent_id)
);`;

// Single-slot per-path handle cache; lifecycle-owned for the process.
const cachedDatabases = new Map<string, DatabaseSync>();

function resolveDir(dir?: string): string {
  return dir ?? resolveOpenClawStateSqliteDir();
}

function openDb(dir?: string): DatabaseSync {
  const baseDir = resolveDir(dir);
  const pathname = path.join(baseDir, DB_FILE);
  const cached = cachedDatabases.get(pathname);
  if (cached?.isOpen) {
    return cached;
  }
  mkdirSync(baseDir, { recursive: true });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  db.exec(SCHEMA_SQL);
  // Migration: add pre/post confidence columns if they don't exist (pre-2026-06-25 dbs).
  try {
    db.prepare("SELECT pre_confidence FROM grounding_daily LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE grounding_daily ADD COLUMN pre_confidence REAL;");
    db.exec("ALTER TABLE grounding_daily ADD COLUMN post_confidence REAL;");
  }
  cachedDatabases.set(pathname, db);
  return db;
}

/** Local calendar day (`YYYY-MM-DD`) so day boundaries follow the host clock. */
export function localDay(now: number = Date.now()): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Increment day-bucketed counters for one grounding check. */
export function recordGroundingCheck(params: {
  agentId: string;
  outcome: GroundingCheckOutcome;
  revised: boolean;
  /** Optional pre-reasoning confidence (0–1). */
  preConfidence?: number;
  /** Optional post-reasoning confidence (0–1). */
  postConfidence?: number;
  now?: number;
  dir?: string;
}): void {
  const db = openDb(params.dir);
  const day = localDay(params.now ?? Date.now());
  const grounded = params.outcome === "grounded" ? 1 : 0;
  const ungrounded = params.outcome === "ungrounded" ? 1 : 0;
  const skipped = params.outcome === "skipped" ? 1 : 0;
  const revised = params.revised ? 1 : 0;
  const preConfidence = params.preConfidence ?? null;
  const postConfidence = params.postConfidence ?? null;
  // Counter upsert isn't cleanly expressible in Kysely; a fully-parameterized
  // prepared statement is the narrow SQLite primitive justified here.
  const stmt = db.prepare(
    `INSERT INTO grounding_daily (day, agent_id, checked, grounded, ungrounded, revised, skipped, pre_confidence, post_confidence)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, agent_id) DO UPDATE SET
       checked = checked + 1,
       grounded = grounded + ?,
       ungrounded = ungrounded + ?,
       revised = revised + ?,
       skipped = skipped + ?,
       pre_confidence = pre_confidence + COALESCE(excluded.pre_confidence, 0),
       post_confidence = post_confidence + COALESCE(excluded.post_confidence, 0)`,
  );
  stmt.run(
    day,
    params.agentId,
    grounded,
    ungrounded,
    revised,
    skipped,
    preConfidence,
    postConfidence,
    grounded,
    ungrounded,
    revised,
    skipped,
  );
}

type SummaryRow = {
  agent_id: string;
  checked: number | bigint;
  grounded: number | bigint;
  ungrounded: number | bigint;
  revised: number | bigint;
  skipped: number | bigint;
  pre_confidence_sum: number | bigint | null;
  post_confidence_sum: number | bigint | null;
};

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/** Aggregate counters for all days on/after `fromDay` (lexical = chronological). */
export function summarizeGroundingMetrics(params: {
  fromDay: string;
  dir?: string;
}): GroundingMetricsSummary {
  const db = openDb(params.dir);
  const rows = db
    .prepare(
      `SELECT agent_id,
              SUM(checked) AS checked,
              SUM(grounded) AS grounded,
              SUM(ungrounded) AS ungrounded,
              SUM(revised) AS revised,
              SUM(skipped) AS skipped,
              SUM(pre_confidence) AS pre_confidence_sum,
              SUM(post_confidence) AS post_confidence_sum
       FROM grounding_daily WHERE day >= ? GROUP BY agent_id ORDER BY agent_id`,
    )
    .all(params.fromDay) as SummaryRow[];

  const summary: GroundingMetricsSummary = {
    fromDay: params.fromDay,
    checked: 0,
    grounded: 0,
    ungrounded: 0,
    revised: 0,
    skipped: 0,
    byAgent: [],
  };
  let preConfidenceSum = 0;
  let postConfidenceSum = 0;
  for (const row of rows) {
    const checked = toNumber(row.checked);
    const grounded = toNumber(row.grounded);
    const ungrounded = toNumber(row.ungrounded);
    const revised = toNumber(row.revised);
    const skipped = toNumber(row.skipped);
    summary.checked += checked;
    summary.grounded += grounded;
    summary.ungrounded += ungrounded;
    summary.revised += revised;
    summary.skipped += skipped;
    summary.byAgent.push({ agentId: row.agent_id, checked, ungrounded, revised });
    preConfidenceSum += toNumber(row.pre_confidence_sum ?? 0);
    postConfidenceSum += toNumber(row.post_confidence_sum ?? 0);
  }
  if (summary.checked > 0) {
    summary.avgPreConfidence = preConfidenceSum / summary.checked;
    summary.avgPostConfidence = postConfidenceSum / summary.checked;
  }
  return summary;
}

/** Close cached handles. Test-only; production keeps the single-slot handle. */
export function closeGroundingMetricsStoreForTest(): void {
  for (const db of cachedDatabases.values()) {
    if (db.isOpen) {
      db.close();
    }
  }
  cachedDatabases.clear();
}

// ---------------------------------------------------------------------------
// Compression reacquisition telemetry (arXiv:2608.16370-inspired)
// ---------------------------------------------------------------------------

/**
 * Retrieval-type tools whose post-compression usage signals REACQUISITION:
 * the agent re-fetching context the 5-phase compression pipeline dropped.
 * Task-completion metrics hide this cost; these counters expose it.
 */
export const RETRIEVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "memory_search",
  "memory_get",
  "memory_insights",
  "read",
]);

export type ReacquisitionMetricsSummary = {
  fromDay: string;
  totalRetrievalCalls: number;
  /** Days flagged as reacquisition surges (post-compression re-fetch spikes). */
  surges: number;
  byDay: Array<{
    day: string;
    agentId: string;
    retrievalCalls: number;
    /** True when this day's calls exceed surgeFactor × trailing prior-day mean. */
    surge: boolean;
  }>;
};

/**
 * Count one tool invocation toward reacquisition telemetry. No-op for
 * non-retrieval tools, so a dispatcher can call it unconditionally next to
 * its audit hook without filtering at the call site.
 */
export function recordRetrievalToolCall(params: {
  agentId: string;
  toolName: string;
  now?: number;
  dir?: string;
}): void {
  if (!RETRIEVAL_TOOL_NAMES.has(params.toolName)) {
    return;
  }
  const db = openDb(params.dir);
  const day = localDay(params.now ?? Date.now());
  const stmt = db.prepare(
    `INSERT INTO reacquisition_daily (day, agent_id, retrieval_calls)
     VALUES (?, ?, 1)
     ON CONFLICT(day, agent_id) DO UPDATE SET retrieval_calls = retrieval_calls + 1`,
  );
  stmt.run(day, params.agentId);
}

/**
 * Aggregate reacquisition counters and flag post-compression surges: a day
 * whose retrieval-call count exceeds `surgeFactor` × the trailing mean of
 * that agent's prior days (up to `trailingDays`), once the baseline has at
 * least `minBaseline` calls. Baseline gating avoids flagging noise on tiny
 * early volumes. Read-only; safe to call from dashboards or crons.
 */
export function summarizeReacquisitionMetrics(params: {
  fromDay: string;
  dir?: string;
  /** Surge multiplier over the trailing mean. Default 1.5. */
  surgeFactor?: number;
  /** Trailing days used for the baseline mean. Default 3. */
  trailingDays?: number;
  /** Minimum trailing-mean calls before a surge can be flagged. Default 5. */
  minBaseline?: number;
}): ReacquisitionMetricsSummary {
  const db = openDb(params.dir);
  const surgeFactor = params.surgeFactor ?? 1.5;
  const trailingDays = params.trailingDays ?? 3;
  const minBaseline = params.minBaseline ?? 5;
  const rows = db
    .prepare(
      `SELECT day, agent_id, retrieval_calls FROM reacquisition_daily
       WHERE day >= ? ORDER BY day, agent_id`,
    )
    .all(params.fromDay) as Array<{
    day: string;
    agent_id: string;
    retrieval_calls: number | bigint;
  }>;

  // Per-agent trailing window of counts (chronological within agent).
  const history = new Map<string, number[]>();
  const summary: ReacquisitionMetricsSummary = {
    fromDay: params.fromDay,
    totalRetrievalCalls: 0,
    surges: 0,
    byDay: [],
  };
  for (const row of rows) {
    const calls = toNumber(row.retrieval_calls);
    const prior = history.get(row.agent_id) ?? [];
    const window = prior.slice(-trailingDays);
    const trailingMean = window.length > 0 ? window.reduce((a, b) => a + b, 0) / window.length : 0;
    const surge = trailingMean >= minBaseline && calls > trailingMean * surgeFactor;
    summary.totalRetrievalCalls += calls;
    if (surge) {
      summary.surges += 1;
    }
    summary.byDay.push({
      day: row.day,
      agentId: row.agent_id,
      retrievalCalls: calls,
      surge,
    });
    prior.push(calls);
    history.set(row.agent_id, prior);
  }
  return summary;
}
