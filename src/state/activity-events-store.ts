// Persistence for the cross-agent Control UI activity feed.
//
// The activity feed is steady-state runtime state (a curated projection of
// agent events), not a transcript, so it lives in the shared state DB. The
// gateway recorder writes here; activity.list reads here. detail/metrics are
// opaque JSON owned by the recorder/protocol layer — this module only persists.
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

type ActivityEventsDatabase = Pick<OpenClawStateKyselyDatabase, "activity_events">;

/** Retention bounds. Pruned on write so the feed stays bounded without a sweeper. */
export const ACTIVITY_EVENTS_MAX_ROWS = 5_000;
export const ACTIVITY_EVENTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVITY_EVENTS_DEFAULT_PAGE = 200;
const ACTIVITY_EVENTS_MAX_PAGE = 500;

/** A row to persist. detail/metrics are JSON-serializable payloads or null. */
export type ActivityEventRecord = {
  eventId: string;
  ts: number;
  agentId?: string | null;
  sessionKey?: string | null;
  runId?: string | null;
  groupKey?: string | null;
  kind: string;
  status: string;
  title: string;
  detail?: unknown;
  metrics?: unknown;
};

/** A row read back, with detail/metrics parsed from JSON. */
export type StoredActivityEvent = {
  eventId: string;
  ts: number;
  agentId: string | null;
  sessionKey: string | null;
  runId: string | null;
  groupKey: string | null;
  kind: string;
  status: string;
  title: string;
  detail: unknown;
  metrics: unknown;
};

export type ActivityEventQuery = {
  agentIds?: readonly string[];
  kinds?: readonly string[];
  statuses?: readonly string[];
  /** Only events at or after this ms timestamp. */
  since?: number;
  /** Case-insensitive substring match on title + serialized detail. */
  search?: string;
  limit?: number;
  /** Keyset cursor: return events strictly older than (cursorTs, cursorId). */
  cursorTs?: number;
  cursorId?: string;
};

export type ActivityEventPage = {
  events: StoredActivityEvent[];
  nextCursor: { ts: number; id: string } | null;
};

function serializePayload(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parsePayload(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) {
    return ACTIVITY_EVENTS_DEFAULT_PAGE;
  }
  return Math.min(Math.floor(limit), ACTIVITY_EVENTS_MAX_PAGE);
}

/**
 * Upsert one activity event and prune the table back under its retention
 * bounds. Upsert (not insert) because a step is recorded twice — once when it
 * starts running and again when it completes — keyed by the same event id.
 */
export function recordActivityEvent(record: ActivityEventRecord): void {
  const detailJson = serializePayload(record.detail);
  const metricsJson = serializePayload(record.metrics);
  const createdAt = Date.now();
  const ageCutoff = createdAt - ACTIVITY_EVENTS_MAX_AGE_MS;
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<ActivityEventsDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("activity_events")
        .values({
          event_id: record.eventId,
          ts: record.ts,
          agent_id: record.agentId ?? null,
          session_key: record.sessionKey ?? null,
          run_id: record.runId ?? null,
          group_key: record.groupKey ?? null,
          kind: record.kind,
          status: record.status,
          title: record.title,
          detail_json: detailJson,
          metrics_json: metricsJson,
          created_at: createdAt,
        })
        .onConflict((conflict) =>
          conflict.column("event_id").doUpdateSet({
            ts: record.ts,
            agent_id: record.agentId ?? null,
            session_key: record.sessionKey ?? null,
            run_id: record.runId ?? null,
            group_key: record.groupKey ?? null,
            kind: record.kind,
            status: record.status,
            title: record.title,
            detail_json: detailJson,
            metrics_json: metricsJson,
          }),
        ),
    );
    // Age-based prune is cheap via idx_activity_events_ts.
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("activity_events").where("ts", "<", ageCutoff),
    );
    // Count-based prune: keep only the newest N rows, drop the rest. SQLite
    // rejects OFFSET without LIMIT, so we invert — delete anything not in the
    // newest-N set rather than selecting the overflow with an offset.
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("activity_events")
        .where("event_id", "not in", (sub) =>
          sub
            .selectFrom("activity_events")
            .select("event_id")
            .orderBy("ts", "desc")
            .orderBy("event_id", "desc")
            .limit(ACTIVITY_EVENTS_MAX_ROWS),
        ),
    );
  });
}

function mapRow(row: {
  event_id: string;
  ts: number;
  agent_id: string | null;
  session_key: string | null;
  run_id: string | null;
  group_key: string | null;
  kind: string;
  status: string;
  title: string;
  detail_json: string | null;
  metrics_json: string | null;
}): StoredActivityEvent {
  return {
    eventId: row.event_id,
    ts: row.ts,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    runId: row.run_id,
    groupKey: row.group_key,
    kind: row.kind,
    status: row.status,
    title: row.title,
    detail: parsePayload(row.detail_json),
    metrics: parsePayload(row.metrics_json),
  };
}

/** Read a page of events, newest first, with keyset pagination. */
export function queryActivityEvents(query: ActivityEventQuery = {}): ActivityEventPage {
  const limit = clampLimit(query.limit);
  const database = openOpenClawStateDatabase();
  const db = getNodeSqliteKysely<ActivityEventsDatabase>(database.db);
  let builder = db
    .selectFrom("activity_events")
    .select([
      "event_id",
      "ts",
      "agent_id",
      "session_key",
      "run_id",
      "group_key",
      "kind",
      "status",
      "title",
      "detail_json",
      "metrics_json",
    ])
    .orderBy("ts", "desc")
    .orderBy("event_id", "desc")
    // Fetch one extra row to detect whether another page exists.
    .limit(limit + 1);

  const agentIds = query.agentIds?.filter((id) => id.length > 0);
  if (agentIds && agentIds.length > 0) {
    builder = builder.where("agent_id", "in", agentIds);
  }
  const kinds = query.kinds?.filter((kind) => kind.length > 0);
  if (kinds && kinds.length > 0) {
    builder = builder.where("kind", "in", kinds);
  }
  const statuses = query.statuses?.filter((status) => status.length > 0);
  if (statuses && statuses.length > 0) {
    builder = builder.where("status", "in", statuses);
  }
  if (typeof query.since === "number" && Number.isFinite(query.since)) {
    builder = builder.where("ts", ">=", query.since);
  }
  const search = query.search?.trim().toLowerCase();
  if (search) {
    const like = `%${search.replace(/[%_]/g, (ch) => `\\${ch}`)}%`;
    builder = builder.where((eb) =>
      eb.or([eb("title", "like", like), eb("detail_json", "like", like)]),
    );
  }
  if (typeof query.cursorTs === "number" && query.cursorId) {
    const cursorTs = query.cursorTs;
    const cursorId = query.cursorId;
    builder = builder.where((eb) =>
      eb.or([
        eb("ts", "<", cursorTs),
        eb.and([eb("ts", "=", cursorTs), eb("event_id", "<", cursorId)]),
      ]),
    );
  }

  const result = executeSqliteQuerySync(database.db, builder);
  const rows = result.rows.map(mapRow);
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  const last = events.at(-1);
  return {
    events,
    nextCursor: hasMore && last ? { ts: last.ts, id: last.eventId } : null,
  };
}

/** Test/maintenance helper: drop every persisted activity event. */
export function clearActivityEvents(): void {
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<ActivityEventsDatabase>(database.db);
    executeSqliteQuerySync(database.db, db.deleteFrom("activity_events"));
  });
}
