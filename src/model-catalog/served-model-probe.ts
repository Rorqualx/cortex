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
export type ServedModelObservation = { requested: string; served: string };

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
      observations.push({ requested, served });
    }
  }
  return observations;
}
