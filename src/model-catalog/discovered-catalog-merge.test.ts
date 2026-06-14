// Covers discovered-catalog overlay: hide deprecated, auto-populate new, keep metadata.
import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { applyDiscoveredCatalog } from "./discovered-catalog-merge.js";
import type { DiscoveredModelRecord } from "./discovered-store.js";

function rec(
  provider: string,
  modelId: string,
  status: "active" | "deprecated",
): DiscoveredModelRecord {
  return {
    provider,
    modelId,
    ref: `${provider}/${modelId}`,
    name: null,
    status,
    source: "models",
    createdRemoteMs: null,
    lastSeenAtMs: 0,
    deprecatedAtMs: status === "deprecated" ? 1 : null,
  };
}

describe("applyDiscoveredCatalog", () => {
  const base: ModelCatalogEntry[] = [
    { id: "glm-5", name: "GLM-5", provider: "zai", contextWindow: 200_000, reasoning: true },
    { id: "glm-5v-turbo", name: "GLM-5V Turbo", provider: "zai", contextWindow: 200_000 },
  ];

  it("removes deprecated models even when a manifest/config row declares them", () => {
    const result = applyDiscoveredCatalog({
      models: base,
      active: [rec("zai", "glm-5", "active")],
      deprecated: [rec("zai", "glm-5v-turbo", "deprecated")],
    });
    expect(result.map((m) => m.id)).toEqual(["glm-5"]);
  });

  it("auto-populates newly discovered models not already present", () => {
    const result = applyDiscoveredCatalog({
      models: base,
      active: [rec("zai", "glm-5", "active"), rec("zai", "glm-6", "active")],
      deprecated: [],
    });
    expect(result.map((m) => m.id).sort()).toEqual(["glm-5", "glm-5v-turbo", "glm-6"]);
  });

  it("preserves existing manifest metadata for already-present models", () => {
    const result = applyDiscoveredCatalog({
      models: base,
      active: [rec("zai", "glm-5", "active")],
      deprecated: [],
    });
    expect(result.find((m) => m.id === "glm-5")?.contextWindow).toBe(200_000);
    expect(result.find((m) => m.id === "glm-5")?.reasoning).toBe(true);
  });

  it("is a no-op when there are no discovered rows", () => {
    expect(applyDiscoveredCatalog({ models: base, active: [], deprecated: [] })).toEqual(base);
  });
});
