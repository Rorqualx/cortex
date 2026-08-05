// Covers the doctor warning for discovered models a pinned modelPolicy.allow forbids.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { collectModelPolicyDiscoveryWarnings } from "./model-policy-discovery-warnings.js";

function cfgWithAllow(allow?: string[]): OpenClawConfig {
  return {
    models: {
      providers: {
        qwen: { baseUrl: "https://example.invalid/v1", models: [] },
        zai: { baseUrl: "https://api.z.ai/v4", models: [] },
      },
    },
    agents: { defaults: allow ? { modelPolicy: { allow } } : {} },
  } as unknown as OpenClawConfig;
}

const catalog = [
  { provider: "qwen", id: "qwen3.8-max" },
  { provider: "qwen", id: "qwen3.7-plus" },
  { provider: "zai", id: "glm-5.2" },
] as never;

const discovered = [
  { provider: "qwen", modelId: "qwen3.8-max" },
  { provider: "qwen", modelId: "qwen3.7-plus" },
  { provider: "zai", modelId: "glm-5.2" },
];

const base = { catalog, discovered, defaultProvider: "zai", defaultModel: "glm-5.2" };

describe("collectModelPolicyDiscoveryWarnings", () => {
  it("stays silent when no allow list is configured", () => {
    // An empty or absent allow list permits any model, which is the documented
    // default — warning there would fire for every install.
    expect(collectModelPolicyDiscoveryWarnings({ cfg: cfgWithAllow(), ...base })).toEqual([]);
  });

  it("stays silent when provider wildcards cover the discovered catalog", () => {
    // Wildcards are the durable shape: the whole point is that a growing catalog
    // stops needing config edits, so covering them must not nag.
    expect(
      collectModelPolicyDiscoveryWarnings({ cfg: cfgWithAllow(["qwen/*", "zai/*"]), ...base }),
    ).toEqual([]);
  });

  it("names the provider and counts when a pinned list has fallen behind", () => {
    // The 2026-08-04 shape: one model pinned, the rest of the provider's
    // discovered catalog silently unusable.
    const warnings = collectModelPolicyDiscoveryWarnings({
      cfg: cfgWithAllow(["qwen/qwen3.8-max", "zai/glm-5.2"]),
      ...base,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("qwen 1/2");
    expect(warnings[0]).toContain("modelPolicy.allow");
    expect(warnings[0]).toContain('"qwen/*"');
    // zai is fully covered, so it must not be named.
    expect(warnings[0]).not.toContain("zai 1");
  });

  it("stays silent when nothing has been discovered", () => {
    expect(
      collectModelPolicyDiscoveryWarnings({
        ...base,
        cfg: cfgWithAllow(["qwen/*"]),
        discovered: [],
      }),
    ).toEqual([]);
  });
});
