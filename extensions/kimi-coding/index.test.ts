// Kimi Coding tests cover index plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("kimi provider plugin", () => {
  it("normalizes legacy Kimi Code ids to the stable API model id", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.normalizeResolvedModel?.({
        provider: "kimi",
        modelId: "kimi-code",
        model: {
          id: "kimi-code",
          name: "Kimi Code",
          provider: "kimi",
          api: "anthropic-messages",
        },
      } as never),
    ).toEqual({
      id: "kimi-for-coding",
      name: "Kimi Code",
      provider: "kimi",
      api: "anthropic-messages",
    });
  });

  it("exposes graded thinking budgets (off/low/medium/high) with thinking off by default", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    // Distinct budget tiers from KIMI_ANTHROPIC_THINKING_BUDGETS (1024/4096/8192);
    // minimal/xhigh/max collapse onto these so they're not surfaced.
    expect(
      provider.resolveThinkingProfile?.({
        provider: "kimi",
        modelId: "kimi-code",
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ],
      defaultLevel: "off",
    });
  });

  it.each(["k3", "k3[1m]"])("exposes %s off and max thinking", async (modelId) => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "kimi",
        modelId,
        reasoning: true,
      } as never),
    ).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "max",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("wraps K3 simple completions without changing K2 simple completions", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const streamFn = (() => undefined) as never;

    expect(
      provider.wrapSimpleCompletionStreamFn?.({
        provider: "kimi",
        modelId: "k3",
        streamFn,
      } as never),
    ).not.toBe(streamFn);
    expect(
      provider.wrapSimpleCompletionStreamFn?.({
        provider: "kimi",
        modelId: "kimi-for-coding",
        streamFn,
      } as never),
    ).toBe(streamFn);
  });
});
