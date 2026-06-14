// Covers the persisted discovered-model store: upsert/active, deprecate, list ordering.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  listDiscoveredModels,
  markDiscoveredModelsDeprecated,
  upsertActiveDiscoveredModels,
} from "./discovered-store.js";

const tempDirs = createTrackedTempDirs();

async function openTempDb() {
  const dir = await tempDirs.make("discovered-store");
  return openOpenClawStateDatabase({ path: path.join(dir, "openclaw.sqlite") });
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("discovered-store", () => {
  it("upserts active rows and lists them in deterministic order", async () => {
    const { db } = await openTempDb();
    upsertActiveDiscoveredModels(
      db,
      "zai",
      [
        {
          modelId: "glm-5.1",
          name: "GLM-5.1",
          createdRemoteMs: 1774620000,
          raw: { id: "glm-5.1" },
        },
        { modelId: "glm-4.7", raw: { id: "glm-4.7" } },
      ],
      1000,
    );
    const rows = listDiscoveredModels(db, { provider: "zai" });
    expect(rows.map((r) => r.modelId)).toEqual(["glm-4.7", "glm-5.1"]);
    expect(rows.every((r) => r.status === "active")).toBe(true);
    expect(rows.find((r) => r.modelId === "glm-5.1")?.ref).toBe("zai/glm-5.1");
    expect(rows.find((r) => r.modelId === "glm-4.7")?.name).toBeNull();
  });

  it("preserves first_seen across upserts and refreshes last_seen", async () => {
    const { db } = await openTempDb();
    upsertActiveDiscoveredModels(db, "zai", [{ modelId: "glm-5", raw: { id: "glm-5" } }], 1000);
    upsertActiveDiscoveredModels(db, "zai", [{ modelId: "glm-5", raw: { id: "glm-5" } }], 2000);
    const rows = listDiscoveredModels(db, { provider: "zai" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastSeenAtMs).toBe(2000);
  });

  it("flips vanished models to deprecated and reactivates returning ones", async () => {
    const { db } = await openTempDb();
    upsertActiveDiscoveredModels(db, "zai", [{ modelId: "glm-old", raw: { id: "glm-old" } }], 1000);
    markDiscoveredModelsDeprecated(db, "zai", ["glm-old"], 1500);
    let row = listDiscoveredModels(db, { provider: "zai" })[0];
    expect(row?.status).toBe("deprecated");
    expect(row?.deprecatedAtMs).toBe(1500);

    upsertActiveDiscoveredModels(db, "zai", [{ modelId: "glm-old", raw: { id: "glm-old" } }], 2000);
    row = listDiscoveredModels(db, { provider: "zai" })[0];
    expect(row?.status).toBe("active");
    expect(row?.deprecatedAtMs).toBeNull();
  });

  it("scopes provider and status filters", async () => {
    const { db } = await openTempDb();
    upsertActiveDiscoveredModels(db, "zai", [{ modelId: "glm-5", raw: {} }], 1000);
    upsertActiveDiscoveredModels(db, "deepseek", [{ modelId: "deepseek-chat", raw: {} }], 1000);
    markDiscoveredModelsDeprecated(db, "zai", ["glm-5"], 1500);
    expect(listDiscoveredModels(db, { provider: "deepseek" })).toHaveLength(1);
    expect(listDiscoveredModels(db, { status: "active" }).map((r) => r.provider)).toEqual([
      "deepseek",
    ]);
    expect(listDiscoveredModels(db, { status: "deprecated" })).toHaveLength(1);
  });
});
