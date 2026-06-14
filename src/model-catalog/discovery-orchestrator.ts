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
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { upsertProbedServedModels } from "./discovered-store.js";
import { fetchOpenAiCompatibleModels } from "./model-discovery.js";
import { type ReconcileResult, reconcileProviderModels } from "./reconcile.js";
import { probeServedModels } from "./served-model-probe.js";

/** Resolved network target for a provider's /models endpoint. */
export type DiscoveryEndpoint = { baseUrl: string; apiKey: string };

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
  const baseUrl = cfg.models?.providers?.[providerId]?.baseUrl?.trim();
  if (!baseUrl) {
    return null;
  }
  try {
    const resolved = await resolveApiKeyForProvider({ provider: providerId, cfg });
    const apiKey = resolved.apiKey?.trim();
    return apiKey ? { baseUrl, apiKey } : null;
  } catch {
    // resolveApiKeyForProvider throws when no credential is found; treat as skip.
    return null;
  }
}

/** Lists configured providers opted into live discovery (`discovery: "refreshable"`). */
export function listRefreshableProviders(cfg: OpenClawConfig): string[] {
  const providers = cfg.models?.providers ?? {};
  return Object.entries(providers)
    .filter(([, providerConfig]) => providerConfig?.discovery === "refreshable")
    .map(([providerId]) => normalizeModelCatalogProviderId(providerId))
    .sort();
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
  const fetchResult = await fetchOpenAiCompatibleModels({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    fetchFn: params.fetchFn,
  });

  // Probe served ids (network) before opening the write transaction. Served ids
  // that the /models list omits get recorded as source="probe".
  const liveSet = new Set(
    (fetchResult.ok ? fetchResult.models.map((m) => m.modelId) : []).map((id) => id.toLowerCase()),
  );
  let newServed: string[] = [];
  if (params.probeServed) {
    const observations = await probeServedModels({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      modelIds: collectProbeCandidateIds(params.cfg, provider, fetchResult),
      ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
    });
    const seen = new Set<string>();
    for (const { served } of observations) {
      const key = served.toLowerCase();
      if (key && !liveSet.has(key) && !seen.has(key)) {
        seen.add(key);
        newServed.push(served);
      }
    }
  }

  const apply = (db: DatabaseSync): ReconcileResult => {
    const result = reconcileProviderModels(db, { provider, fetchResult, nowMs: params.nowMs });
    if (newServed.length > 0) {
      upsertProbedServedModels(
        db,
        provider,
        newServed.map((id) => ({ modelId: id, raw: { id, via: "probe" } })),
        params.nowMs,
      );
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
