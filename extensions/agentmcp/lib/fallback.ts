// Provider fallback logic for rate-limit and error recovery.
//
// When a provider returns 429 (rate limit) or 5xx, automatically retry with
// the next available provider in the fallback chain. This eliminates the
// 35% failure rate from GLM weekly/monthly limit exhaustion.
//
// Fallback chain (configurable via AGENTMCP_FALLBACK_ORDER env):
//   Default: zai → deepseek → kimi
//   Rationale: GLM is zero-marginal-cost on Coding Plan, so it's first choice.
//   DeepSeek is fast and cheap. Kimi is the context-size specialist.

import type {
  LlmClient,
  LlmError,
  LlmCallParams,
  LlmCallResult,
  Provider,
} from "./providers/types.js";

export type FallbackConfig = {
  /** Provider preference order. First = primary. */
  chain: Provider[];
  /** HTTP status codes that trigger fallback. */
  retryableStatuses: number[];
  /** Whether to fallback on network/timeout errors (no HTTP status). */
  fallbackOnNetworkError: boolean;
};

const DEFAULT_FALLBACK_CHAIN: Provider[] = ["zai", "deepseek", "kimi"];

function parseFallbackChain(env?: string): Provider[] {
  if (!env) {
    return DEFAULT_FALLBACK_CHAIN;
  }
  const providers = env
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p): p is Provider => ["zai", "deepseek", "kimi"].includes(p as Provider));
  return providers.length > 0 ? providers : DEFAULT_FALLBACK_CHAIN;
}

export function loadFallbackConfig(): FallbackConfig {
  const env = process.env["AGENTMCP_FALLBACK_ORDER"];
  return {
    chain: parseFallbackChain(env),
    retryableStatuses: [429, 502, 503, 504],
    fallbackOnNetworkError: true,
  };
}

/** Check if an error should trigger provider fallback. */
export function isRetryableError(err: unknown, config: FallbackConfig): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  // LlmError with retryable status
  if ("status" in err && typeof (err as any).status === "number") {
    return config.retryableStatuses.includes((err as any).status);
  }
  // Network/timeout errors (no status, or AbortError)
  if (config.fallbackOnNetworkError) {
    if (err.name === "AbortError") {
      return true;
    }
    if ("provider" in err) {
      return true;
    } // LlmError without status = network issue
  }
  return false;
}

/** Find the next provider in the fallback chain after the given one. */
export function nextFallbackProvider(
  current: Provider,
  chain: Provider[],
  available: Set<Provider>,
): Provider | undefined {
  const idx = chain.indexOf(current);
  if (idx === -1) {
    return undefined;
  }
  for (let i = idx + 1; i < chain.length; i++) {
    const p = chain[i];
    if (available.has(p)) {
      return p;
    }
  }
  return undefined;
}

/** Result of a fallback-aware call. */
export type FallbackResult = {
  result: LlmCallResult;
  provider: Provider;
  attempts: { provider: Provider; latencyMs: number; error?: string }[];
};

/**
 * Execute an LLM call with automatic provider fallback on rate limits.
 *
 * @param clients Map of available provider clients
 * @param config Fallback configuration
 * @param primary Preferred provider to try first
 * @param params LLM call parameters
 * @returns The successful result + metadata about attempts
 */
export async function callWithFallback(
  clients: Record<Provider, LlmClient | undefined>,
  config: FallbackConfig,
  primary: Provider,
  params: LlmCallParams,
): Promise<FallbackResult> {
  const available = new Set(
    (Object.entries(clients) as [Provider, LlmClient | undefined][])
      .filter(([, c]) => c !== undefined)
      .map(([p]) => p),
  );

  const attempts: { provider: Provider; latencyMs: number; error?: string }[] = [];
  let currentProvider = primary;

  // If primary is not available, jump to first available in chain
  if (!available.has(currentProvider)) {
    const fallback = nextFallbackProvider("zai", config.chain, available);
    if (!fallback) {
      throw new Error(`No available providers. Primary ${primary} is unavailable.`);
    }
    currentProvider = fallback;
  }

  while (currentProvider) {
    const client = clients[currentProvider];
    if (!client) {
      attempts.push({ provider: currentProvider, latencyMs: 0, error: "Client not configured" });
      currentProvider = nextFallbackProvider(currentProvider, config.chain, available);
      continue;
    }

    const start = Date.now();
    try {
      const result = await client.call(params);
      attempts.push({ provider: currentProvider, latencyMs: Date.now() - start });
      return { result, provider: currentProvider, attempts };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      attempts.push({ provider: currentProvider, latencyMs, error: errorMsg });

      if (!isRetryableError(err, config)) {
        throw err; // Non-retryable error, propagate immediately
      }

      // Try next provider in chain
      currentProvider = nextFallbackProvider(currentProvider, config.chain, available);
    }
  }

  // Exhausted all providers
  const summary = attempts
    .map((a) => `${a.provider}: ${a.error ?? "ok"} (${a.latencyMs}ms)`)
    .join("; ");
  throw new Error(`All providers failed. Attempts: ${summary}`);
}
