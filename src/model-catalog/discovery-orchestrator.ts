/**
 * Orchestrates one provider's model discovery: resolve endpoint + credentials,
 * fetch the live /models list, reconcile it into the persisted snapshot.
 *
 * Reused by the `openclaw models refresh` CLI, the gateway periodic refresh, the
 * onboard post-auth hook, and the doctor deprecation check. Core owns this
 * generic loop; provider-specific auth/baseUrl come from config + the shared
 * secret resolver (`resolveUsableCustomProviderApiKey`).
 */
import type { DatabaseSync } from "node:sqlite";
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { upsertProbedServedModels } from "./discovered-store.js";
import { fetchAnthropicMessagesModels, fetchOpenAiCompatibleModels } from "./model-discovery.js";
import { type ReconcileResult, reconcileProviderModels } from "./reconcile.js";
import { probeProtocolForApi, probeServedModels } from "./served-model-probe.js";

/** Resolved network target for a provider's /models endpoint, with wire protocol. */
export type DiscoveryEndpoint = { baseUrl: string; apiKey: string; api?: string };

/** Per-provider discovery outcome surfaced to CLI/doctor/log. */
export type ProviderDiscoveryReport = {
  provider: string;
  probedAdded?: string[];
} & ReconcileResult;

/** Cap on probe completions per provider per refresh, to bound latency/calls. */
const MAX_PROBE_CANDIDATES = 24;

/** Candidate ids to probe for served-but-unlisted models: the curated config
 * catalog ids when present, else the live /models ids. */
function collectProbeCandidateIds(
  cfg: OpenClawConfig,
  provider: string,
  fetchResult: Awaited<ReturnType<typeof fetchOpenAiCompatibleModels>>,
): string[] {
  const configIds = (cfg.models?.providers?.[provider]?.models ?? [])
    .map((m) => m.id?.trim())
    .filter((id): id is string => Boolean(id));
  const liveIds = fetchResult.ok ? fetchResult.models.map((m) => m.modelId) : [];
  const source = configIds.length > 0 ? configIds : liveIds;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of source) {
    const key = id.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(id.trim());
    if (out.length >= MAX_PROBE_CANDIDATES) {
      break;
    }
  }
  return out;
}

/**
 * Resolves the baseUrl + raw API key for a configured provider, or null when the
 * provider has no usable endpoint/credentials (e.g. OAuth-only or unconfigured).
 * Credential resolution uses the same env/config/profile path as live calls.
 */
export async function resolveDiscoveryEndpoint(
  cfg: OpenClawConfig,
  provider: string,
): Promise<DiscoveryEndpoint | null> {
  const providerId = normalizeModelCatalogProviderId(provider);
  const providerConfig = cfg.models?.providers?.[providerId];
  const baseUrl = providerConfig?.baseUrl?.trim();
  if (!baseUrl) {
    return null;
  }
  const api = providerConfig?.api;
  try {
    const resolved = await resolveApiKeyForProviderCore({ provider: providerId, cfg });
    const apiKey = resolved.apiKey?.trim();
    if (!apiKey) {
      return null;
    }
    return { baseUrl, apiKey, ...(api ? { api } : {}) };
  } catch {
    // resolveApiKeyForProviderCore throws when no credential is found; treat as skip.
    return null;
  }
}

/** Lists configured providers opted into live discovery (`discovery: "refreshable"`). */
export function listRefreshableProviders(cfg: OpenClawConfig): string[] {
  const providers = cfg.models?.providers ?? {};
  return Object.entries(providers)
    .filter(([, providerConfig]) => providerConfig?.discovery === "refreshable")
    .map(([providerId]) => normalizeModelCatalogProviderId(providerId))
    .toSorted();
}

/** Runs discovery + reconcile for one provider. Skips cleanly when unconfigured.
 * With `probeServed`, also harvests served-but-unlisted models via 1-token probes. */
export async function runProviderModelDiscovery(params: {
  provider: string;
  cfg: OpenClawConfig;
  nowMs: number;
  db?: DatabaseSync;
  fetchFn?: typeof fetch;
  probeServed?: boolean;
  resolveEndpoint?: (
    provider: string,
  ) => DiscoveryEndpoint | null | Promise<DiscoveryEndpoint | null>;
}): Promise<ProviderDiscoveryReport> {
  const provider = normalizeModelCatalogProviderId(params.provider);
  const resolveEndpoint =
    params.resolveEndpoint ?? ((p: string) => resolveDiscoveryEndpoint(params.cfg, p));
  const endpoint = await resolveEndpoint(provider);
  if (!endpoint) {
    return { provider, ok: false, reason: "no configured baseUrl/credentials" };
  }
  const isAnthropic = endpoint.api === "anthropic-messages";
  // Ollama serves an OpenAI-compatible catalog at GET /v1/models while its native
  // protocol lives under /api/*. Because `api: "ollama"` speaks that native
  // protocol for completions, the configured baseUrl is the bare host, so
  // discovery has to add the prefix itself. Without it the request went to
  // <host>/models, returned 404, and a local install with four models pulled
  // reported the single model declared in config.
  const openAiModelsBaseUrl =
    endpoint.api === "ollama"
      ? `${endpoint.baseUrl.trim().replace(/\/+$/u, "")}/v1`
      : endpoint.baseUrl;
  const fetchResult = isAnthropic
    ? await fetchAnthropicMessagesModels({
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        fetchFn: params.fetchFn,
      })
    : await fetchOpenAiCompatibleModels({
        baseUrl: openAiModelsBaseUrl,
        apiKey: endpoint.apiKey,
        fetchFn: params.fetchFn,
      });

  // Probe served ids (network) before opening the write transaction. Served ids
  // that the /models list omits get recorded as source="probe".
  const liveSet = new Set(
    (fetchResult.ok ? fetchResult.models.map((m) => m.modelId) : []).map((id) => id.toLowerCase()),
  );
  const newServed: string[] = [];
  // served (lowercased) -> original-casing served id, for persistence.
  const servedCasing = new Map<string, string>();
  // served (lowercased) -> requested ids that were silently served as it (upgrades).
  const upgradeFromByServed = new Map<string, Set<string>>();
  if (params.probeServed) {
    const observations = await probeServedModels({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      modelIds: collectProbeCandidateIds(params.cfg, provider, fetchResult),
      protocol: probeProtocolForApi(endpoint.api),
      ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
    });
    for (const { requested, served } of observations) {
      const key = served.toLowerCase();
      if (!key) {
        continue;
      }
      if (!servedCasing.has(key)) {
        servedCasing.set(key, served);
      }
      if (!liveSet.has(key) && !newServed.some((id) => id.toLowerCase() === key)) {
        newServed.push(served);
      }
      if (requested.toLowerCase() !== key) {
        // A requested id that the provider answered with a different served id =
        // a silent upgrade (e.g. glm-5.1 served as glm-5.2, or the stable alias
        // deepseek-v4-flash answered with the snapshot id DeepSeek-V4-Flash-0731).
        // Record the link even when /models also lists the served id — the
        // snapshot identity must reach doctor --fix as a distinguishable ID.
        const from = upgradeFromByServed.get(key) ?? new Set<string>();
        from.add(requested);
        upgradeFromByServed.set(key, from);
      }
    }
  }

  const apply = (db: DatabaseSync): ReconcileResult => {
    const result = reconcileProviderModels(db, { provider, fetchResult, nowMs: params.nowMs });
    // Persist probe observations: unlisted served ids become probe rows, and
    // alias→served upgrade links are stamped onto the served row even when that
    // row came from /models (source stays "models"; raw_json carries the link,
    // which listSilentUpgrades reads regardless of source).
    const upserts = [...servedCasing.entries()]
      .filter(([key]) => !liveSet.has(key) || upgradeFromByServed.has(key))
      .map(([key, id]) => {
        const upgradedFrom = [...(upgradeFromByServed.get(key) ?? [])];
        return {
          modelId: id,
          raw: { id, via: "probe", ...(upgradedFrom.length > 0 ? { upgradedFrom } : {}) },
        };
      });
    if (upserts.length > 0) {
      upsertProbedServedModels(db, provider, upserts, params.nowMs);
    }
    return result;
  };
  const result = params.db
    ? apply(params.db)
    : runOpenClawStateWriteTransaction((database) => apply(database.db));
  return { provider, ...result, ...(newServed.length > 0 ? { probedAdded: newServed } : {}) };
}

/** Runs discovery for every configured refreshable provider. */
export async function runAllRefreshableProviderDiscovery(params: {
  cfg: OpenClawConfig;
  nowMs: number;
  db?: DatabaseSync;
  fetchFn?: typeof fetch;
  probeServed?: boolean;
}): Promise<ProviderDiscoveryReport[]> {
  const providers = listRefreshableProviders(params.cfg);
  const reports: ProviderDiscoveryReport[] = [];
  for (const provider of providers) {
    reports.push(await runProviderModelDiscovery({ ...params, provider }));
  }
  return reports;
}
