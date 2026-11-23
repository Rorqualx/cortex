/**
 * Served-model probe: some providers serve model ids their `/models` list omits
 * (an unlisted variant, or a silent upgrade — e.g. requesting glm-5.1 returns
 * `model: glm-5.2`). A 1-token chat completion reports the actually-served id in
 * the response `model` field; harvesting it lets discovery pick up models the
 * `/models` list never advertises.
 *
 * Best-effort and never throws: a probe failure for one id is skipped. Used by
 * the discovery orchestrator after the `/models` reconcile.
 */
import { isRecord } from "../utils.js";

/** One probe result: the requested id and the model id the provider actually served. */
export type ServedModelObservation = {
  requested: string;
  served: string;
  /** QW5 (2026-11-22, report-only): tolerant identity classification of the
   * served id against the requested id — "match" (same identity, cosmetic
   * drift aside) or "silent-swap" (a different model answered the name). */
  identityClass?: Exclude<ServedIdentityClass, "unknown">;
};

/**
 * Served-identity classification (QW5, 2026-11-22 — DeepSeek V4-flash→
 * V4.1-Flash-1017 class of silent swaps). Report-only first: consumers flag,
 * auto-repair comes later once tolerances prove out in the wild.
 *
 * - "match" — served id IS the pinned identity (tolerant of case, separators,
 *   provider prefixes, @variants, and date/alias decorations);
 * - "silent-swap" — the name resolved but a DIFFERENT model identity answered
 *   (deepseek-v4-flash → deepseek-v4.1-flash-1017);
 * - "unknown" — no served id observed.
 */
export type ServedIdentityClass = "match" | "silent-swap" | "unknown";

/**
 * Tolerant identity normalization for provider↔pin comparison: drop provider
 * prefixes ("zai/glm-5.2"), @variants ("glm-5.2@free"), date/alias decorations
 * ("-2024-08-06", "-0731"-style MMDD snapshots, "-latest"), then fold case +
 * separators so cosmetic drift never flags. Version digits are deliberately
 * NOT folded — "v4" vs "v4.1" stays a difference.
 */
export function normalizeServedIdentity(id: string): string {
  let s = id.trim().toLowerCase();
  const slash = s.lastIndexOf("/");
  if (slash >= 0) {
    s = s.slice(slash + 1);
  }
  s = s.split("@")[0] ?? s;
  // Up to two passes: decorations can stack ("-2024-08-06-latest").
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/-(?:latest|preview|stable)$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}$/, "")
      .replace(/-\d{8}$/, "")
      .replace(/-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/, "");
  }
  return s.replace(/[\s_.-]+/g, "");
}

/** Classify a served id against the pinned/requested id (see ServedIdentityClass). */
export function classifyServedIdentity(params: {
  pinned: string;
  served: string | null | undefined;
}): ServedIdentityClass {
  if (!params.served) {
    return "unknown";
  }
  const a = normalizeServedIdentity(params.pinned);
  const b = normalizeServedIdentity(params.served);
  if (!a || !b) {
    return "unknown";
  }
  return a === b ? "match" : "silent-swap";
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const ANTHROPIC_VERSION = "2023-06-01";

/** Provider wire protocol used to shape the probe request. */
export type ProbeProtocol = "openai" | "anthropic";

/** Maps a provider `api` value to the probe protocol. */
export function probeProtocolForApi(api: string | undefined): ProbeProtocol {
  return api === "anthropic-messages" ? "anthropic" : "openai";
}

function buildCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}/chat/completions`;
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}/v1/messages`;
}

function readServedModel(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const served = typeof payload.model === "string" ? payload.model.trim() : "";
  return served || null;
}

/**
 * Probes one model id and returns the served model id, or null on any failure
 * (transport, non-200, missing `model` field). Never throws.
 */
function buildProbeRequest(
  protocol: ProbeProtocol,
  baseUrl: string,
  apiKey: string,
  modelId: string,
): { url: string; init: RequestInit } {
  if (protocol === "anthropic") {
    return {
      url: buildAnthropicMessagesUrl(baseUrl),
      init: {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    };
  }
  return {
    url: buildCompletionsUrl(baseUrl),
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
    },
  };
}

export async function probeServedModel(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  protocol?: ProbeProtocol;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<string | null> {
  const baseUrl = params.baseUrl.trim();
  const apiKey = params.apiKey.trim();
  const modelId = params.modelId.trim();
  if (!baseUrl || !apiKey || !modelId) {
    return null;
  }
  const fetchFn = params.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  );
  try {
    const { url, init } = buildProbeRequest(params.protocol ?? "openai", baseUrl, apiKey, modelId);
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return readServedModel((await response.json()) as unknown);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probes each candidate id sequentially (to stay gentle on provider rate limits)
 * and returns the observations where the served id is known. Caller decides which
 * served ids are new and records them.
 */
export async function probeServedModels(params: {
  baseUrl: string;
  apiKey: string;
  modelIds: readonly string[];
  protocol?: ProbeProtocol;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<ServedModelObservation[]> {
  const observations: ServedModelObservation[] = [];
  const seen = new Set<string>();
  for (const rawId of params.modelIds) {
    const requested = rawId.trim();
    if (!requested || seen.has(requested.toLowerCase())) {
      continue;
    }
    seen.add(requested.toLowerCase());
    const served = await probeServedModel({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      modelId: requested,
      ...(params.protocol ? { protocol: params.protocol } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
    });
    if (served) {
      observations.push({
        requested,
        served,
        // QW5 report-only: tolerant classification beside the raw pair —
        // cosmetic drift stays "match", a true identity change flags.
        identityClass:
          classifyServedIdentity({ pinned: requested, served }) === "match"
            ? "match"
            : "silent-swap",
      });
    }
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Empty-thinking audit probe (openclaw-analysis-2026-10-14, QW1)
// ---------------------------------------------------------------------------
// Some hybrid-reasoning models cannot serve a thinking-free completion, which
// makes them wasteful for cheap lanes (heartbeats, cron scans). This audit
// probe sends a tiny request with thinking explicitly disabled per protocol
// and counts the reasoning tokens that still came back. Advisory metadata for
// discovery (raw payload bit); routing gates on it come later.

const NO_THINK_PROBE_MAX_TOKENS = 64;

/**
 * Count reasoning/thinking tokens in a probe response payload; null when the
 * payload carries no usable signal. Checks OpenAI-style
 * `usage.reasoning_tokens` / `usage.completion_tokens_details.reasoning_tokens`
 * first, then Anthropic-style `content` blocks of type "thinking" (block count
 * as a lower bound — a disabled-thinking response has none).
 */
export function countReasoningTokens(payload: unknown): number | null {
  if (!isRecord(payload)) {
    return null;
  }
  const usage = isRecord(payload.usage) ? payload.usage : null;
  if (usage) {
    if (typeof usage.reasoning_tokens === "number") {
      return usage.reasoning_tokens;
    }
    const details = isRecord(usage.completion_tokens_details)
      ? usage.completion_tokens_details
      : null;
    if (details && typeof details.reasoning_tokens === "number") {
      return details.reasoning_tokens;
    }
  }
  if (Array.isArray(payload.content)) {
    let thinkingBlocks = 0;
    for (const block of payload.content) {
      if (isRecord(block) && block.type === "thinking") {
        thinkingBlocks++;
      }
    }
    return thinkingBlocks;
  }
  return null;
}

function buildNoThinkProbeRequest(
  protocol: ProbeProtocol,
  baseUrl: string,
  apiKey: string,
  modelId: string,
): { url: string; init: RequestInit } {
  if (protocol === "anthropic") {
    return {
      url: buildAnthropicMessagesUrl(baseUrl),
      init: {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: NO_THINK_PROBE_MAX_TOKENS,
          thinking: { type: "disabled" },
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    };
  }
  return {
    url: buildCompletionsUrl(baseUrl),
    init: {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: NO_THINK_PROBE_MAX_TOKENS,
        reasoning_effort: "none",
      }),
    },
  };
}

/**
 * Probes whether a model serves a completion with thinking explicitly disabled
 * and zero reasoning tokens. Returns true (compliant), false (the model still
 * burned reasoning tokens), or null (unknown — transport error or non-200; some
 * providers reject the disable parameter itself, which must not be recorded as
 * non-compliance). Never throws.
 */
export async function probeNoThinkCompliance(params: {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  protocol?: ProbeProtocol;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<boolean | null> {
  const baseUrl = params.baseUrl.trim();
  const apiKey = params.apiKey.trim();
  const modelId = params.modelId.trim();
  if (!baseUrl || !apiKey || !modelId) {
    return null;
  }
  const fetchFn = params.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  );
  try {
    const { url, init } = buildNoThinkProbeRequest(
      params.protocol ?? "openai",
      baseUrl,
      apiKey,
      modelId,
    );
    const response = await fetchFn(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    const tokens = countReasoningTokens((await response.json()) as unknown);
    return tokens === null ? null : tokens === 0;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
