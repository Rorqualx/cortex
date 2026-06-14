// Covers discovery reconcile diff/persistence and nearest-tier replacement scoring.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { listDiscoveredModels, upsertProbedServedModels } from "./discovered-store.js";
import { pickReplacementModel, reconcileProviderModels } from "./reconcile.js";

const tempDirs = createTrackedTempDirs();

async function openTempDb() {
  const dir = await tempDirs.make("reconcile");
  return openOpenClawStateDatabase({ path: path.join(dir, "openclaw.sqlite") });
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

function liveOk(ids: string[]) {
  return { ok: true as const, models: ids.map((id) => ({ modelId: id, raw: { id } })) };
}

describe("reconcileProviderModels", () => {
  it("adds new models and deprecates vanished ones across runs", async () => {
    const { db } = await openTempDb();
    const first = reconcileProviderModels(db, {
      provider: "zai",
      fetchResult: liveOk(["glm-5", "glm-4.7"]),
      nowMs: 1000,
    });
    expect(first).toMatchObject({ ok: true, added: ["glm-5", "glm-4.7"], deprecated: [] });

    const second = reconcileProviderModels(db, {
      provider: "zai",
      fetchResult: liveOk(["glm-5", "glm-5.1"]),
      nowMs: 2000,
    });
    expect(second).toMatchObject({ ok: true, added: ["glm-5.1"], deprecated: ["glm-4.7"] });

    const rows = listDiscoveredModels(db, { provider: "zai" });
    expect(rows.find((r) => r.modelId === "glm-4.7")?.status).toBe("deprecated");
    expect(rows.find((r) => r.modelId === "glm-5.1")?.status).toBe("active");
  });

  it("never deprecates probe-sourced models absent from the /models list", async () => {
    const { db } = await openTempDb();
    // glm-5.1 is listed by /models; glm-5.2 is only ever served (probe-sourced).
    reconcileProviderModels(db, { provider: "zai", fetchResult: liveOk(["glm-5.1"]), nowMs: 1000 });
    upsertProbedServedModels(db, "zai", [{ modelId: "glm-5.2", raw: { id: "glm-5.2" } }], 1000);

    // A later /models reconcile (still only lists glm-5.1) must not deprecate glm-5.2.
    const result = reconcileProviderModels(db, {
      provider: "zai",
      fetchResult: liveOk(["glm-5.1"]),
      nowMs: 2000,
    });
    expect(result).toMatchObject({ deprecated: [] });
    const rows = listDiscoveredModels(db, { provider: "zai" });
    expect(rows.find((r) => r.modelId === "glm-5.2")?.status).toBe("active");
    expect(rows.find((r) => r.modelId === "glm-5.2")?.source).toBe("probe");
  });

  it("skips reconcile (no deprecation) when the fetch failed", async () => {
    const { db } = await openTempDb();
    reconcileProviderModels(db, { provider: "zai", fetchResult: liveOk(["glm-5"]), nowMs: 1000 });
    const result = reconcileProviderModels(db, {
      provider: "zai",
      fetchResult: { ok: false, error: "HTTP 500" },
      nowMs: 2000,
    });
    expect(result).toEqual({ ok: false, reason: "HTTP 500" });
    expect(listDiscoveredModels(db, { provider: "zai" })[0]?.status).toBe("active");
  });
});

describe("pickReplacementModel", () => {
  const candidates = [
    { provider: "zai", id: "glm-4.5", reasoning: true, contextWindow: 128_000, costInput: 0.6 },
    { provider: "zai", id: "glm-5", reasoning: true, contextWindow: 200_000, costInput: 1 },
    { provider: "zai", id: "glm-flash", reasoning: false, contextWindow: 200_000, costInput: 0.07 },
  ];

  it("prefers matching reasoning then closest context then cost", () => {
    const pick = pickReplacementModel({
      deprecated: {
        provider: "zai",
        id: "glm-old",
        reasoning: true,
        contextWindow: 195_000,
        costInput: 0.9,
      },
      candidates,
    });
    expect(pick).toBe("glm-5");
  });

  it("returns null when no same-provider candidate exists", () => {
    expect(
      pickReplacementModel({
        deprecated: { provider: "zai", id: "glm-old" },
        candidates: [{ provider: "deepseek", id: "deepseek-chat" }],
      }),
    ).toBeNull();
  });

  it("uses default model as a tiebreaker", () => {
    const tied = [
      { provider: "zai", id: "glm-a", reasoning: true, contextWindow: 200_000, costInput: 1 },
      { provider: "zai", id: "glm-b", reasoning: true, contextWindow: 200_000, costInput: 1 },
    ];
    const pick = pickReplacementModel({
      deprecated: {
        provider: "zai",
        id: "glm-old",
        reasoning: true,
        contextWindow: 200_000,
        costInput: 1,
      },
      candidates: tied,
      defaultModelId: "glm-b",
    });
    expect(pick).toBe("glm-b");
  });
});
