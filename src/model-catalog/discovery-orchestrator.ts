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
import { fetchOpenAiCompatibleModels } from "./model-discovery.js";
import { type ReconcileResult, reconcileProviderModels } from "./reconcile.js";

/** Resolved network target for a provider's /models endpoint. */
export type DiscoveryEndpoint = { baseUrl: string; apiKey: string };

/** Per-provider discovery outcome surfaced to CLI/doctor/log. */
export type ProviderDiscoveryReport = { provider: string } & ReconcileResult;

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

/** Runs discovery + reconcile for one provider. Skips cleanly when unconfigured. */
export async function runProviderModelDiscovery(params: {
  provider: string;
  cfg: OpenClawConfig;
  nowMs: number;
  db?: DatabaseSync;
  fetchFn?: typeof fetch;
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
  const reconcile = (db: DatabaseSync): ReconcileResult =>
    reconcileProviderModels(db, { provider, fetchResult, nowMs: params.nowMs });
  const result = params.db
    ? reconcile(params.db)
    : runOpenClawStateWriteTransaction((database) => reconcile(database.db));
  return { provider, ...result };
}

/** Runs discovery for every configured refreshable provider. */
export async function runAllRefreshableProviderDiscovery(params: {
  cfg: OpenClawConfig;
  nowMs: number;
  db?: DatabaseSync;
  fetchFn?: typeof fetch;
}): Promise<ProviderDiscoveryReport[]> {
  const providers = listRefreshableProviders(params.cfg);
  const reports: ProviderDiscoveryReport[] = [];
  for (const provider of providers) {
    reports.push(await runProviderModelDiscovery({ ...params, provider }));
  }
  return reports;
}
