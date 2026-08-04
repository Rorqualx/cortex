// Control UI controller for the Model Providers tab.
//
// The fork already carried the provider data layer (model-providers/data.ts) and
// a full 533-line view, but nothing wired them into navigation, so every
// /settings/model-providers URL fell through to /chat and the only way to add a
// provider key through the UI was the raw config schema editor under Agent
// Defaults > Models. This is the missing container, deliberately scoped to the
// job people actually open that page for: pick a provider, paste a key, test it.
import {
  buildModelProviderCards,
  buildUnconfiguredProviderOptions,
  readModelProviderConfig,
  type ModelProviderCard,
  type ProviderOption,
} from "../model-providers/data.ts";
import { buildProviderApiKeyPatch } from "../model-providers/mutations.ts";
import type { ModelAuthStatusResult, ModelCatalogEntry } from "../types.ts";

export type ModelProvidersState = {
  loading: boolean;
  error: string | null;
  cards: ModelProviderCard[];
  /** Providers that support an API key and are not configured yet — the dropdown. */
  options: ProviderOption[];
  selectedProvider: string;
  keyDraft: string;
  busy: boolean;
  notice: string | null;
  /** Per-provider probe outcome, keyed by provider id. */
  probe: Record<string, { ok: boolean; text: string }>;
};

export function createModelProvidersState(): ModelProvidersState {
  return {
    loading: false,
    error: null,
    cards: [],
    options: [],
    selectedProvider: "",
    keyDraft: "",
    busy: false,
    notice: null,
    probe: {},
  };
}

type ProvidersHost = {
  client?: { request: <T>(method: string, params?: unknown) => Promise<T> } | null;
  connected?: boolean;
  // `hash` is nullable on ConfigSnapshot; saveProviderApiKey refuses to patch
  // without one rather than sending an unguarded write.
  configSnapshot?: { config?: unknown; hash?: string | null } | null;
  modelProviders?: ModelProvidersState;
  requestUpdate?: () => void;
};

function stateOf(host: ProvidersHost): ModelProvidersState {
  host.modelProviders ??= createModelProvidersState();
  return host.modelProviders;
}

function configRecord(host: ProvidersHost): Record<string, unknown> | null {
  const config = host.configSnapshot?.config;
  return config && typeof config === "object" ? (config as Record<string, unknown>) : null;
}

/**
 * Loads auth status and the model catalog, then rebuilds the cards and the
 * unconfigured-provider dropdown. Safe to call repeatedly; the last call wins.
 */
export async function loadModelProviders(host: ProvidersHost): Promise<void> {
  const state = stateOf(host);
  const client = host.client;
  if (!client || !host.connected) {
    return;
  }
  state.loading = true;
  state.error = null;
  host.requestUpdate?.();
  try {
    // Two views on purpose: "configured" drives per-card model counts, "all" is
    // the catalog the unconfigured dropdown is derived from. ModelsListParamsSchema
    // is a closed object, so an unknown param is rejected outright rather than
    // ignored — an earlier `{ all: true }` here failed validation and left every
    // card reading "0 models" with an empty dropdown.
    const [authStatus, configuredCatalog, fullCatalog] = await Promise.all([
      client.request<ModelAuthStatusResult>("models.authStatus", {}),
      client
        .request<{ models?: ModelCatalogEntry[] }>("models.list", { view: "configured" })
        .catch(() => ({ models: [] as ModelCatalogEntry[] })),
      client
        .request<{ models?: ModelCatalogEntry[] }>("models.list", { view: "all" })
        .catch(() => ({ models: [] as ModelCatalogEntry[] })),
    ]);
    const models = configuredCatalog?.models ?? [];
    const allModels = fullCatalog?.models ?? [];
    const config = readModelProviderConfig(configRecord(host));
    state.cards = buildModelProviderCards({
      authStatus,
      models,
      catalogModels: allModels,
      configProviderIds: config.providerIds,
      configApiKeyProviderIds: config.apiKeyProviderIds,
      configProviderAuthModes: config.providerAuthModes,
      providerUsage: null,
      costByProvider: null,
    });
    state.options = buildUnconfiguredProviderOptions(allModels, config.providerIds);
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.loading = false;
    host.requestUpdate?.();
  }
}

/**
 * Writes `models.providers.<id>.apiKey` through config.patch.
 *
 * `reloadConfig` is required for the result to be visible: cards read api-key
 * presence out of host.configSnapshot, which config.patch does not update in
 * place. Without it the save succeeded, said so, and the row still read
 * "no API key" — a success message contradicting the screen.
 */
export async function saveProviderApiKey(
  host: ProvidersHost,
  provider: string,
  apiKey: string,
  reloadConfig?: () => Promise<unknown>,
) {
  const state = stateOf(host);
  const client = host.client;
  const baseHash = host.configSnapshot?.hash;
  if (!client || !host.connected || !provider || !apiKey.trim()) {
    return;
  }
  if (!baseHash) {
    state.error = "Config hash missing; refresh and retry.";
    host.requestUpdate?.();
    return;
  }
  state.busy = true;
  state.error = null;
  state.notice = null;
  host.requestUpdate?.();
  try {
    await client.request("config.patch", {
      baseHash,
      raw: JSON.stringify(buildProviderApiKeyPatch(provider, apiKey.trim())),
      note: `set ${provider} api key`,
    });
    state.keyDraft = "";
    state.notice = `Saved API key for ${provider}. Run a test to confirm it works.`;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  } finally {
    state.busy = false;
    host.requestUpdate?.();
    await reloadConfig?.();
    await loadModelProviders(host);
  }
}

/** Live credential check for one provider. */
export async function probeProvider(host: ProvidersHost, provider: string) {
  const state = stateOf(host);
  const client = host.client;
  if (!client || !host.connected || !provider) {
    return;
  }
  state.busy = true;
  host.requestUpdate?.();
  try {
    // ModelsProbeParamsSchema is a closed object taking a SINGULAR `provider`,
    // and the status lives at the top level of the result, not on results[0].
    // Both were guessed wrong first time; the schema is the contract.
    const result = await client.request<{
      status?: string;
      error?: string;
      latencyMs?: number;
    }>("models.probe", { provider });
    const ok = result?.status === "ok";
    const latency = typeof result?.latencyMs === "number" ? ` (${result.latencyMs}ms)` : "";
    state.probe[provider] = {
      ok,
      text: ok ? `OK${latency}` : (result?.error ?? result?.status ?? "No response"),
    };
  } catch (err) {
    state.probe[provider] = {
      ok: false,
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    state.busy = false;
    host.requestUpdate?.();
  }
}
