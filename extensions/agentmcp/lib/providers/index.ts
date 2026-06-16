// Provider factory + env-driven config reader.
//
// Boot path: index.ts calls readProviderConfig(provider) for each provider;
// missing API key → returns undefined → that provider's tools get skipped at
// registration. This way the server stays usable when only some keys are set.

import { makeDeepSeekProvider } from "./deepseek.js";
import { makeKimiProvider } from "./kimi.js";
import type { LlmClient, LlmConfig, Provider } from "./types.js";
import { makeZaiProvider } from "./zai.js";

export type { LlmClient, LlmConfig, Provider } from "./types.js";

const DEFAULT_BASE_URLS: Record<Provider, string> = {
  zai: "https://api.z.ai/api/coding/paas/v4",
  deepseek: "https://api.deepseek.com/v1",
  kimi: "https://api.moonshot.ai/v1",
};

const ENV_PREFIX: Record<Provider, string> = {
  zai: "ZAI",
  deepseek: "DEEPSEEK",
  kimi: "KIMI",
};

function readTimeoutEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Read a provider's config from env. Returns undefined if the API key is not
 * set so callers can skip that provider's tool registration cleanly.
 */
export function readProviderConfig(provider: Provider): LlmConfig | undefined {
  const prefix = ENV_PREFIX[provider];
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (!apiKey || apiKey.trim() === "") {
    return undefined;
  }
  const baseUrl = process.env[`${prefix}_BASE_URL`] ?? DEFAULT_BASE_URLS[provider];
  const timeoutMs = readTimeoutEnv(`${prefix}_TIMEOUT_MS`);
  return timeoutMs !== undefined ? { apiKey, baseUrl, timeoutMs } : { apiKey, baseUrl };
}

export function makeProvider(provider: Provider, config: LlmConfig): LlmClient {
  switch (provider) {
    case "zai":
      return makeZaiProvider(config);
    case "deepseek":
      return makeDeepSeekProvider(config);
    case "kimi":
      return makeKimiProvider(config);
  }
}
