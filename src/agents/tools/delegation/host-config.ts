// Builds a ready delegation LlmClient for an OpenClaw config provider id.
//
// Each config provider id maps to a client implementation + transport:
//   zai       → OpenAI-compat (GLM, z.ai coding plan)
//   deepseek  → OpenAI-compat
//   moonshot  → OpenAI-compat (Kimi/Moonshot pay-as-you-go)
//   kimi      → Anthropic-messages (kimi-for-coding subscription, api.kimi.com/coding)
//
// Base URLs come from host config (falling back to defaults); keys come from
// the host auth-profile store (with an env fallback for standalone use). The
// resolved auth `mode` is threaded to the Anthropic client so it picks x-api-key
// vs Bearer correctly.

import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { makeProvider } from "./providers/index.js";
import { makeKimiCodingProvider } from "./providers/kimi-coding.js";
import type { LlmClient } from "./providers/types.js";

const DEFAULT_BASE_URLS: Record<string, string> = {
  zai: "https://api.z.ai/api/coding/paas/v4",
  deepseek: "https://api.deepseek.com",
  moonshot: "https://api.moonshot.ai/v1",
  kimi: "https://api.kimi.com/coding",
};

const ENV_KEY_FALLBACK: Record<string, string> = {
  zai: "ZAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  moonshot: "KIMI_API_KEY",
  kimi: "KIMI_CODING_API_KEY",
};

/** Providers the delegation clients can serve. */
const SUPPORTED: ReadonlySet<string> = new Set(["zai", "deepseek", "moonshot", "kimi"]);

export type HostAuth = { apiKey?: string; mode?: "api-key" | "oauth" | "token" | "aws-sdk" };

/** Host auth resolver, as wired from the core resolveApiKeyForProvider. */
export type HostAuthResolver = (
  providerId: string,
) => Promise<HostAuth | undefined> | HostAuth | undefined;

export function isDelegationProvider(providerId: string): boolean {
  return SUPPORTED.has(providerId);
}

/**
 * Resolve a ready client for a config provider id, or undefined when the
 * provider is unsupported or no key is available (so the chain advances).
 */
export async function resolveDelegationClient(
  providerId: string,
  cfg: OpenClawConfig | undefined,
  resolveAuth?: HostAuthResolver,
): Promise<LlmClient | undefined> {
  if (!SUPPORTED.has(providerId)) return undefined;

  const auth = resolveAuth ? await resolveAuth(providerId) : undefined;
  let apiKey = auth?.apiKey;
  if (!apiKey || apiKey.trim() === "") {
    apiKey = process.env[ENV_KEY_FALLBACK[providerId]!];
  }
  if (!apiKey || apiKey.trim() === "") return undefined;

  const baseUrl = cfg?.models?.providers?.[providerId]?.baseUrl ?? DEFAULT_BASE_URLS[providerId]!;

  switch (providerId) {
    case "zai":
      return makeProvider("zai", { apiKey, baseUrl });
    case "deepseek":
      return makeProvider("deepseek", { apiKey, baseUrl });
    case "moonshot":
      // OpenAI-compat Moonshot (pay-as-you-go) → ported "kimi" client.
      return makeProvider("kimi", { apiKey, baseUrl });
    case "kimi":
      // kimi-for-coding (anthropic-messages dialect).
      return makeKimiCodingProvider({
        apiKey,
        baseUrl,
        authMode: auth?.mode === "aws-sdk" ? undefined : auth?.mode,
      });
    default:
      return undefined;
  }
}
