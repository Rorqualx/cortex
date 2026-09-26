import { describe, expect, it } from "vitest";
import { estimateCostUsd, formatCostUsd, prefillCostClassFor } from "./pricing.js";
import type { Provider } from "./providers/types.js";

// QW-5 (2026-09-26): advisory prefill-cost class on the delegation price
// table — additive metadata, advisory until the router consumes it. Also
// pins the core estimateCostUsd math (this file had no coverage before).
describe("prefillCostClassFor", () => {
  it("tags the DeepSeek V4 pair as cheap-prefill (≈50× cached-input discount)", () => {
    expect(prefillCostClassFor("deepseek" as Provider, "deepseek-v4-flash")).toBe("cheap-prefill");
    // Model ids are matched case-insensitively, like estimateCostUsd.
    expect(prefillCostClassFor("deepseek" as Provider, "DeepSeek-V4-Pro")).toBe("cheap-prefill");
  });

  it("returns standard for priced models without the tag", () => {
    expect(prefillCostClassFor("zai" as Provider, "glm-5")).toBe("standard");
    expect(prefillCostClassFor("kimi" as Provider, "kimi-k2.6")).toBe("standard");
  });

  it("returns undefined for unknown models (no-signal, not standard)", () => {
    expect(prefillCostClassFor("zai" as Provider, "glm-nonexistent")).toBeUndefined();
  });
});

describe("estimateCostUsd", () => {
  it("returns undefined for unknown models", () => {
    expect(estimateCostUsd("zai" as Provider, "nope", 100, 100)).toBeUndefined();
  });

  it("computes input + output cost (glm-5: $1/M in, $3.2/M out)", () => {
    const cost = estimateCostUsd("zai" as Provider, "glm-5", 1_000_000, 500_000);
    expect(cost).toBeCloseTo(1.0 + 3.2 * 0.5, 9);
  });

  it("bills cache hits at the cachedInput rate when provided", () => {
    // deepseek-v4-flash: $0.14/M miss, $0.0028/M hit. 600k miss + 400k hit.
    const cost = estimateCostUsd(
      "deepseek" as Provider,
      "deepseek-v4-flash",
      1_000_000,
      0,
      400_000,
    );
    expect(cost).toBeCloseTo((600_000 * 0.14 + 400_000 * 0.0028) / 1_000_000, 9);
  });

  it("falls back to the regular input rate for cache hits when no cachedInput exists", () => {
    // kimi-k2.5 has no cachedInput: all 1M tokens billed at $0.44/M.
    const cost = estimateCostUsd("kimi" as Provider, "kimi-k2.5", 1_000_000, 0, 250_000);
    expect(cost).toBeCloseTo(0.44, 9);
  });
});

describe("formatCostUsd", () => {
  it("adapts precision and omits undefined cleanly", () => {
    expect(formatCostUsd(undefined)).toBeNull();
    expect(formatCostUsd(0)).toBe("$0");
    expect(formatCostUsd(0.002)).toBe("$0.0020");
    expect(formatCostUsd(0.5)).toBe("$0.500");
    expect(formatCostUsd(2.5)).toBe("$2.50");
  });
});
