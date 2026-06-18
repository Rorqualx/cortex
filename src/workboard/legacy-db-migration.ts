/**
 * One-time import of the legacy dedicated workboard SQLite file into the shared
 * state DB.
 *
 * The workboard became core-native (cards live in state/openclaw.sqlite, served
 * by the gateway), but the CLI kept writing the standalone
 * plugins/workboard/workboard.sqlite. Cards stranded there never reached the
 * gateway/UI. This migration folds that file into the canonical store, then
 * archives it so steady-state runtime only ever reads the shared DB.
 */
import fs from "node:fs";
import path from "node:path";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { WorkboardKeyedStore } from "./persistence-types.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";

// Mirror of sqlite-store's WORKBOARD_DB_RELATIVE_PATH; the legacy file always
// lived here relative to the state dir.
const LEGACY_DB_RELATIVE_PATH = ["plugins", "workboard", "workboard.sqlite"] as const;

async function importMissingEntries<T extends { version?: number }>(
  source: WorkboardKeyedStore<T>,
  target: WorkboardKeyedStore<T>,
): Promise<number> {
  const existing = new Set((await target.entries()).map((entry) => entry.key));
  let imported = 0;
  for (const { key, value } of await source.entries()) {
    if (existing.has(key)) {
      continue;
    }
    await target.register(key, value);
    imported += 1;
  }
  return imported;
}

function archive(filePath: string, changes: string[], warnings: string[]) {
  // Move the file and its WAL sidecars aside so the store is gone from runtime
  // but recoverable if the import was wrong.
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    try {
      fs.renameSync(candidate, `${candidate}.migrated`);
    } catch (err) {
      warnings.push(`Failed archiving legacy workboard file ${candidate}: ${String(err)}`);
    }
  }
  changes.push(`Archived legacy workboard DB → ${filePath}.migrated`);
}

export async function migrateLegacyWorkboardDb(params: {
  stateDir: string;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const legacyPath = path.join(params.stateDir, ...LEGACY_DB_RELATIVE_PATH);
  if (!fs.existsSync(legacyPath)) {
    return { changes: [], warnings: [] };
  }

  const changes: string[] = [];
  const warnings: string[] = [];
  const legacy = createWorkboardSqliteStores({ dbPath: legacyPath });
  try {
    const stateDb = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    });
    // Dynamic import keeps core-db-store off any static import graph (it is
    // dynamic-only at every other call site).
    const { createWorkboardCoreDbStores } = await import("./core-db-store.js");
    const core = createWorkboardCoreDbStores(stateDb.db);
    const cards = await importMissingEntries(legacy.cards, core.cards);
    // Existing-wins: if the shared DB already has a board with the same id, its
    // config is kept (we never clobber current state). A legacy board's settings
    // — e.g. an orchestration opt-in — are dropped in that collision; re-set them
    // via workboard.boards.create if needed.
    const boards = await importMissingEntries(legacy.boards, core.boards);
    const subscriptions = await importMissingEntries(legacy.subscriptions, core.subscriptions);
    const attachments = await importMissingEntries(legacy.attachments, core.attachments);
    if (cards > 0) {
      changes.push(
        `Migrated ${cards} workboard ${cards === 1 ? "card" : "cards"} → shared SQLite state`,
      );
    }
    if (boards > 0) {
      changes.push(
        `Migrated ${boards} workboard ${boards === 1 ? "board" : "boards"} → shared SQLite state`,
      );
    }
    if (subscriptions > 0) {
      changes.push(
        `Migrated ${subscriptions} workboard notification subscriptions → shared SQLite state`,
      );
    }
    if (attachments > 0) {
      changes.push(`Migrated ${attachments} workboard attachments → shared SQLite state`);
    }
  } catch (err) {
    return {
      changes,
      warnings: [`Failed migrating legacy workboard DB ${legacyPath}: ${String(err)}`],
    };
  } finally {
    legacy.close();
  }

  archive(legacyPath, changes, warnings);
  return { changes, warnings };
}
