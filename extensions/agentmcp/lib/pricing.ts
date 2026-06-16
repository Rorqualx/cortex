// Cost estimation across the three providers (Z.ai/GLM, DeepSeek, Kimi/Moonshot).
//
// All Coding-Plan / membership-plan callers pay $0 for any of these — the
// estimates exist for efficiency comparisons in the footer, model-mix tuning,
// and a what-would-this-cost-on-PaaS reference. They are NOT a billing source.
//
// Sources (all verified 2026-05-03):
//   Z.ai     https://docs.z.ai/guides/overview/pricing
//   DeepSeek https://api-docs.deepseek.com/quick_start/pricing
//   Kimi     https://platform.kimi.ai/docs/pricing/chat-k26 + sibling pages
//
// Prices in USD per 1M tokens. `cachedInput` is the discounted rate when a
// provider exposes per-call cache-hit token counts (DeepSeek, Kimi). When
// cachedInput is absent on an entry but the caller passes cacheHitTokens, we
// fall back to billing those tokens at the regular input rate.

import type { Provider } from "./providers/types.js";

type ModelPrice = { input: number; cachedInput?: number; output: number };

// Composite key: `${provider}:${model.toLowerCase()}`. Keep model names in
// sync with the per-provider enums in schemas.ts. A missing entry returns
// undefined cost so the footer can omit the segment cleanly.
const PRICES: Record<string, ModelPrice> = {
  // === Z.ai (GLM) ===
  // glm-5.1 is on a 1× honeymoon rate through June 2026 per docs.z.ai/devpack/faq.
  // From July 2026 Z.ai charges 2× off-peak / 3× peak — bump these then.
  "zai:glm-5.1": { input: 1.4, output: 4.4 },
  "zai:glm-5": { input: 1, output: 3.2 },
  "zai:glm-5-turbo": { input: 1.2, output: 4 },
  "zai:glm-4.7": { input: 0.6, output: 2.2 },
  "zai:glm-4.7-flash": { input: 0, output: 0 }, // free tier
  "zai:glm-4.6": { input: 0.6, output: 2.2 },
  "zai:glm-4.5": { input: 0.6, output: 2.2 },
  "zai:glm-4.5-air": { input: 0.2, output: 1.1 },
  "zai:glm-4.5-flash": { input: 0, output: 0 }, // free tier
  "zai:glm-4.6v": { input: 0.3, output: 0.9 },
  "zai:glm-4.5v": { input: 0.6, output: 1.8 },

  // === DeepSeek ===
  // deepseek-v4-pro is at 75% promotional discount through 2026-05-31 15:59 UTC.
  // Full rates after that: input $1.74 / cachedInput $0.0145 / output $3.48.
  "deepseek:deepseek-v4-flash": { input: 0.14, cachedInput: 0.0028, output: 0.28 },
  "deepseek:deepseek-v4-pro": { input: 0.435, cachedInput: 0.003625, output: 0.87 },

  // === Kimi (Moonshot) ===
  "kimi:kimi-k2.6": { input: 0.95, cachedInput: 0.16, output: 4 },
  "kimi:kimi-k2.5": { input: 0.44, output: 2 },
  "kimi:kimi-k2-thinking": { input: 0.6, cachedInput: 0.15, output: 2.5 },
  "kimi:kimi-k2-thinking-turbo": { input: 1.15, cachedInput: 0.15, output: 8 },
  "kimi:kimi-k2-0905-preview": { input: 0.6, cachedInput: 0.15, output: 2.5 },
  "kimi:kimi-k2-0711-preview": { input: 0.6, cachedInput: 0.15, output: 2.5 },
  "kimi:kimi-k2-turbo-preview": { input: 1.15, cachedInput: 0.15, output: 8 },
  "kimi:moonshot-v1-8k": { input: 0.2, output: 2 },
  "kimi:moonshot-v1-32k": { input: 1, output: 3 },
  "kimi:moonshot-v1-128k": { input: 2, output: 5 },
  "kimi:moonshot-v1-8k-vision-preview": { input: 0.2, output: 2 },
  "kimi:moonshot-v1-32k-vision-preview": { input: 1, output: 3 },
  "kimi:moonshot-v1-128k-vision-preview": { input: 2, output: 5 },
};

/**
 * Estimate USD cost for a single call (or accumulated explore loop).
 *
 * Returns undefined for unknown (provider, model) pairs so callers can omit
 * the field cleanly rather than render `$NaN`.
 *
 * cacheHitTokens (when provided) is subtracted from inputTokens and billed at
 * the cached rate. If the entry has no cachedInput rate, hit tokens fall back
 * to the regular input rate.
 */
export function estimateCostUsd(
  provider: Provider,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheHitTokens?: number,
): number | undefined {
  const price = PRICES[`${provider}:${model.toLowerCase()}`];
  if (!price) {
    return undefined;
  }

  const hit = Math.max(0, Math.min(cacheHitTokens ?? 0, inputTokens));
  const miss = inputTokens - hit;
  const cachedRate = price.cachedInput ?? price.input;
  const inputCost = (miss * price.input + hit * cachedRate) / 1_000_000;
  const outputCost = (outputTokens * price.output) / 1_000_000;
  return inputCost + outputCost;
}

/**
 * Format a cost as a footer-friendly string with adaptive precision —
 * sub-cent costs need 4 decimals; sub-dollar 3; otherwise 2.
 * Returns null on undefined so the caller can omit the segment entirely.
 */
export function formatCostUsd(cost: number | undefined): string | null {
  if (cost === undefined) {
    return null;
  }
  if (cost === 0) {
    return "$0";
  }
  if (cost < 0.01) {
    return `$${cost.toFixed(4)}`;
  }
  if (cost < 1) {
    return `$${cost.toFixed(3)}`;
  }
  return `$${cost.toFixed(2)}`;
}
