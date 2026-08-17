// Router tests: config-driven auto-routing, priority tiers (zai/kimi primary,
// deepseek/moonshot fallback), real configured model ids, explicit overrides,
// and dynamic inclusion of newly-configured models.
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  recordProviderError,
  recordProviderLatency,
  resetLatencyState,
  resolveRoute,
  ROLE_TIER,
  tierForKind,
} from "./router.js";

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

describe("role-tier routing", () => {
  it("exports ROLE_TIER with correct backbone/execution classification", () => {
    expect(ROLE_TIER.plan).toBe("backbone");
    expect(ROLE_TIER.research).toBe("backbone");
    expect(ROLE_TIER.academic).toBe("backbone");
    expect(ROLE_TIER.review).toBe("backbone");
    expect(ROLE_TIER.code).toBe("execution");
    expect(ROLE_TIER.explore).toBe("execution");
    expect(ROLE_TIER.vision).toBe("execution");
    expect(ROLE_TIER.swarm).toBe("execution");
    expect(ROLE_TIER.delegate).toBe("execution");
  });

  it("tierForKind returns the tier for each kind", () => {
    expect(tierForKind("plan")).toBe("backbone");
    expect(tierForKind("code")).toBe("execution");
  });

  it("routes backbone kinds to the strongest model (glm-5.1)", () => {
    for (const kind of ["plan", "research", "academic", "review"] as const) {
      const route = resolveRoute({ kind, cfg: FULL });
      expect(route.primary).toEqual({ provider: "zai", model: "glm-5.1" });
    }
  });

  it("routes execution kinds to the fastest/cheaper model (glm-4.7)", () => {
    for (const kind of ["code", "explore", "swarm", "delegate"] as const) {
      const route = resolveRoute({ kind, cfg: FULL });
      expect(route.primary).toEqual({ provider: "zai", model: "glm-4.7" });
    }
  });

  it("vision routes to the vision-capable model regardless of tier", () => {
    const route = resolveRoute({ kind: "vision", cfg: FULL });
    expect(route.primary).toEqual({ provider: "zai", model: "glm-4.6v" });
  });

  it("backbone and execution produce different primaries for the same provider", () => {
    const backbone = resolveRoute({ kind: "plan", cfg: FULL }).primary;
    const execution = resolveRoute({ kind: "code", cfg: FULL }).primary;
    expect(backbone.model).not.toBe(execution.model);
    expect(backbone.model).toBe("glm-5.1");
    expect(execution.model).toBe("glm-4.7");
  });
});

// Latency balancing only reorders providers it has an opinion about. Returning a
// zero penalty for unmeasured providers would rank them ahead of measured healthy
// ones, and would leave an error-only provider looking pristine.
describe("delegation router adaptive latency balancing", () => {
  afterEach(() => {
    resetLatencyState();
  });

  const providerOrder = (kind: "code") =>
    resolveRoute({ kind, cfg: FULL }).fallbacks.map((c) => c.provider);

  it("preserves subscription-before-metered order when nobody has latency data", () => {
    // One preferred model per provider (priority order), then the deep-fallback tail.
    expect(providerOrder("code")).toEqual([
      "zai",
      "kimi",
      "deepseek",
      "moonshot",
      "zai",
      "zai",
      "deepseek",
    ]);
  });

  it("floats the faster of two measured providers ahead of the slower", () => {
    for (let i = 0; i < 3; i++) {
      recordProviderLatency("kimi", 15_000);
      recordProviderLatency("moonshot", 200);
    }
    const order = providerOrder("code");
    expect(order.indexOf("moonshot")).toBeLessThan(order.indexOf("kimi"));
  });

  it("reorders measured providers across an unmeasured one and leaves its slot alone", () => {
    // Chain is zai,kimi,deepseek,moonshot,… — measure the outer two and leave
    // deepseek unmeasured between them. A non-transitive comparator would let
    // slow kimi keep its lead here, since each side merely ties with deepseek.
    for (let i = 0; i < 3; i++) {
      recordProviderLatency("kimi", 15_000);
      recordProviderLatency("moonshot", 200);
    }
    const order = providerOrder("code");
    expect(order.indexOf("moonshot")).toBeLessThan(order.indexOf("kimi"));
    // deepseek has no opinion, so it stays in the slot priority order gave it.
    expect(order[2]).toBe("deepseek");
  });

  it("demotes a provider that has only ever errored", () => {
    const baseline = providerOrder("code");
    const [first, second] = baseline;
    for (let i = 0; i < 3; i++) {
      recordProviderLatency(second!, 100);
    }
    recordProviderError(first!);
    recordProviderError(first!);
    const reordered = providerOrder("code");
    expect(reordered.indexOf(second!)).toBeLessThan(reordered.indexOf(first!));
  });

  it("weights error penalties by failure class: silent > persistent > transient", () => {
    const baseline = providerOrder("code");
    const [a, b, c] = baseline;
    // Equal healthy latency baselines so only the error class differs.
    for (const provider of [a, b, c]) {
      for (let i = 0; i < 3; i++) {
        recordProviderLatency(provider!, 100);
      }
    }
    recordProviderError(a!, { failureClass: "silent" }); // 90s
    recordProviderError(b!, { failureClass: "persistent" }); // 60s
    recordProviderError(c!); // transient default 30s
    const order = providerOrder("code");
    expect(order.indexOf(c!)).toBeLessThan(order.indexOf(b!));
    expect(order.indexOf(b!)).toBeLessThan(order.indexOf(a!));
  });
});
