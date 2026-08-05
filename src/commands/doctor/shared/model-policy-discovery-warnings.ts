import type { ModelCatalogEntry } from "../../../agents/model-catalog.types.js";
// Doctor warning for models that discovery found but modelPolicy.allow forbids.
//
// modelPolicy.allow stores instances while discovery produces a stream, so a
// pinned allowlist silently stops covering a provider the moment its catalog
// grows. On 2026-08-04 a 19-entry list — written by the modelPolicyAllowlist
// migration, which preserves legacy model-map restrictions — hid 156 discovered
// qwen models, 3 of 4 local Ollama models, and 2 new zai models. Nothing said so:
// the models were configured, paid for, discovered and catalogued, and simply
// never appeared. That is the silent-failure class, so it gets a named warning
// rather than another gate.
//
// Wildcards (`provider/*`) are the durable shape and produce no warning; this
// only fires where a provider is genuinely partially covered.
import { buildAllowedModelSet } from "../../../agents/model-selection.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export type DiscoveredModelRef = { provider: string; modelId: string };

/**
 * Doctor entry point: reads the discovered store and delegates.
 *
 * The catalog is synthesized from the discovered rows rather than loaded through
 * loadPreparedModelCatalogSnapshot. Only the discovered refs are being tested for
 * permission, so the full prepared catalog buys nothing and costs a great deal —
 * `openclaw doctor` already runs for minutes on a populated install, and a
 * diagnostic has no business adding to that. ModelCatalogEntry needs only
 * id/name/provider, which every discovered row has.
 *
 * Lazily imported and wrapped: a diagnostic must never be the reason doctor
 * fails, so a machine with no state DB yet simply produces no warning.
 */
export async function collectModelPolicyDiscoveryWarningsForDoctor(params: {
  cfg: OpenClawConfig;
}): Promise<string[]> {
  try {
    if (Object.keys(params.cfg.models?.providers ?? {}).length === 0) {
      return [];
    }
    const [{ openOpenClawStateDatabase }, { listDiscoveredModels }] = await Promise.all([
      import("../../../state/openclaw-state-db.js"),
      import("../../../model-catalog/discovered-store.js"),
    ]);
    const { db } = openOpenClawStateDatabase();
    const discovered = listDiscoveredModels(db, { status: "active" }).map((row) => ({
      provider: row.provider,
      modelId: row.modelId,
    }));
    if (discovered.length === 0) {
      return [];
    }
    const catalog: ModelCatalogEntry[] = discovered.map((entry) => ({
      id: entry.modelId,
      name: entry.modelId,
      provider: entry.provider,
    }));
    const defaults = params.cfg.agents?.defaults?.model;
    const primary = typeof defaults === "string" ? defaults : defaults?.primary;
    const [defaultProvider = "", defaultModel] = String(primary ?? "").split("/", 2);
    return collectModelPolicyDiscoveryWarnings({
      cfg: params.cfg,
      catalog,
      discovered,
      defaultProvider,
      ...(defaultModel ? { defaultModel } : {}),
    });
  } catch {
    return [];
  }
}

function modelRef(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

/**
 * Names providers whose discovered models are not selectable under the current
 * policy. Returns [] when the policy permits everything, which is the documented
 * default (an empty or absent allow list).
 *
 * `catalog` and `discovered` are injected rather than read here so this stays a
 * pure function over already-loaded state — doctor calls it after both are known.
 */
export function collectModelPolicyDiscoveryWarnings(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  discovered: DiscoveredModelRef[];
  defaultProvider: string;
  defaultModel?: string;
}): string[] {
  if (params.discovered.length === 0) {
    return [];
  }
  // The same resolver the runtime selects through, so this cannot report a
  // permission the dispatcher would disagree with.
  const policy = buildAllowedModelSet({
    cfg: params.cfg,
    catalog: params.catalog,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (policy.allowAny) {
    return [];
  }

  const blockedByProvider = new Map<string, number>();
  const totalByProvider = new Map<string, number>();
  for (const entry of params.discovered) {
    const provider = entry.provider.trim().toLowerCase();
    if (!provider || !entry.modelId) {
      continue;
    }
    totalByProvider.set(provider, (totalByProvider.get(provider) ?? 0) + 1);
    if (!policy.allowedKeys.has(modelRef(provider, entry.modelId))) {
      blockedByProvider.set(provider, (blockedByProvider.get(provider) ?? 0) + 1);
    }
  }

  const rows = [...blockedByProvider.entries()]
    .filter(([, blocked]) => blocked > 0)
    .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (rows.length === 0) {
    return [];
  }

  const detail = rows
    .map(
      ([provider, blocked]) => `${provider} ${blocked}/${totalByProvider.get(provider) ?? blocked}`,
    )
    .join(", ");
  return [
    `Discovered models are blocked by agents.defaults.modelPolicy.allow (${detail}). ` +
      `Discovery keeps finding models the policy does not permit, so they never become selectable. ` +
      `Use provider wildcards such as "${rows[0]?.[0]}/*" to cover a provider as its catalog grows, ` +
      `or clear the allow list to permit any model.`,
  ];
}
