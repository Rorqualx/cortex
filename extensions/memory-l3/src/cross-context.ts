/**
 * Cross-context memory — shared long-term fact store across agents/sessions.
 *
 * ZenBrain Layer 7: agents, cron-spawned sessions, and sub-agents all share a
 * common long-term fact store. Backed by a dedicated cross-agent SQLite DB at
 * `<sharedDir>/longterm-shared.sqlite` (default `~/.openclaw/shared-memory/`,
 * overridable via `OPENCLAW_SHARED_MEMORY_DIR`). Each agent publishes its
 * promoted long-term facts after consolidation; retrieval includes shared
 * facts as a cross-context tier.
 *
 * Why SQLite, not the old `longterm-shared.json`: this store is the one L3 tier
 * written by multiple processes concurrently (gateway, CLI, crons, sub-agents).
 * The prior atomic write-rename had no cross-process lock, so two agents
 * publishing at once could silently clobber each other's facts. `publishToFacts`
 * now does read-merge-write inside a single `BEGIN IMMEDIATE` transaction over a
 * WAL database, which serializes publishers across processes. The legacy JSON
 * store is imported once by `openclaw doctor --fix` (see `doctor-contract-api.ts`),
 * never read at runtime.
 *
 * Conflict resolution: when multiple agents promote facts with the same
 * dedupKey, the fact with the highest importance wins. Superseded facts are
 * archived (not deleted) for forensics.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  closeMemorySqliteWalMaintenance,
  configureMemorySqliteWalMaintenance,
  ensureDir,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import type { LongTermFact } from "./types.js";

export type SharedLongTermFact = LongTermFact & {
  /** Agent ID that originally promoted this fact. */
  sourceAgentId: string;
};

/**
 * Legacy on-disk wrapper shape for `longterm-shared.json`. Retained only so the
 * doctor migration can parse the shipped file; runtime no longer reads it.
 */
export type SharedStore = {
  version: 1;
  facts: SharedLongTermFact[];
  lastUpdatedAt: number;
};

/** Dedicated cross-agent DB filename under the shared-memory dir. */
export const SHARED_STORE_DB_FILE = "longterm-shared.sqlite";
/** Legacy JSON store filename the doctor migration imports from. */
export const SHARED_STORE_LEGACY_JSON_FILE = "longterm-shared.json";

const SHARED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS l3_shared_longterm (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  fact_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS l3_shared_longterm_dedup ON l3_shared_longterm (dedup_key);
`;

/**
 * Resolve the shared memory directory path.
 * Defaults to `~/.openclaw/shared-memory/`; override via env or param.
 */
export function resolveSharedMemoryDir(override?: string): string {
  if (override && override.length > 0) {
    return override;
  }
  const fromEnv = process.env.OPENCLAW_SHARED_MEMORY_DIR;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  return path.join(os.homedir(), ".openclaw", "shared-memory");
}

/** Absolute path to the shared-store SQLite DB. */
export function resolveSharedStoreDbPath(sharedDir?: string): string {
  return path.join(resolveSharedMemoryDir(sharedDir), SHARED_STORE_DB_FILE);
}

/**
 * Open (creating if needed) the shared-store DB with WAL maintenance. The caller
 * owns the handle and must release it via `closeSharedDb`. Each public entry
 * point opens and closes its own handle so the store stays usable from any
 * process without a long-lived connection.
 */
function openSharedDb(sharedDir?: string): DatabaseSync {
  const dbPath = resolveSharedStoreDbPath(sharedDir);
  ensureDir(path.dirname(dbPath));
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  try {
    // busyTimeoutMs lets a publisher wait out a peer's BEGIN IMMEDIATE instead
    // of failing fast under cross-process contention.
    configureMemorySqliteWalMaintenance(db, { busyTimeoutMs: 5000, databasePath: dbPath });
    db.exec(SHARED_SCHEMA_SQL);
    return db;
  } catch (err) {
    try {
      closeMemorySqliteWalMaintenance(db);
      db.close();
    } catch {
      // Preserve the original open error; cleanup failure is secondary.
    }
    throw err;
  }
}

function closeSharedDb(db: DatabaseSync): void {
  closeMemorySqliteWalMaintenance(db);
  db.close();
}

/** Load every stored fact (active and archived), preserving insertion order. */
function readAllSync(db: DatabaseSync): SharedLongTermFact[] {
  const rows = db.prepare("SELECT payload FROM l3_shared_longterm ORDER BY row_id").all() as Array<{
    payload: string;
  }>;
  const facts: SharedLongTermFact[] = [];
  for (const row of rows) {
    try {
      facts.push(JSON.parse(row.payload) as SharedLongTermFact);
    } catch {
      // A single corrupt row must not take down cross-context recall.
    }
  }
  return facts;
}

/**
 * Replace the entire stored set. Mirrors the previous full-file rewrite, but as
 * a DELETE + INSERT that the caller wraps in an immediate transaction.
 */
function replaceAllSync(db: DatabaseSync, facts: ReadonlyArray<SharedLongTermFact>): void {
  db.exec("DELETE FROM l3_shared_longterm");
  const insert = db.prepare(
    "INSERT INTO l3_shared_longterm (fact_id, source_agent_id, dedup_key, archived, payload) VALUES (?, ?, ?, ?, ?)",
  );
  for (const fact of facts) {
    insert.run(
      fact.id,
      fact.sourceAgentId,
      fact.dedupKey,
      fact.archived ? 1 : 0,
      JSON.stringify(fact),
    );
  }
}

/**
 * Read shared facts from the store. Returns empty array when the store is new.
 */
export async function readSharedFacts(sharedDir?: string): Promise<SharedLongTermFact[]> {
  const db = openSharedDb(sharedDir);
  try {
    return readAllSync(db);
  } finally {
    closeSharedDb(db);
  }
}

/**
 * Replace the shared store with `facts`, transactionally.
 */
export async function writeSharedFacts(
  facts: SharedLongTermFact[],
  sharedDir?: string,
): Promise<void> {
  const db = openSharedDb(sharedDir);
  try {
    runSqliteImmediateTransactionSync(db, () => replaceAllSync(db, facts));
  } finally {
    closeSharedDb(db);
  }
}

/**
 * Merge key for dedup: combines agent ID and dedupKey so each agent's
 * version of a fact is tracked independently before conflict resolution.
 */
function mergeKey(fact: SharedLongTermFact): string {
  return `${fact.sourceAgentId}::${fact.dedupKey}`;
}

/**
 * Publish an agent's promoted long-term facts into the shared store.
 * Dedupes by (agentId + dedupKey), keeping the most recent version, then runs
 * conflict resolution for cross-agent dedupKey collisions.
 *
 * Read-merge-write runs inside one BEGIN IMMEDIATE transaction so concurrent
 * publishers from other processes serialize instead of clobbering each other.
 */
export async function publishToFacts(
  agentId: string,
  facts: ReadonlyArray<LongTermFact>,
  sharedDir?: string,
): Promise<{ published: number; conflicts: number }> {
  // Stamp agent ID on new facts (independent of the transaction).
  const newShared: SharedLongTermFact[] = [];
  for (const fact of facts) {
    if (!fact.archived) {
      newShared.push({ ...fact, sourceAgentId: agentId });
    }
  }

  const db = openSharedDb(sharedDir);
  try {
    return runSqliteImmediateTransactionSync(db, () => {
      const existing = readAllSync(db);
      const activeExisting = existing.filter((f) => !f.archived);

      // Merge: dedupe by (agentId + dedupKey), keep most recent
      const merged = new Map<string, SharedLongTermFact>();
      for (const fact of activeExisting) {
        merged.set(mergeKey(fact), fact);
      }
      for (const fact of newShared) {
        const key = mergeKey(fact);
        const current = merged.get(key);
        if (!current || fact.lastConfirmedAt >= current.lastConfirmedAt) {
          merged.set(key, fact);
        }
      }

      // Also preserve archived facts for forensics
      const archived = existing.filter((f) => f.archived);

      // Conflict resolution: same dedupKey from different agents
      const allActive = Array.from(merged.values());
      const resolved = resolveConflicts(allActive);

      replaceAllSync(db, [...resolved, ...archived]);

      const conflicts = allActive.length - resolved.filter((f) => !f.archived).length;
      return { published: newShared.length, conflicts: Math.max(0, -conflicts) };
    });
  } finally {
    closeSharedDb(db);
  }
}

/**
 * Resolve cross-agent conflicts: when the same dedupKey appears from
 * multiple agents, keep the fact with the highest importance and archive
 * the rest. Facts already archived are left alone.
 */
export function resolveConflicts(facts: ReadonlyArray<SharedLongTermFact>): SharedLongTermFact[] {
  const byDedupKey = new Map<string, SharedLongTermFact[]>();
  for (const fact of facts) {
    if (fact.archived) {
      continue;
    }
    const list = byDedupKey.get(fact.dedupKey) ?? [];
    list.push(fact);
    byDedupKey.set(fact.dedupKey, list);
  }

  const result: SharedLongTermFact[] = [];
  for (const candidates of byDedupKey.values()) {
    if (candidates.length <= 1) {
      result.push(...candidates);
      continue;
    }
    // Sort by importance descending, then by lastConfirmedAt as tiebreaker
    candidates.sort((a, b) => {
      const impDiff = b.importance - a.importance;
      if (Math.abs(impDiff) > 0.001) {
        return impDiff;
      }
      return b.lastConfirmedAt - a.lastConfirmedAt;
    });
    // Winner stays active; rest get archived
    result.push(candidates[0]);
    for (let i = 1; i < candidates.length; i++) {
      result.push({
        ...candidates[i],
        archived: true,
        archivedAt: candidates[i].archivedAt ?? Date.now(),
      });
    }
  }

  return result;
}
