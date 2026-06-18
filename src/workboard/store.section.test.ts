// Section must round-trip through the canonical store: the board buckets cards
// by it, and before this the high-level store dropped it on create/update.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wb-section-"));
  const stores = createWorkboardSqliteStores({ dbPath: path.join(dir, "workboard.sqlite") });
  const store = new WorkboardStore(stores.cards, {
    boards: stores.boards,
    subscriptions: stores.subscriptions,
    attachments: stores.attachments,
  });
  return { store, close: stores.close };
}

describe("WorkboardStore section", () => {
  it("persists the requested section and defaults to tasks", async () => {
    const { store, close } = openStore();
    try {
      const goal = await store.create({ title: "A goal", section: "goals" });
      expect(goal.section).toBe("goals");
      const defaulted = await store.create({ title: "No section given" });
      expect(defaulted.section).toBe("tasks");
    } finally {
      close();
    }
  });

  it("moves a card between sections on update and rejects unknown sections", async () => {
    const { store, close } = openStore();
    try {
      const card = await store.create({ title: "Movable", section: "ideas" });
      const moved = await store.update(card.id, { section: "implementations" });
      expect(moved.section).toBe("implementations");
      const untouched = await store.update(card.id, { title: "Renamed" });
      expect(untouched.section).toBe("implementations");
      await expect(store.update(card.id, { section: "nonsense" })).rejects.toThrow(
        /section must be/,
      );
    } finally {
      close();
    }
  });
});
