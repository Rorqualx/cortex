// Covers discovery orchestration: endpoint resolution, refreshable enumeration, run+reconcile.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { listDiscoveredModels } from "./discovered-store.js";
import { listRefreshableProviders, runProviderModelDiscovery } from "./discovery-orchestrator.js";

const tempDirs = createTrackedTempDirs();

async function openTempDb() {
  const dir = await tempDirs.make("discovery-orch");
  return openOpenClawStateDatabase({ path: path.join(dir, "openclaw.sqlite") });
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

function cfgWith(providers: Record<string, unknown>): OpenClawConfig {
  return { models: { providers } } as unknown as OpenClawConfig;
}

function modelsResponse(ids: string[]): Response {
  return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("listRefreshableProviders", () => {
  it("returns only providers opted into refreshable discovery, sorted", () => {
    const cfg = cfgWith({
      zai: { baseUrl: "https://api.z.ai/api/paas/v4", discovery: "refreshable" },
      deepseek: { baseUrl: "https://api.deepseek.com", discovery: "refreshable" },
      openai: { baseUrl: "https://api.openai.com/v1", discovery: "static" },
      other: { baseUrl: "https://x" },
    });
    expect(listRefreshableProviders(cfg)).toEqual(["deepseek", "zai"]);
  });
});

describe("runProviderModelDiscovery", () => {
  it("skips when no endpoint/credentials resolve", async () => {
    const { db } = await openTempDb();
    const report = await runProviderModelDiscovery({
      provider: "zai",
      cfg: cfgWith({ zai: { baseUrl: "https://api.z.ai/api/paas/v4" } }),
      nowMs: 1000,
      db,
      resolveEndpoint: () => null,
    });
    expect(report).toEqual({
      provider: "zai",
      ok: false,
      reason: "no configured baseUrl/credentials",
    });
  });

  it("fetches, reconciles, and persists discovered models", async () => {
    const { db } = await openTempDb();
    const fetchFn = vi.fn(async () => modelsResponse(["glm-5", "glm-5.1"]));
    const report = await runProviderModelDiscovery({
      provider: "zai",
      cfg: cfgWith({ zai: { baseUrl: "https://api.z.ai/api/paas/v4" } }),
      nowMs: 1000,
      db,
      fetchFn: fetchFn as unknown as typeof fetch,
      resolveEndpoint: () => ({ baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "k" }),
    });
    expect(report).toMatchObject({ provider: "zai", ok: true, added: ["glm-5", "glm-5.1"] });
    expect(listDiscoveredModels(db, { provider: "zai", status: "active" })).toHaveLength(2);
  });

  it("does not deprecate when the fetch fails", async () => {
    const { db } = await openTempDb();
    await runProviderModelDiscovery({
      provider: "zai",
      cfg: cfgWith({ zai: {} }),
      nowMs: 1000,
      db,
      fetchFn: (async () => modelsResponse(["glm-5"])) as unknown as typeof fetch,
      resolveEndpoint: () => ({ baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "k" }),
    });
    const report = await runProviderModelDiscovery({
      provider: "zai",
      cfg: cfgWith({ zai: {} }),
      nowMs: 2000,
      db,
      fetchFn: (async () => new Response("err", { status: 500 })) as unknown as typeof fetch,
      resolveEndpoint: () => ({ baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "k" }),
    });
    expect(report.ok).toBe(false);
    expect(listDiscoveredModels(db, { provider: "zai", status: "active" })).toHaveLength(1);
  });
});
