/**
 * Workboard core-DB backed KeyedStore.
 *
 * Replaces the standalone sqlite-store.ts. Talks to the main gateway.db
 * (or whichever DatabaseSync is provided) instead of its own file.
 */
import type { DatabaseSync } from "node:sqlite";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
} from "./persistence-types.js";
import type { WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

// ── JSON helpers ────────────────────────────────────────────────────

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- caller-specified JSON deserialization target type.
function parse<T>(raw: unknown): T | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

// ── Generic SQLite-backed KeyedStore ────────────────────────────────

function createSqliteKeyedStore<T extends { version?: number }>(
  db: DatabaseSync,
  table: string,
): WorkboardKeyedStore<T> {
  return {
    async lookup(key: string): Promise<T | undefined> {
      const row = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(key) as
        | { data: string }
        | undefined;
      return row ? parse<T>(row.data) : undefined;
    },

    async register(key: string, value: T): Promise<void> {
      db.prepare(`INSERT OR REPLACE INTO ${table} (id, version, data) VALUES (?, 1, ?)`).run(
        key,
        JSON.stringify(value),
      );
    },

    async delete(key: string): Promise<boolean> {
      return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(key).changes > 0;
    },

    async entries(): Promise<Array<{ key: string; value: T }>> {
      const rows = db.prepare(`SELECT id, data FROM ${table}`).all() as Array<{
        id: string;
        data: string;
      }>;
      return rows
        .map((r) => ({ key: r.id, value: parse<T>(r.data) }))
        .filter((e): e is { key: string; value: T } => e.value != null);
    },
  };
}

// ── Attachment store (has extra columns) ────────────────────────────

function createAttachmentStore(
  db: DatabaseSync,
): WorkboardKeyedStore<PersistedWorkboardAttachment> {
  return {
    async lookup(key: string): Promise<PersistedWorkboardAttachment | undefined> {
      const row = db
        .prepare(`SELECT data, content FROM workboard_card_attachments WHERE id = ?`)
        .get(key) as { data: string; content: Buffer | null } | undefined;
      if (!row) {
        return undefined;
      }
      const parsed = parse<PersistedWorkboardAttachment>(row.data);
      if (!parsed) {
        return undefined;
      }
      // Merge BLOB content into the parsed object
      if (row.content) {
        parsed.contentBase64 = row.content.toString("base64");
      }
      return parsed;
    },

    async register(key: string, value: PersistedWorkboardAttachment): Promise<void> {
      const contentBuf = value.contentBase64 ? Buffer.from(value.contentBase64, "base64") : null;
      db.prepare(
        `INSERT OR REPLACE INTO workboard_card_attachments (id, card_id, version, data, content) VALUES (?, ?, 1, ?, ?)`,
      ).run(key, value.attachment.cardId, JSON.stringify(value), contentBuf);
    },

    async delete(key: string): Promise<boolean> {
      return db.prepare(`DELETE FROM workboard_card_attachments WHERE id = ?`).run(key).changes > 0;
    },

    async entries(): Promise<Array<{ key: string; value: PersistedWorkboardAttachment }>> {
      const rows = db.prepare(`SELECT id, data FROM workboard_card_attachments`).all() as Array<{
        id: string;
        data: string;
      }>;
      return rows
        .map((r) => ({ key: r.id, value: parse<PersistedWorkboardAttachment>(r.data) }))
        .filter((e): e is { key: string; value: PersistedWorkboardAttachment } => e.value != null);
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────

export type CoreDbWorkboardStores = {
  cards: WorkboardKeyedStore;
  boards: WorkboardKeyedStore<PersistedWorkboardBoard>;
  subscriptions: WorkboardKeyedStore<PersistedWorkboardNotificationSubscription>;
  attachments: WorkboardKeyedStore<PersistedWorkboardAttachment>;
};

export function createWorkboardCoreDbStores(db: DatabaseSync): CoreDbWorkboardStores {
  return {
    cards: createSqliteKeyedStore<PersistedWorkboardCard>(db, "workboard_cards"),
    boards: createSqliteKeyedStore<PersistedWorkboardBoard>(db, "workboard_boards"),
    subscriptions: createSqliteKeyedStore<PersistedWorkboardNotificationSubscription>(
      db,
      "workboard_notification_subscriptions",
    ),
    attachments: createAttachmentStore(db),
  };
}

/**
 * Canonical workboard store, backed by the shared state DB. Both the gateway
 * (server-aux-handlers) and the CLI open the board here so cards written by one
 * are visible to the other — the legacy dedicated sqlite-store split them.
 */
export function openWorkboardCoreStore(env?: NodeJS.ProcessEnv): WorkboardStore {
  const stateDb = openOpenClawStateDatabase(env ? { env } : {});
  const stores = createWorkboardCoreDbStores(stateDb.db);
  return new WorkboardStore(stores.cards, {
    boards: stores.boards,
    subscriptions: stores.subscriptions,
    attachments: stores.attachments,
    // data_version bumps on commits from other connections (CLI vs gateway),
    // letting the change-event service surface external board writes.
    dataVersion: () => {
      const row = stateDb.db.prepare("PRAGMA data_version").get() as
        | { data_version?: number | bigint }
        | undefined;
      return Number(row?.data_version ?? 0);
    },
  });
}
