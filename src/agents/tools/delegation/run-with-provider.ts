// Executes a delegated LLM job across a provider+model candidate chain using
// OpenClaw's core model-fallback engine (auth-profile resolution, cooldowns,
// failover observation) while building the OpenAI-compat client per candidate.
//
// The chain comes from router.resolveRoute (config-driven). We hand it to
// runWithModelFallback as primary + fallbacksOverride model refs; its
// `run(provider, model)` closure resolves that provider's client kind, base
// URL, and key (host auth) and runs the kind-specific work. Providers with an
// unsupported dialect or no key throw, which advances the chain. An empty
// result is classified as fallback-eligible so a silent dud advances too.

import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { runWithModelFallback } from "../../model-fallback.js";
import { resolveDelegationClient, type HostAuthResolver } from "./host-config.js";
import type { LlmClient } from "./providers/types.js";
import { recordProviderError, recordProviderLatency } from "./router.js";
import type { Candidate } from "./router.js";

export type RunDelegationParams<T> = {
  cfg: OpenClawConfig | undefined;
  primary: Candidate;
  fallbacks?: Candidate[] | undefined;
  resolveApiKeyForProvider?: HostAuthResolver | undefined;
  agentId?: string | undefined;
  sessionKey?: string | undefined;
  abortSignal?: AbortSignal | undefined;
  /** Kind-specific work: produce a result from a ready client + chosen model. */
  run: (client: LlmClient, model: string, providerId: string) => Promise<T>;
  /**
   * Returns a reason string when a produced result is unusable (e.g. empty
   * content), advancing the chain. Returns undefined to accept the result.
   */
  unusableReason?: ((result: T) => string | undefined) | undefined;
};

export type RunDelegationResult<T> = {
  result: T;
  provider: string;
  model: string;
};

/**
 * Run a delegated job with provider fallback. Throws if every candidate fails
 * (unsupported dialect, no key, provider error, or unusable result).
 */
export async function runDelegation<T>(
  params: RunDelegationParams<T>,
): Promise<RunDelegationResult<T>> {
  const fallbacksOverride = (params.fallbacks ?? []).map((c) => `${c.provider}/${c.model}`);

  const outcome = await runWithModelFallback<T>({
    cfg: params.cfg,
    provider: params.primary.provider,
    model: params.primary.model,
    fallbacksOverride,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    abortSignal: params.abortSignal,
    classifyResult: ({ result }) => {
      const reason = params.unusableReason?.(result);
      return reason ? { message: reason, reason: "empty_response" } : null;
    },
    run: async (providerId, model) => {
      const client = await resolveDelegationClient(
        providerId,
        params.cfg,
        params.resolveApiKeyForProvider,
      );
      if (!client) {
        // Unsupported provider or no key — advance the chain.
        recordProviderError(providerId);
        throw new Error(
          `delegation: provider '${providerId}' is unavailable (no key or unsupported); advancing fallback`,
        );
      }
      const startTime = Date.now();
      try {
        const result = await params.run(client, model, providerId);
        recordProviderLatency(providerId, Date.now() - startTime);
        return result;
      } catch (err) {
        recordProviderError(providerId);
        throw err;
      }
    },
  });

  return { result: outcome.result, provider: outcome.provider, model: outcome.model };
}
