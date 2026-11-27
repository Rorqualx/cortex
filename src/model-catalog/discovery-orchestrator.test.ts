// Covers discovery orchestration: endpoint resolution, refreshable enumeration, run+reconcile.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { listDiscoveredModels, listSilentUpgrades } from "./discovered-store.js";
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

  it("requests /v1/models for ollama, whose native protocol has no /models", async () => {
    // api: "ollama" speaks the native protocol for completions, so the configured
    // baseUrl is the bare host and the OpenAI-compatible catalog sits under /v1.
    // Sending the default <host>/models returned 404 and a local install with four
    // models pulled reported only the one declared in config.
    const { db } = await openTempDb();
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return modelsResponse(["qwen3.6:27b", "qwen3.5:4b"]);
    });
    const report = await runProviderModelDiscovery({
      provider: "ollama",
      cfg: cfgWith({ ollama: { baseUrl: "http://localhost:11434", api: "ollama" } }),
      nowMs: 1000,
      db,
      fetchFn: fetchFn as unknown as typeof fetch,
      // Local Ollama needs no real credential; the runtime supplies a local marker.
      resolveEndpoint: () => ({
        baseUrl: "http://localhost:11434",
        api: "ollama",
        apiKey: "ollama-local",
      }),
    });
    expect(seen[0]).toBe("http://localhost:11434/v1/models");
    expect(report).toMatchObject({ provider: "ollama", ok: true });
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

  it("records alias→snapshot upgrade links even when /models lists the snapshot id", async () => {
    // Silent point-update scenario (QW2 2026-08-21): the stable alias
    // deepseek-v4-flash is answered with the snapshot id
    // DeepSeek-V4-Flash-0731, and /models happens to also list the snapshot id.
    // The upgrade link must still be recorded so doctor --fix sees a
    // distinguishable served id instead of collapsing both onto the alias.
    const { db } = await openTempDb();
    const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if (u.endsWith("/chat/completions")) {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
        // QW7 watchlist: the provider has not shipped the landscape id yet —
        // the probe fails and is skipped gracefully (never throws).
        if (body.model === "DeepSeek-V4.1-Flash-1017") {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ model: "DeepSeek-V4-Flash-0731" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return modelsResponse(["deepseek-v4-flash", "DeepSeek-V4-Flash-0731"]);
    });
    const report = await runProviderModelDiscovery({
      provider: "deepseek",
      cfg: cfgWith({
        deepseek: {
          baseUrl: "https://api.deepseek.com",
          models: [{ id: "deepseek-v4-flash" }],
        },
      }),
      nowMs: 1000,
      db,
      probeServed: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      resolveEndpoint: () => ({ baseUrl: "https://api.deepseek.com", apiKey: "***" }),
    });
    // Both /models ids reconciled; the snapshot id was not "new" (it was listed).
    expect(report).toMatchObject({ provider: "deepseek", ok: true });
    expect(report.ok ? report.added : []).toEqual(["deepseek-v4-flash", "DeepSeek-V4-Flash-0731"]);
    expect(report.probedAdded).toBeUndefined();
    // But the alias→snapshot link is recorded on the served row.
    expect(listSilentUpgrades(db, "deepseek")).toEqual([
      { provider: "deepseek", from: "deepseek-v4-flash", to: "DeepSeek-V4-Flash-0731" },
    ]);
    // The snapshot row keeps its /models source (probe never downgrades it).
    const rows = listDiscoveredModels(db, { provider: "deepseek" });
    const snapshotRow = rows.find((r) => r.modelId === "DeepSeek-V4-Flash-0731");
    expect(snapshotRow?.source).toBe("models");
  });

  it("silent alias bumps produce no deprecations (no reassignment trigger)", async () => {
    // Verification (2026-08-24, analysis QW-1): a silent point-update — alias
    // deepseek-v4-flash answered with DeepSeek-V4-Flash-0731 while /models still
    // lists the alias — must NOT deprecate anything. Deprecation is what arms
    // doctor's model-pin reassignment; a silent bump alone must stay inert so
    // pins keep riding the stable alias until the provider truly drops it.
    const { db } = await openTempDb();
    const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if (u.endsWith("/chat/completions")) {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
        // QW7 watchlist: landscape id not shipped yet — probe fails, skipped.
        if (body.model === "DeepSeek-V4.1-Flash-1017") {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ model: "DeepSeek-V4-Flash-0731" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // /models lists the alias (and the base pro line), never the snapshot id.
      return modelsResponse(["deepseek-v4-flash", "deepseek-v4-pro"]);
    });
    const run = () =>
      runProviderModelDiscovery({
        provider: "deepseek",
        cfg: cfgWith({
          deepseek: {
            baseUrl: "https://api.deepseek.com",
            models: [{ id: "deepseek-v4-flash" }],
          },
        }),
        nowMs: 1000,
        db,
        probeServed: true,
        fetchFn: fetchFn as unknown as typeof fetch,
        resolveEndpoint: () => ({ baseUrl: "https://api.deepseek.com", apiKey: "***" }),
      });
    const first = await run();
    expect(first).toMatchObject({ ok: true, deprecated: [] });
    // The unlisted snapshot id lands as a probe-sourced active row, not a
    // deprecation.
    expect(first.probedAdded).toEqual(["DeepSeek-V4-Flash-0731"]);
    // Steady state: a repeat run with the same shape still deprecates nothing.
    const second = await run();
    expect(second).toMatchObject({ ok: true, deprecated: [] });
    expect(listDiscoveredModels(db, { provider: "deepseek", status: "deprecated" })).toEqual([]);
    expect(listSilentUpgrades(db, "deepseek")).toEqual([
      { provider: "deepseek", from: "deepseek-v4-flash", to: "DeepSeek-V4-Flash-0731" },
    ]);
  });

  it("picks up a served-but-unlisted config-declared model via the probe", async () => {
    // Verification (2026-08-24, analysis QW-1): deepseek-v4-flash-vision-exp is
    // served but absent from /models. It is declared in config, so the probe
    // candidate list (config ids preferred over /models ids) requests it; the
    // provider echoes the id back. The observation must surface as probedAdded
    // with a probe-sourced active row that later /models refreshes never
    // vanish-deprecate (reconcile only deprecates source=="models" rows).
    const { db } = await openTempDb();
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if (u.endsWith("/chat/completions")) {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
        // Empty-thinking audit probes (QW1 2026-10-14) are answered separately
        // and do not count as served-id probes in the `requested` ledger.
        if (body.reasoning_effort === "none") {
          return new Response(
            JSON.stringify({
              model: body.model,
              usage: { completion_tokens_details: { reasoning_tokens: 0 } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        requested.push(String(body.model));
        return new Response(JSON.stringify({ model: body.model }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return modelsResponse(["deepseek-v4-flash", "deepseek-v4-pro"]);
    });
    const run = () =>
      runProviderModelDiscovery({
        provider: "deepseek",
        cfg: cfgWith({
          deepseek: {
            baseUrl: "https://api.deepseek.com",
            models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-flash-vision-exp" }],
          },
        }),
        nowMs: 1000,
        db,
        probeServed: true,
        fetchFn: fetchFn as unknown as typeof fetch,
        resolveEndpoint: () => ({ baseUrl: "https://api.deepseek.com", apiKey: "***" }),
      });
    const first = await run();
    // Config ids first, then the provider's landscape watchlist entry
    // (QW7 2026-11-27: DeepSeek-V4.1-Flash-1017) — config list still wins over
    // the /models list (neither deepseek-v4-pro nor other live ids probed).
    expect(requested).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "DeepSeek-V4.1-Flash-1017",
    ]);
    expect(first.probedAdded).toEqual(["deepseek-v4-flash-vision-exp", "DeepSeek-V4.1-Flash-1017"]);
    const visionRow = listDiscoveredModels(db, { provider: "deepseek" }).find(
      (r) => r.modelId === "deepseek-v4-flash-vision-exp",
    );
    expect(visionRow?.source).toBe("probe");
    expect(visionRow?.status).toBe("active");
    // A later refresh (models list unchanged) keeps the probe row active.
    await run();
    const after = listDiscoveredModels(db, { provider: "deepseek" }).find(
      (r) => r.modelId === "deepseek-v4-flash-vision-exp",
    );
    expect(after?.status).toBe("active");
    expect(listDiscoveredModels(db, { provider: "deepseek", status: "deprecated" })).toEqual([]);
  });

  it("probes landscape watchlist ids even when the provider has no config models (QW7 2026-11-27)", async () => {
    // Nov-2026 landscape names ride along with the live /models ids: a zai
    // provider with no curated config catalog still probes glm-5.3 each
    // refresh. When the provider serves it (echoed back here), the served id
    // is absent from /models, so it is harvested as a probe-sourced row —
    // discovery picks the model up the moment it goes live upstream.
    const { db } = await openTempDb();
    const requested: string[] = [];
    const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if (u.endsWith("/chat/completions")) {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
        if (body.reasoning_effort === "none") {
          return new Response(
            JSON.stringify({
              model: body.model,
              usage: { completion_tokens_details: { reasoning_tokens: 0 } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        requested.push(String(body.model));
        return new Response(JSON.stringify({ model: body.model }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return modelsResponse(["glm-5.2"]);
    });
    const report = await runProviderModelDiscovery({
      provider: "zai",
      cfg: cfgWith({ zai: { baseUrl: "https://api.z.ai/api/paas/v4" } }),
      nowMs: 1000,
      db,
      probeServed: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      resolveEndpoint: () => ({ baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "***" }),
    });
    // Watchlist id plus the live id, config absent → live ids still used.
    expect(requested).toEqual(["glm-5.3", "glm-5.2"]);
    expect(report.probedAdded).toEqual(["glm-5.3"]);
    const row = listDiscoveredModels(db, { provider: "zai" }).find((r) => r.modelId === "glm-5.3");
    expect(row?.source).toBe("probe");
    expect(row?.status).toBe("active");
  });

  it("stamps the advisory noThinkCompliant bit on upserted probe rows (QW1 2026-10-14)", async () => {
    // Empty-thinking audit: served ids the probe persists (unlisted) get a
    // second tiny completion with thinking disabled. Zero reasoning tokens →
    // noThinkCompliant:true; non-zero → false; advisory metadata only.
    const { db } = await openTempDb();
    const fetchFn = vi.fn(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if (u.endsWith("/chat/completions")) {
        const body = JSON.parse(String((init as { body?: string }).body ?? "{}"));
        // QW7 watchlist: landscape id not shipped yet — probe fails, skipped.
        if (body.model === "glm-5.3") {
          return new Response("not found", { status: 404 });
        }
        if (body.reasoning_effort === "none") {
          const reasoningTokens = body.model === "glm-heavy" ? 24 : 0;
          return new Response(
            JSON.stringify({
              model: body.model,
              usage: { completion_tokens_details: { reasoning_tokens: reasoningTokens } },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ model: body.model }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return modelsResponse(["unrelated-model"]);
    });
    const report = await runProviderModelDiscovery({
      provider: "zai",
      cfg: cfgWith({
        zai: {
          baseUrl: "https://api.z.ai/api/paas/v4",
          models: [{ id: "glm-lite" }, { id: "glm-heavy" }],
        },
      }),
      nowMs: 1000,
      db,
      probeServed: true,
      fetchFn: fetchFn as unknown as typeof fetch,
      resolveEndpoint: () => ({ baseUrl: "https://api.z.ai/api/paas/v4", apiKey: "test" }),
    });
    expect(report).toMatchObject({ provider: "zai", ok: true });
    expect(report.probedAdded).toEqual(["glm-lite", "glm-heavy"]);
    const rawRows = db
      .prepare("SELECT model_id, raw_json FROM model_catalog_discovered WHERE provider = ?")
      .all("zai") as Array<{ model_id: string; raw_json: string }>;
    const rawById = new Map(
      rawRows.map((row) => [row.model_id, JSON.parse(row.raw_json) as Record<string, unknown>]),
    );
    expect(rawById.get("glm-lite")?.noThinkCompliant).toBe(true);
    expect(rawById.get("glm-heavy")?.noThinkCompliant).toBe(false);
  });
});
