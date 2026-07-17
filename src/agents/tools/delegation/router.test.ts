// Router tests: config-driven auto-routing, priority tiers (zai/kimi primary,
// deepseek/moonshot fallback), real configured model ids, explicit overrides,
// and dynamic inclusion of newly-configured models.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveRoute } from "./router.js";

// Minimal cfg mirroring the real provider catalog shape.
function cfgWith(providers: Record<string, string[]>): OpenClawConfig {
  return {
    models: {
      providers: Object.fromEntries(
        Object.entries(providers).map(([id, models]) => [
          id,
          {
            baseUrl: `https://example/${id}`,
            api: "openai-completions",
            models: models.map((m) => ({ id: m })),
          },
        ]),
      ),
    },
  } as unknown as OpenClawConfig;
}

const FULL = cfgWith({
  zai: ["glm-5.1", "glm-4.7", "glm-4.6", "glm-4.6v"],
  kimi: ["kimi-for-coding"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
  moonshot: ["kimi-k2.6"],
});

describe("resolveRoute (config-driven)", () => {
  it("auto-routes to a GLM primary using the per-kind preferred model", () => {
    expect(resolveRoute({ kind: "code", cfg: FULL }).primary).toEqual({
      provider: "zai",
      model: "glm-4.7",
    });
    expect(resolveRoute({ kind: "review", cfg: FULL }).primary).toEqual({
      provider: "zai",
      model: "glm-5.1",
    });
    expect(resolveRoute({ kind: "vision", cfg: FULL }).primary).toEqual({
      provider: "zai",
      model: "glm-4.6v",
    });
  });

  it("orders the fast path by provider priority: zai, kimi, deepseek, moonshot", () => {
    const route = resolveRoute({ kind: "code", cfg: FULL });
    const fastProviders = [route.primary, ...route.fallbacks]
      .filter((c, i, arr) => arr.findIndex((x) => x.provider === c.provider) === i)
      .map((c) => c.provider);
    expect(fastProviders).toEqual(["zai", "kimi", "deepseek", "moonshot"]);
  });

  it("puts kimi-for-coding (subscription) ahead of deepseek/moonshot (pay-as-you-go)", () => {
    const route = resolveRoute({ kind: "code", cfg: FULL });
    const chain = [route.primary, ...route.fallbacks];
    const kimiIdx = chain.findIndex((c) => c.provider === "kimi");
    const deepseekIdx = chain.findIndex((c) => c.provider === "deepseek");
    const moonshotIdx = chain.findIndex((c) => c.provider === "moonshot");
    expect(kimiIdx).toBeGreaterThanOrEqual(0);
    expect(kimiIdx).toBeLessThan(deepseekIdx);
    expect(kimiIdx).toBeLessThan(moonshotIdx);
  });

  it("swarm: glm-4.7 primary, glm-4.6 same-provider retry, THEN cross-provider", () => {
    const route = resolveRoute({ kind: "swarm", cfg: FULL });
    const chain = [route.primary, ...route.fallbacks];
    expect(route.primary).toEqual({ provider: "zai", model: "glm-4.7" });
    // glm-4.6 (secondary) must come right after the primary and before kimi
    const g46 = chain.findIndex((c) => c.provider === "zai" && c.model === "glm-4.6");
    const kimi = chain.findIndex((c) => c.provider === "kimi");
    expect(g46).toBe(1);
    expect(g46).toBeLessThan(kimi);
  });

  it("honors an explicit provider override as primary", () => {
    const route = resolveRoute({ kind: "code", cfg: FULL, provider: "deepseek" });
    expect(route.primary).toEqual({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  it("honors an explicit model override on the primary provider only", () => {
    const route = resolveRoute({ kind: "code", cfg: FULL, provider: "zai", model: "glm-4.6" });
    expect(route.primary).toEqual({ provider: "zai", model: "glm-4.6" });
    // override does not leak into fallback candidates of other providers
    expect(route.fallbacks.some((c) => c.provider !== "zai" && c.model === "glm-4.6")).toBe(false);
  });

  it("dynamically includes a newly-configured model in the chain", () => {
    const cfg = cfgWith({ zai: ["glm-4.7", "glm-6-experimental"], deepseek: ["deepseek-v4-pro"] });
    const chain = (() => {
      const r = resolveRoute({ kind: "code", cfg });
      return [r.primary, ...r.fallbacks];
    })();
    expect(chain.some((c) => c.provider === "zai" && c.model === "glm-6-experimental")).toBe(true);
  });

  it("skips providers absent from config", () => {
    const cfg = cfgWith({ deepseek: ["deepseek-v4-pro"] });
    const route = resolveRoute({ kind: "code", cfg });
    expect(route.primary.provider).toBe("deepseek");
    expect([route.primary, ...route.fallbacks].every((c) => c.provider === "deepseek")).toBe(true);
  });

  it("falls back to the static catalog when cfg omits model lists", () => {
    const route = resolveRoute({ kind: "code" });
    expect(route.primary.provider).toBe("zai");
    expect(route.primary.model).toBe("glm-4.7");
  });

  it("reorders providers by effective cost within the same tier when cost data is available", () => {
    // DeepSeek is cheaper than Moonshot; both are metered.
    // Without cost data: deepseek → moonshot.
    const baseline = resolveRoute({ kind: "code", cfg: FULL });
    const baselineProviders = [baseline.primary, ...baseline.fallbacks]
      .filter((c, i, arr) => arr.findIndex((x) => x.provider === c.provider) === i)
      .map((c) => c.provider);
    // zai first (subscription), kimi second (subscription), deepseek third, moonshot fourth
    expect(baselineProviders).toEqual(["zai", "kimi", "deepseek", "moonshot"]);

    // With cost data: moonshot cheaper than deepseek → reordered within metered tier.
    const costAware = resolveRoute({
      kind: "code",
      cfg: FULL,
      effectiveCostPerMtok: { deepseek: 1.3, moonshot: 0.5 },
    });
    const costProviders = [costAware.primary, ...costAware.fallbacks]
      .filter((c, i, arr) => arr.findIndex((x) => x.provider === c.provider) === i)
      .map((c) => c.provider);
    expect(costProviders).toEqual(["zai", "kimi", "moonshot", "deepseek"]);
  });

  it("keeps subscription-tier providers ahead of metered regardless of cost", () => {
    // Even if deepseek is artificially cheap, zai/kimi stay ahead.
    const route = resolveRoute({
      kind: "code",
      cfg: FULL,
      effectiveCostPerMtok: { zai: 5.0, kimi: 4.0, deepseek: 0.01, moonshot: 0.02 },
    });
    const providers = [route.primary, ...route.fallbacks]
      .filter((c, i, arr) => arr.findIndex((x) => x.provider === c.provider) === i)
      .map((c) => c.provider);
    // Subscription providers stay first; within subscription tier, kimi is cheaper → before zai.
    expect(providers).toEqual(["kimi", "zai", "deepseek", "moonshot"]);
  });

  it("falls back to static priority when cost data is missing for some providers", () => {
    // Partial cost data: deepseek has a cost, moonshot doesn't.
    // Both are metered tier; with one cost missing, fall back to static priority.
    const route = resolveRoute({
      kind: "code",
      cfg: FULL,
      effectiveCostPerMtok: { deepseek: 1.3 },
    });
    const providers = [route.primary, ...route.fallbacks]
      .filter((c, i, arr) => arr.findIndex((x) => x.provider === c.provider) === i)
      .map((c) => c.provider);
    // Static order preserved for metered tier when cost data is incomplete.
    expect(providers).toEqual(["zai", "kimi", "deepseek", "moonshot"]);
  });

  it("does not change routing when cost data is absent", () => {
    const route = resolveRoute({ kind: "code", cfg: FULL });
    expect(route.primary).toEqual({ provider: "zai", model: "glm-4.7" });
  });
});
