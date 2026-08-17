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
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { resolveDelegationClient, type HostAuthResolver } from "./host-config.js";
import type { LlmClient } from "./providers/types.js";
import { recordProviderError, recordProviderLatency } from "./router.js";
import type { Candidate, ProviderFailureClass } from "./router.js";

// ---------------------------------------------------------------------------
// Failure-class → policy mapping (strategy-aware delegation, Finding #12)
// ---------------------------------------------------------------------------
//   transient  (timeout / 5xx / 429 / network)  → provider stays in play: the
//               chain's same-provider sibling retry + provider advance handle
//               it; latency penalty stays at the transient weight.
//   persistent (auth / 4xx / schema / no key)   → the provider is marked failed
//               for THIS run and its remaining candidates are skipped without
//               an API call, jumping the chain to the next provider.
//   silent     (tool "succeeded" but the output fails verification) → with the
//               experimental abort flag ON, abort the whole chain with a
//               doom-loop-style status instead of burning every remaining
//               candidate on dud outputs; with it OFF (default) the chain
//               advances as before, but the silent class still weighs on the
//               router's error penalty.

export type DelegationFailureClass = ProviderFailureClass;

const TRANSIENT_SIGNALS =
  /timeout|timed[ _-]?out|etimedout|econnreset|econnaborted|econnrefused|enotfound|eai_again|epipe|socket hang up|network|fetch failed|aborted|cancel|\b50[0234]\b|\b529\b|overloaded|rate.?limit|\b429\b|too many requests/iu;
const MODEL_SCOPED_SIGNALS =
  /\bmodel\b[\s\S]{0,64}?not (?:found|exist|available)|model_not_found|no such model|does not exist/iu;

/**
 * Classify a thrown provider failure. Only clear transient signals map to
 * "transient"; everything else (4xx/auth/schema/dialect) is "persistent".
 * "silent" never arrives here — it is a produced-but-unusable result, classified
 * on the unusableReason path, not a throw.
 */
export function classifyDelegationError(err: unknown): DelegationFailureClass {
  const message = err instanceof Error ? err.message : String(err);
  return TRANSIENT_SIGNALS.test(message) ? "transient" : "persistent";
}

/**
 * Model-scoped persistent failures (e.g. 404 model-not-found) affect one model,
 * not the provider — they advance to the provider's next model instead of
 * skipping the provider entirely.
 */
export function isModelScopedFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return MODEL_SCOPED_SIGNALS.test(message);
}

/**
 * Doom-loop-style terminal status for silent delegation failures (produced a
 * result, but the result failed verification). Thrown only while the
 * experimental abort flag is ON; aborts the fallback chain without replaying
 * the remaining candidates.
 */
export class DelegationSilentFailureError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly silentReason: string;
  constructor(provider: string, model: string, silentReason: string) {
    super(
      `delegation: silent failure on ${provider}/${model}: ${silentReason} — aborting fallback chain ` +
        `(agents.defaults.experimental.delegationSilentFailureAbort is ON)`,
    );
    this.name = "DelegationSilentFailureError";
    this.provider = provider;
    this.model = model;
    this.silentReason = silentReason;
  }
}

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
  /**
   * Override for the silent-failure abort policy. Defaults to
   * `cfg.agents.defaults.experimental.delegationSilentFailureAbort`.
   */
  abortOnSilentFailure?: boolean | undefined;
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
/**
 * Resolve the silent-failure abort policy: explicit param override wins, else
 * the `agents.defaults.experimental.delegationSilentFailureAbort` config flag
 * (default OFF — the always-extend fallback chain stays the default behavior).
 */
export function resolveAbortOnSilentFailure(params: {
  cfg: OpenClawConfig | undefined;
  override?: boolean | undefined;
}): boolean {
  return (
    params.override ??
    params.cfg?.agents?.defaults?.experimental?.delegationSilentFailureAbort === true
  );
}

export async function runDelegation<T>(
  params: RunDelegationParams<T>,
): Promise<RunDelegationResult<T>> {
  const fallbacksOverride = (params.fallbacks ?? []).map((c) => `${c.provider}/${c.model}`);
  const abortOnSilent = resolveAbortOnSilentFailure({
    cfg: params.cfg,
    override: params.abortOnSilentFailure,
  });
  // Persistent (auth/4xx/schema) failures poison the provider for this run —
  // its remaining models are skipped without an API call.
  const persistentFailedProviders = new Set<string>();

  const outcome = await runWithModelFallback<T>({
    cfg: params.cfg,
    provider: params.primary.provider,
    model: params.primary.model,
    fallbacksOverride,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    abortSignal: params.abortSignal,
    // A silent failure must not burn the remaining chain when the abort flag
    // is ON — the attempt already "succeeded", replaying it elsewhere just
    // produces more duds. Returning false here makes the engine rethrow.
    canFallbackAfterError: ({ error }) => !(error instanceof DelegationSilentFailureError),
    classifyResult: ({ result }) => {
      const reason = params.unusableReason?.(result);
      return reason ? { message: reason, reason: "empty_response" } : null;
    },
    run: async (providerId, model) => {
      if (persistentFailedProviders.has(providerId)) {
        throw new Error(
          `delegation: provider '${providerId}' failed persistently this run; skipping to next provider`,
        );
      }
      const client = await resolveDelegationClient(
        providerId,
        params.cfg,
        params.resolveApiKeyForProvider,
      );
      if (!client) {
        // Unsupported provider or no key — advance the chain.
        recordProviderError(providerId, { failureClass: "persistent" });
        throw new Error(
          `delegation: provider '${providerId}' is unavailable (no key or unsupported); advancing fallback`,
        );
      }
      const startTime = Date.now();
      try {
        const result = await params.run(client, model, providerId);
        const silentReason = params.unusableReason?.(result);
        if (silentReason !== undefined) {
          // Silent failure: record the heaviest penalty class regardless of
          // policy — a dud output is a provider-quality signal even when the
          // chain still advances on it.
          recordProviderError(providerId, { failureClass: "silent" });
          if (abortOnSilent) {
            throw new DelegationSilentFailureError(providerId, model, silentReason);
          }
        } else {
          recordProviderLatency(providerId, Date.now() - startTime);
        }
        return result;
      } catch (err) {
        if (err instanceof DelegationSilentFailureError) {
          throw err;
        }
        const failureClass = classifyDelegationError(err);
        recordProviderError(providerId, { failureClass });
        if (failureClass === "persistent" && !isModelScopedFailure(err)) {
          persistentFailedProviders.add(providerId);
        }
        throw err;
      }
    },
  });

  return { result: outcome.result, provider: outcome.provider, model: outcome.model };
}
