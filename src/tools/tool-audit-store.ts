/**
 * Dedicated SQLite store for tool-invocation audit logging.
 *
 * Modeled on the grounding-metrics store: isolated DB, dropable wholesale,
 * write-only from the runtime dispatcher. Each row is one tool call with
 * redacted args summary, agent/session context, and success/error outcome.
 *
 * This is the TokenWall-style audit foundation — structured records with no
 * blocking or semantic inspection. Future work (AR2) can add a semantic
 * firewall layer that reads these records.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sanitizeToolArgs } from "../agents/embedded-agent-subscribe.tools.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqliteDir } from "../state/openclaw-state-db.paths.js";

export type ToolAuditRecord = {
  agentId: string;
  sessionId: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  sourceContext: string;
  allowed: boolean;
  error: boolean;
  errorMessage?: string;
  now?: number;
  dir?: string;
};

export type ToolAuditRow = {
  timestamp: number;
  agent_id: string;
  session_id: string;
  tool_name: string;
  tool_call_id: string;
  args_summary: string;
  source_context: string;
  allowed: number;
  error: number;
  error_message: string | null;
};

export type ToolAuditSummary = {
  fromDay: string;
  totalCalls: number;
  errors: number;
  blocked: number;
  byTool: Array<{
    toolName: string;
    calls: number;
    errors: number;
    blocked: number;
  }>;
  byAgent: Array<{
    agentId: string;
    calls: number;
    errors: number;
  }>;
};

const DB_FILE = "tool-audit.sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tool_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  day TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  args_summary TEXT NOT NULL DEFAULT '',
  source_context TEXT NOT NULL DEFAULT 'embedded-agent',
  allowed INTEGER NOT NULL DEFAULT 1,
  error INTEGER NOT NULL DEFAULT 0,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_audit_day ON tool_audit(day);
CREATE INDEX IF NOT EXISTS idx_tool_audit_agent ON tool_audit(agent_id);
CREATE INDEX IF NOT EXISTS idx_tool_audit_tool ON tool_audit(tool_name);
`;

const MAX_ARGS_SUMMARY_LENGTH = 2048;

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
  cachedDatabases.set(pathname, db);
  return db;
}

/** Local calendar day (`YYYY-MM-DD`) so day boundaries follow the host clock. */
export function localAuditDay(now: number = Date.now()): string {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Build a redacted, length-capped summary of tool args.
 * Uses the existing sanitizeToolArgs (which calls redactStringsDeep → redactToolPayloadText)
 * to strip secrets, API keys, and credentials before storing.
 */
export function buildArgsSummary(args: unknown): string {
  if (args == null) {
    return "";
  }
  try {
    const sanitized = sanitizeToolArgs(args);
    const json = JSON.stringify(sanitized);
    if (json.length <= MAX_ARGS_SUMMARY_LENGTH) {
      return json;
    }
    // Truncate with a marker so consumers know data was cut.
    return json.slice(0, MAX_ARGS_SUMMARY_LENGTH - 3) + "...";
  } catch {
    // If serialization fails (circular refs, etc.), fall back to type string.
    return `[unserializable: ${typeof args}]`;
  }
}

/** Insert an audit row for a single tool invocation. */
export function recordToolAudit(params: ToolAuditRecord): void {
  const db = openDb(params.dir);
  const now = params.now ?? Date.now();
  const day = localAuditDay(now);
  const argsSummary = buildArgsSummary(params.args);
  const errorMessage = params.errorMessage ?? null;

  const stmt = db.prepare(
    `INSERT INTO tool_audit (timestamp, day, agent_id, session_id, tool_name, tool_call_id, args_summary, source_context, allowed, error, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    now,
    day,
    params.agentId,
    params.sessionId,
    params.toolName,
    params.toolCallId,
    argsSummary,
    params.sourceContext,
    params.allowed ? 1 : 0,
    params.error ? 1 : 0,
    errorMessage,
  );
}

type SummaryRow = {
  tool_name: string;
  calls: number | bigint;
  errors: number | bigint;
  blocked: number | bigint;
};

type AgentRow = {
  agent_id: string;
  calls: number | bigint;
  errors: number | bigint;
};

function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

/** Aggregate audit records for all days on/after `fromDay` (lexical = chronological). */
export function summarizeToolAudit(params: { fromDay: string; dir?: string }): ToolAuditSummary {
  const db = openDb(params.dir);

  const toolRows = db
    .prepare(
      `SELECT tool_name,
              COUNT(*) AS calls,
              SUM(error) AS errors,
              SUM(CASE WHEN allowed = 0 THEN 1 ELSE 0 END) AS blocked
       FROM tool_audit WHERE day >= ? GROUP BY tool_name ORDER BY calls DESC`,
    )
    .all(params.fromDay) as SummaryRow[];

  const agentRows = db
    .prepare(
      `SELECT agent_id,
              COUNT(*) AS calls,
              SUM(error) AS errors
       FROM tool_audit WHERE day >= ? GROUP BY agent_id ORDER BY calls DESC`,
    )
    .all(params.fromDay) as AgentRow[];

  const summary: ToolAuditSummary = {
    fromDay: params.fromDay,
    totalCalls: 0,
    errors: 0,
    blocked: 0,
    byTool: [],
    byAgent: [],
  };

  for (const row of toolRows) {
    const calls = toNumber(row.calls);
    const errors = toNumber(row.errors);
    const blocked = toNumber(row.blocked);
    summary.totalCalls += calls;
    summary.errors += errors;
    summary.blocked += blocked;
    summary.byTool.push({ toolName: row.tool_name, calls, errors, blocked });
  }

  for (const row of agentRows) {
    const calls = toNumber(row.calls);
    const errors = toNumber(row.errors);
    summary.byAgent.push({ agentId: row.agent_id, calls, errors });
  }

  return summary;
}

/** Fetch raw audit rows for a specific day (useful for debugging). */
export function queryToolAuditByDay(params: {
  day: string;
  limit?: number;
  dir?: string;
}): ToolAuditRow[] {
  const db = openDb(params.dir);
  const limit = params.limit ?? 1000;
  const rows = db
    .prepare(
      `SELECT timestamp, agent_id, session_id, tool_name, tool_call_id, args_summary, source_context, allowed, error, error_message
       FROM tool_audit WHERE day = ? ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(params.day, limit) as ToolAuditRow[];
  return rows;
}

/** Close cached handles. Test-only; production keeps the single-slot handle. */
export function closeToolAuditStoreForTest(): void {
  for (const db of cachedDatabases.values()) {
    if (db.isOpen) {
      db.close();
    }
  }
  cachedDatabases.clear();
}
