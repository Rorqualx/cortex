// Verifies the one-time legacy workboard DB → shared state DB import.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createWorkboardCoreDbStores } from "./core-db-store.js";
import { migrateLegacyWorkboardDb } from "./legacy-db-migration.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import type { WorkboardSection } from "./types.js";

function persistedCard(id: string, section: WorkboardSection) {
  // Register raw so the card keeps its section column — the high-level store's
  // create() does not set section, but real cards (and the migration) carry it.
  return {
    version: 1 as const,
    card: {
      id,
      title: `${section} card`,
      status: "todo" as const,
      section,
      priority: "normal" as const,
      labels: [],
      position: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

async function seedLegacyCards(stateDir: string) {
  const legacyPath = path.join(stateDir, "plugins", "workboard", "workboard.sqlite");
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const stores = createWorkboardSqliteStores({ dbPath: legacyPath });
  await stores.cards.register("card-goal", persistedCard("card-goal", "goals"));
  await stores.cards.register("card-idea", persistedCard("card-idea", "ideas"));
  stores.close();
  return legacyPath;
}

function readCoreCards(stateDir: string) {
  // Re-open through the same env the migration uses so we read its target DB.
  const stateDb = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return createWorkboardCoreDbStores(stateDb.db).cards.entries();
}

describe("migrateLegacyWorkboardDb", () => {
  it("imports legacy cards into the shared state DB and archives the file", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wb-legacy-"));
    const legacyPath = await seedLegacyCards(stateDir);

    const result = await migrateLegacyWorkboardDb({ stateDir });

    expect(result.warnings).toEqual([]);
    expect(result.changes.some((c) => /Migrated 2 workboard cards/.test(c))).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(`${legacyPath}.migrated`)).toBe(true);

    const cards = await readCoreCards(stateDir);
    expect(cards).toHaveLength(2);
    const sections = cards.map((entry) => entry.value.card.section).toSorted();
    expect(sections).toEqual(["goals", "ideas"]);
  });

  it("is a no-op when no legacy DB exists", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wb-legacy-empty-"));
    const result = await migrateLegacyWorkboardDb({ stateDir });
    expect(result).toEqual({ changes: [], warnings: [] });
  });
});
