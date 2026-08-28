/**
 * Shared run helpers for retry limits, model reporting, and final text.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { generateSecureToken } from "../../../infra/secure-random.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { extractAssistantTextForPhase } from "../../../shared/chat-message-content.js";
import { resolveAgentConfig } from "../../agent-scope-config.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import { extractAssistantVisibleText } from "../../embedded-agent-utils.js";
import {
  deriveContextPromptTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type ContextUsage,
  type NormalizedUsage,
} from "../../usage.js";
import type { EmbeddedAgentMeta } from "../types.js";
import { toNormalizedUsage, type UsageAccumulator } from "../usage-accumulator.js";

type UsageSnapshot = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextUsage?: ContextUsage;
  total?: number;
};

export type RuntimeAuthState = {
  generation: number;
  sourceApiKey: string;
  authMode: string;
  profileId?: string;
  expiresAt?: number;
  refreshTimer?: ReturnType<typeof setTimeout>;
  refreshInFlight?: Promise<void>;
};

export const RUNTIME_AUTH_REFRESH_MARGIN_MS = 5 * 60 * 1000;
export const RUNTIME_AUTH_REFRESH_RETRY_MS = 60 * 1000;
export const RUNTIME_AUTH_REFRESH_MIN_DELAY_MS = 5 * 1000;

const DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS = 0;
const DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS = 1;
const DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS = 1;

// Same-model in-place rate_limit retry: provider RPM caps reset on a
// minute scale, so wait out the current provider/model window before spending
// a profile rotation or model failover.
export const MAX_SAME_MODEL_RATE_LIMIT_RETRIES = 3;
// Linear step: retriesSoFar=0 -> 10s, 1 -> 20s, 2 -> 30s. Total wait across the
// 3-retry budget is 60s, roughly one RPM window.
const SAME_MODEL_RATE_LIMIT_BACKOFF_STEP_MS = 10_000;
const SAME_MODEL_RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

// Fork: auth.cooldowns.* config keys can override the failover budgets.
export function resolveOverloadFailoverBackoffMs(cfg?: OpenClawConfig): number {
  return cfg?.auth?.cooldowns?.overloadedBackoffMs ?? DEFAULT_OVERLOAD_FAILOVER_BACKOFF_MS;
}

export function resolveOverloadProfileRotationLimit(cfg?: OpenClawConfig): number {
  return cfg?.auth?.cooldowns?.overloadedProfileRotations ?? DEFAULT_MAX_OVERLOAD_PROFILE_ROTATIONS;
}

export function resolveRateLimitProfileRotationLimit(cfg?: OpenClawConfig): number {
  return (
    cfg?.auth?.cooldowns?.rateLimitedProfileRotations ?? DEFAULT_MAX_RATE_LIMIT_PROFILE_ROTATIONS
  );
}

/**
 * Backoff before the next same-model rate_limit retry, given how many such
 * retries already happened. Linear and deterministic (no jitter) so RPM
 * windows clear predictably and tests can assert exact values.
 */
export function resolveSameModelRateLimitRetryDelayMs(params: {
  retriesSoFar: number;
  retryAfterSeconds?: number;
}): number {
  const backoffDelayMs =
    SAME_MODEL_RATE_LIMIT_BACKOFF_STEP_MS * (Math.max(0, params.retriesSoFar) + 1);
  const backoffMs = Math.min(SAME_MODEL_RATE_LIMIT_MAX_BACKOFF_MS, backoffDelayMs);
  const retryAfterMs = Number.isFinite(params.retryAfterSeconds)
    ? Math.ceil(Math.max(0, params.retryAfterSeconds ?? 0) * 1000)
    : 0;
  return Math.max(backoffMs, Math.min(SAME_MODEL_RATE_LIMIT_MAX_BACKOFF_MS, retryAfterMs));
}

export function resolveNextSameModelRateLimitRetryCount(params: {
  retriesSoFar: number;
  retriedSameModelRateLimit: boolean;
}): number {
  return params.retriedSameModelRateLimit ? Math.max(0, params.retriesSoFar) + 1 : 0;
}

// Same-model transient retry: provider 5xx, dropped connections, and mid-stream
// errors are frequently momentary. Re-issue the same request a couple of times
// with short exponential backoff before spending a profile rotation or model
// fallback, so a single transient provider blip does not surface
// "LLM request failed" to the user. Bounded so a hard-down provider still fails
// fast instead of stalling the turn.
export const MAX_SAME_MODEL_TRANSIENT_RETRIES = 2;
const SAME_MODEL_TRANSIENT_BACKOFF_BASE_MS = 500;
const SAME_MODEL_TRANSIENT_BACKOFF_MAX_MS = 4_000;

// Failover reasons that represent a transient provider/transport blip without a
// dedicated same-model retry path: rate_limit/overloaded own their escalation,
// auth/billing/format/model_not_found are terminal, and watchdog timeouts are
// gated by the caller. Pair this with isTransientProviderOperationError so the
// vague "unknown"-class reasons only retry when the raw error text actually
// looks transient (5xx/network), never on deterministic 4xx failures.
const TRANSIENT_RETRY_FAILOVER_REASONS: ReadonlySet<FailoverReason> = new Set([
  "server_error",
  "timeout",
  "unclassified",
  "no_error_details",
]);

export function isTransientRetryFailoverReason(reason: FailoverReason | null): boolean {
  return reason !== null && TRANSIENT_RETRY_FAILOVER_REASONS.has(reason);
}

// Exponential backoff for same-model transient retries: 500ms, 1s (capped 4s).
export function resolveSameModelTransientRetryDelayMs(retriesSoFar: number): number {
  const delay = SAME_MODEL_TRANSIENT_BACKOFF_BASE_MS * 2 ** Math.max(0, retriesSoFar);
  return Math.min(SAME_MODEL_TRANSIENT_BACKOFF_MAX_MS, delay);
}

const ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL = "ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL";
const ANTHROPIC_MAGIC_STRING_REPLACEMENT = "ANTHROPIC MAGIC STRING TRIGGER REFUSAL (redacted)";

// Avoid Anthropic's refusal test token poisoning session transcripts.
// Fork: exported because the fork run loop applies the scrub directly.
export function scrubAnthropicRefusalMagic(prompt: string): string {
  if (!prompt.includes(ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL)) {
    return prompt;
  }
  return prompt.replaceAll(
    ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL,
    ANTHROPIC_MAGIC_STRING_REPLACEMENT,
  );
}

/** Anthropic's transport interprets this marker even for native-owned attempts. */
export function resolveEmbeddedAttemptBasePrompt(params: {
  provider: string;
  prompt: string;
}): string {
  if (params.provider !== "anthropic") {
    return params.prompt;
  }
  return scrubAnthropicRefusalMagic(params.prompt);
}

export function createRunRecoveryDiagId(): string {
  return `ovf-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

const BASE_RUN_RETRY_ITERATIONS = 24;
const RUN_RETRY_ITERATIONS_PER_PROFILE = 8;
const MIN_RUN_RETRY_ITERATIONS = 32;
const MAX_RUN_RETRY_ITERATIONS = 160;

// This per-run bound multiplies whole-turn overload replays in
// auto-reply/reply/agent-runner-error-handler.ts; keep their product test aligned.
// Defensive guard for the outer run loop across all retry branches.
// Fork: agents.defaults/list runRetries config can tune the budget per agent.
export function resolveMaxRunRetryIterations(
  profileCandidateCount: number,
  cfg?: OpenClawConfig,
  agentId?: string,
): number {
  const configRetries =
    (cfg && agentId ? resolveAgentConfig(cfg, agentId)?.runRetries : undefined) ??
    cfg?.agents?.defaults?.runRetries;

  const base = Math.max(1, configRetries?.base ?? BASE_RUN_RETRY_ITERATIONS);
  const perProfile = Math.max(0, configRetries?.perProfile ?? RUN_RETRY_ITERATIONS_PER_PROFILE);
  const minLimit = Math.max(1, configRetries?.min ?? MIN_RUN_RETRY_ITERATIONS);
  const maxLimit = Math.max(minLimit, configRetries?.max ?? MAX_RUN_RETRY_ITERATIONS);

  const scaled = base + Math.max(1, profileCandidateCount) * perProfile;
  return Math.min(maxLimit, Math.max(minLimit, scaled));
}

export function resolveActiveErrorContext(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string };
}): {
  provider: string;
  model: string;
} {
  return resolveReportedModelRef(params);
}

export function isAssistantForModelRef(
  assistant: { provider?: string; model?: string } | undefined,
  ref: { provider: string; model: string },
): boolean {
  if (!assistant) {
    return false;
  }
  const resolved = resolveReportedModelRef({
    ...ref,
    assistant,
  });
  return resolved.provider === ref.provider && resolved.model === ref.model;
}

function isEmbeddedHarnessProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === "openclaw";
}

export function resolveReportedModelRef(params: {
  provider: string;
  model: string;
  assistant?: { provider?: string; model?: string } | null;
}): {
  provider: string;
  model: string;
} {
  const assistantProvider = params.assistant?.provider?.trim();
  const assistantModel = params.assistant?.model?.trim();
  if (!assistantProvider) {
    return {
      provider: params.provider,
      model: assistantModel || params.model,
    };
  }
  if (isEmbeddedHarnessProvider(assistantProvider)) {
    return {
      provider: params.provider,
      model: params.model,
    };
  }
  return {
    provider: assistantProvider,
    model: assistantModel || params.model,
  };
}

export function resolveLatestCallUsage(params: {
  currentAttemptCandidates: readonly (NormalizedUsage | undefined)[];
  carriedUsage: NormalizedUsage | undefined;
  transcriptFallback: NormalizedUsage | undefined;
}): {
  currentAttempt: NormalizedUsage | undefined;
  latest: NormalizedUsage | undefined;
} {
  const currentAttempt = params.currentAttemptCandidates.find(hasNonzeroUsage);
  const carriedUsage = hasNonzeroUsage(params.carriedUsage) ? params.carriedUsage : undefined;
  const transcriptFallback = hasNonzeroUsage(params.transcriptFallback)
    ? params.transcriptFallback
    : undefined;
  return {
    currentAttempt,
    latest: currentAttempt ?? carriedUsage ?? transcriptFallback,
  };
}

export function normalizeAssistantUsageForContext(
  assistant: { api?: string; usage?: unknown } | null | undefined,
): NormalizedUsage | undefined {
  if (
    assistant?.api === "cli" &&
    assistant.usage &&
    typeof assistant.usage === "object" &&
    !Array.isArray(assistant.usage) &&
    (assistant.usage as { contextUsage?: unknown }).contextUsage === undefined
  ) {
    return { contextUsage: { state: "unavailable" } };
  }
  return normalizeUsage(assistant?.usage as UsageSnapshot | undefined);
}

export function buildUsageAgentMetaFields(params: {
  usageAccumulator: UsageAccumulator;
  latestUsage?: UsageSnapshot | null;
  lastRunPromptUsage: UsageSnapshot | undefined;
  /** Fork: last turn's total wins over the accumulator so a resumed or compacted
   * run reports the turn the user just saw, not the whole-session sum. */
  lastTurnTotal?: number;
}): Pick<EmbeddedAgentMeta, "usage" | "lastCallUsage" | "promptTokens"> {
  const usage = toNormalizedUsage(params.usageAccumulator);
  if (usage && params.lastTurnTotal && params.lastTurnTotal > 0) {
    usage.total = params.lastTurnTotal;
  }
  const latestUsage = normalizeUsage(params.latestUsage as never);
  const lastCallUsage = hasNonzeroUsage(latestUsage)
    ? latestUsage
    : hasNonzeroUsage(params.lastRunPromptUsage)
      ? params.lastRunPromptUsage
      : undefined;
  const promptTokens = deriveContextPromptTokens({
    lastCallUsage,
  });
  return {
    usage,
    lastCallUsage,
    promptTokens,
  };
}

/**
 * Build agentMeta for error return paths, preserving accumulated usage so that
 * session totalTokens reflects the actual context size rather than going stale.
 * Without this, error returns omit usage and the session keeps whatever
 * totalTokens was set by the previous successful run.
 */
export function buildErrorAgentMeta(params: {
  sessionId: string;
  sessionFile?: string;
  provider: string;
  model: string;
  credentialSource?: EmbeddedAgentMeta["credentialSource"];
  contextTokens?: number;
  usageAccumulator: UsageAccumulator;
  lastRunPromptUsage: UsageSnapshot | undefined;
  currentAttemptAssistant?: { api?: string; usage?: unknown } | null;
  lastTurnTotal?: number;
}): EmbeddedAgentMeta {
  const usageMeta = buildUsageAgentMetaFields({
    usageAccumulator: params.usageAccumulator,
    latestUsage: normalizeAssistantUsageForContext(params.currentAttemptAssistant),
    lastRunPromptUsage: params.lastRunPromptUsage,
    lastTurnTotal: params.lastTurnTotal,
  });
  return {
    sessionId: params.sessionId,
    ...(params.sessionFile ? { sessionFile: params.sessionFile } : {}),
    provider: params.provider,
    model: params.model,
    ...(params.credentialSource ? { credentialSource: params.credentialSource } : {}),
    ...(params.contextTokens ? { contextTokens: params.contextTokens } : {}),
    ...(params.contextTokens ? { contextTokensSource: "resolved" as const } : {}),
    ...(usageMeta.usage ? { usage: usageMeta.usage } : {}),
    ...(usageMeta.lastCallUsage ? { lastCallUsage: usageMeta.lastCallUsage } : {}),
    ...(usageMeta.promptTokens ? { promptTokens: usageMeta.promptTokens } : {}),
  };
}

export function resolveFinalAssistantVisibleText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const visibleText = extractAssistantVisibleText(lastAssistant).trim();
  return visibleText || undefined;
}

export function resolveFinalAssistantRawText(
  lastAssistant: AssistantMessage | undefined,
): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  const finalAnswerText = extractAssistantTextForPhase(lastAssistant, { phase: "final_answer" });
  const rawText = (finalAnswerText ?? extractAssistantTextForPhase(lastAssistant) ?? "").trim();
  return rawText || undefined;
}
