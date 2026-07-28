// Kimi Coding plugin entrypoint registers its OpenClaw integration.
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { applyKimiCodeConfig, KIMI_CODING_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { buildKimiCodingProvider, normalizeKimiCodingModelId } from "./provider-catalog.js";
import { isKimiK3ModelId, resolveThinkingProfile } from "./provider-policy-api.js";
import { KIMI_REPLAY_POLICY } from "./replay-policy.js";
import { wrapKimiProviderStream } from "./stream.js";

const PLUGIN_ID = "kimi";
const PROVIDER_ID = "kimi";

function findExplicitProviderConfig(
  providers: Record<string, unknown> | undefined,
  providerId: string,
): Record<string, unknown> | undefined {
  if (!providers) {
    return undefined;
  }
  const normalizedProviderId = normalizeProviderId(providerId);
  const match = Object.entries(providers).find(
    ([configuredProviderId]) => normalizeProviderId(configuredProviderId) === normalizedProviderId,
  );
  return isRecord(match?.[1]) ? match[1] : undefined;
}
export default defineSingleProviderPluginEntry({
  id: PLUGIN_ID,
  name: "Kimi Provider",
  description: "Bundled Kimi provider plugin",
  manifest,
  provider: {
    id: PROVIDER_ID,
    label: "Kimi",
    aliases: ["kimi-code", "kimi-coding"],
    docsPath: "/providers/moonshot",
    envVars: ["KIMI_API_KEY", "KIMICODE_API_KEY"],
    manifestAuth: {
      promptMessage: "Enter Kimi API key",
      defaultModel: KIMI_CODING_MODEL_REF,
      expectedProviders: ["kimi", "kimi-code", "kimi-coding"],
      applyConfig: applyKimiCodeConfig,
      noteMessage: [
        "Kimi uses a dedicated coding endpoint and API key.",
        "Get your API key at: https://www.kimi.com/code/console",
      ].join("\n"),
      noteTitle: "Kimi",
    },
    catalog: {
      order: "simple",
      run: async (ctx) => {
        const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
        if (!apiKey) {
          return null;
        }
        const explicitProvider = findExplicitProviderConfig(
          ctx.config.models?.providers as Record<string, unknown> | undefined,
          PROVIDER_ID,
        );
        const builtInProvider = buildKimiCodingProvider();
        const explicitBaseUrl = normalizeOptionalString(explicitProvider?.baseUrl) ?? "";
        const explicitHeaders = isRecord(explicitProvider?.headers)
          ? (explicitProvider.headers as Record<string, SecretInput>)
          : undefined;
        return {
          provider: {
            ...builtInProvider,
            ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
            ...(explicitHeaders
              ? {
                  headers: {
                    ...builtInProvider.headers,
                    ...explicitHeaders,
                  },
                }
              : {}),
            apiKey,
          },
        };
      },
    },
    buildReplayPolicy: () => KIMI_REPLAY_POLICY,
    normalizeResolvedModel: ({ model }) => {
      const normalizedId = normalizeKimiCodingModelId(model.id);
      return normalizedId === model.id ? undefined : { ...model, id: normalizedId };
    },
    normalizeModelId: ({ modelId }) => normalizeKimiCodingModelId(modelId),
    // K3 models keep the shared policy profile (off/max + catalog-preserve).
    // Other Kimi Code models (anthropic-messages) support graded
    // extended-thinking budgets, not just on/off: low/medium/high map to
    // 1024/4096/8192 budget_tokens via KIMI_ANTHROPIC_THINKING_BUDGETS in
    // stream.ts. Surface those distinct tiers so callers get real depth
    // control. minimal/xhigh/max collapse onto the same budgets, so they're
    // intentionally not offered (would be indistinguishable).
    resolveThinkingProfile: (ctx) =>
      isKimiK3ModelId(ctx.modelId)
        ? resolveThinkingProfile(ctx)
        : {
            levels: [
              { id: "off", label: "off" },
              { id: "low", label: "low" },
              { id: "medium", label: "medium" },
              { id: "high", label: "high" },
            ],
            defaultLevel: "off",
          },
    wrapSimpleCompletionStreamFn: (ctx) =>
      isKimiK3ModelId(ctx.modelId) ? wrapKimiProviderStream(ctx) : ctx.streamFn,
    wrapStreamFn: wrapKimiProviderStream,
  },
});
