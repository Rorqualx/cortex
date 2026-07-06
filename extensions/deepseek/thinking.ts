// Deepseek plugin module implements thinking behavior.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { isDeepSeekV4ModelId } from "./models.js";

// DeepSeek V4 accepts reasoning_effort {low, medium, high, xhigh, max} (verified
// live; "minimal"/"none" 400). "off" maps to thinking.disabled, so the offered
// ladder is off + the five real efforts — no "minimal" rung the API would reject.
const V4_THINKING_LEVEL_IDS = ["off", "low", "medium", "high", "xhigh", "max"] as const;

function buildDeepSeekV4ThinkingLevel(id: (typeof V4_THINKING_LEVEL_IDS)[number]) {
  return { id };
}

const DEEPSEEK_V4_THINKING_PROFILE = {
  levels: V4_THINKING_LEVEL_IDS.map(buildDeepSeekV4ThinkingLevel),
  // "high" is DeepSeek V4's own vendor default (api-docs.deepseek.com/guides/thinking_mode),
  // not an over-set: the API exposes only "high" (default) and "max" as real tiers and maps
  // low/medium -> high and xhigh -> max. Do not "right-size" this to medium — DeepSeek would
  // silently run it at high anyway, so a lower default would only misreport the effort.
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

export function resolveDeepSeekV4ThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  return isDeepSeekV4ModelId(modelId) ? DEEPSEEK_V4_THINKING_PROFILE : undefined;
}
