/**
 * Live model discovery: fetches a provider's current model list from its
 * OpenAI-compatible `/models` endpoint.
 *
 * The endpoint is a presence/absence signal only — z.ai/deepseek/openai return
 * bare `{ id, object, created, owned_by }` with no metadata — so this maps each
 * entry to a minimal `DiscoveredModelInput`. Rich metadata (cost, context,
 * reasoning) keeps coming from the bundled manifest at catalog-merge time.
 *
 * A failed or empty fetch returns `{ ok: false }` so callers can guard: an
 * outage or permissions gap must never be mistaken for "every model is gone."
 */
import { isRecord } from "../utils.js";
import type { DiscoveredModelInput } from "./discovered-store.js";

/** Outcome of one provider `/models` fetch. */
export type FetchModelsResult =
  | { ok: true; models: DiscoveredModelInput[] }
  | { ok: false; error: string; status?: number };

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const ANTHROPIC_VERSION = "2023-06-01";

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}/models`;
}

function buildAnthropicModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}/v1/models`;
}

/** Normalize an upstream `created` value (seconds or ms) to milliseconds. */
function normalizeCreatedMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  // OpenAI-style `created` is unix seconds; values below ~1e12 are seconds.
  return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
}

function mapModelEntry(entry: unknown): DiscoveredModelInput | null {
  if (!isRecord(entry)) {
    return null;
  }
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!id) {
    return null;
  }
  const rawName =
    (typeof entry.display_name === "string" && entry.display_name.trim()) ||
    (typeof entry.name === "string" && entry.name.trim()) ||
    "";
  const createdRemoteMs = normalizeCreatedMs(entry.created);
  return {
    modelId: id,
    ...(rawName ? { name: rawName } : {}),
    ...(createdRemoteMs !== undefined ? { createdRemoteMs } : {}),
    raw: entry,
  };
}

/** Extracts the `data[]` model array from an OpenAI-style list response. */
function readModelList(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (isRecord(payload) && Array.isArray(payload.data)) {
    return payload.data;
  }
  return null;
}

/**
 * GET `<baseUrl>/models` and map the response to discovered model inputs.
 * Never throws — transport/parse failures resolve to `{ ok: false }`.
 */
export async function fetchOpenAiCompatibleModels(params: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchFn?: typeof fetch;
}): Promise<FetchModelsResult> {
  const baseUrl = params.baseUrl.trim();
  if (!baseUrl) {
    return { ok: false, error: "missing baseUrl" };
  }
  if (!params.apiKey.trim()) {
    return { ok: false, error: "missing apiKey" };
  }
  const fetchFn = params.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
  );
  try {
    const response = await fetchFn(buildModelsUrl(baseUrl), {
      method: "GET",
      headers: {
        authorization: `Bearer ${params.apiKey.trim()}`,
        accept: "application/json",
        ...params.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, status: response.status };
    }
    const payload = (await response.json()) as unknown;
    const list = readModelList(payload);
    if (!list) {
      return { ok: false, error: "unexpected /models response shape" };
    }
    const models = list.map(mapModelEntry).filter((m): m is DiscoveredModelInput => m !== null);
    if (models.length === 0) {
      // Treat an empty list as a non-result so reconcile never deprecates the
      // whole catalog off a degenerate response.
      return { ok: false, error: "empty model list" };
    }
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET `<baseUrl>/v1/models` for Anthropic-protocol providers (e.g. the Kimi
 * coding plan, `api: anthropic-messages`). Uses `x-api-key` + `anthropic-version`
 * and the same `data[]` mapping (Anthropic entries carry `display_name`, so the
 * model version like "K2.7 Code" is captured as the name). Never throws.
 */
export async function fetchAnthropicMessagesModels(params: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<FetchModelsResult> {
  const baseUrl = params.baseUrl.trim();
  if (!baseUrl) {
    return { ok: false, error: "missing baseUrl" };
  }
  if (!params.apiKey.trim()) {
    return { ok: false, error: "missing apiKey" };
  }
  const fetchFn = params.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
  );
  try {
    const response = await fetchFn(buildAnthropicModelsUrl(baseUrl), {
      method: "GET",
      headers: {
        "x-api-key": params.apiKey.trim(),
        "anthropic-version": ANTHROPIC_VERSION,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}`, status: response.status };
    }
    const list = readModelList((await response.json()) as unknown);
    if (!list) {
      return { ok: false, error: "unexpected /v1/models response shape" };
    }
    const models = list.map(mapModelEntry).filter((m): m is DiscoveredModelInput => m !== null);
    if (models.length === 0) {
      return { ok: false, error: "empty model list" };
    }
    return { ok: true, models };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
