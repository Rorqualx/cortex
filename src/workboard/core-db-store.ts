/**
 * Workboard core-DB backed KeyedStore.
 *
 * Replaces the standalone sqlite-store.ts. Talks to the main gateway.db
 * (or whichever DatabaseSync is provided) instead of its own file.
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  PersistedWorkboardCard,
  PersistedWorkboardNotificationSubscription,
} from "./persistence-types.js";
import type { WorkboardKeyedStore } from "./persistence-types.js";

// ── JSON helpers ────────────────────────────────────────────────────

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

    async update(key: string, value: T): Promise<void> {
      db.prepare(`UPDATE ${table} SET version = version + 1, data = ? WHERE id = ?`).run(
        JSON.stringify(value),
        key,
      );
    },

    async delete(key: string): Promise<void> {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(key);
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

    async count(): Promise<number> {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as {
        cnt: number;
      };
      return row?.cnt ?? 0;
    },

    close(): void {
      // Core DB lifecycle is managed externally — no-op here
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
      ).run(key, value.cardId, JSON.stringify(value), contentBuf);
    },

    async update(key: string, value: PersistedWorkboardAttachment): Promise<void> {
      const contentBuf = value.contentBase64 ? Buffer.from(value.contentBase64, "base64") : null;
      db.prepare(
        `UPDATE workboard_card_attachments SET version = version + 1, data = ?, content = ? WHERE id = ?`,
      ).run(JSON.stringify(value), contentBuf, key);
    },

    async delete(key: string): Promise<void> {
      db.prepare(`DELETE FROM workboard_card_attachments WHERE id = ?`).run(key);
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

    async count(): Promise<number> {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM workboard_card_attachments`).get() as {
        cnt: number;
      };
      return row?.cnt ?? 0;
    },

    close(): void {},
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
