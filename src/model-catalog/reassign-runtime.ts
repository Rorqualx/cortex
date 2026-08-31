/**
 * Runtime wiring for model reassignment: reads the deprecated discovery snapshot,
 * the live catalog, and every model binding (crons, agent sessions, aliases),
 * then produces a plan plus the store deps to apply it. Kept on its own module so
 * the doctor check and gateway task lazy-import it without pulling the state DB,
 * cron store, and session store into light import paths.
 */
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { listAgentIds } from "../agents/agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { loadPreparedModelCatalog } from "../agents/prepared-model-catalog.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { patchSessionEntryWithKey } from "../config/sessions/session-accessor.entry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadCronJobsStore,
  loadCronJobsStoreSync,
  resolveCronJobsStorePath,
  saveCronJobsStore,
} from "../cron/store.js";
import { loadSessionStore } from "../plugin-sdk/session-store-runtime.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { listDiscoveredModels, listSilentUpgrades } from "./discovered-store.js";
import { loadOpenClawProviderIndex } from "./provider-index/index.js";
import type { ReassignApplyDeps } from "./reassign-apply.js";
import {
  collectAgentBindings,
  collectAliasBindings,
  collectCronBindings,
  type ResolveRef,
} from "./reassign-collect.js";
import {
  type DeprecatedReplacement,
  type ModelBinding,
  type ReassignmentPlan,
  buildReplacementDecisions,
  planReassignments,
} from "./reassign-plan.js";
import type { ReplacementCandidate } from "./reconcile.js";

/** Plan plus the counts a caller reports without re-deriving them. */
export type RuntimeReassignmentPlan = {
  plan: ReassignmentPlan;
  deprecatedCount: number;
};

function toCandidate(entry: ModelCatalogEntry): ReplacementCandidate {
  return {
    provider: entry.provider,
    id: entry.id,
    ...(entry.reasoning !== undefined ? { reasoning: entry.reasoning } : {}),
    ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
  };
}

type AliasIndex = ReturnType<typeof buildModelAliasIndex>;

/** Builds the alias-aware ref resolver from a prebuilt alias index. */
function buildResolveRef(cfg: OpenClawConfig, aliasIndex: AliasIndex): ResolveRef {
  return (raw, providerHint) => {
    const resolved = resolveModelRefFromString({
      cfg,
      raw,
      defaultProvider: providerHint?.trim() || DEFAULT_PROVIDER,
      aliasIndex,
    });
    return resolved ? { provider: resolved.ref.provider, modelId: resolved.ref.model } : null;
  };
}

/** Collects every model binding across crons, agent sessions, and aliases. */
function collectAllBindings(
  cfg: OpenClawConfig,
  resolveRef: ResolveRef,
  aliasIndex: AliasIndex,
): ModelBinding[] {
  const bindings: ModelBinding[] = [];

  const cronStore = loadCronJobsStoreSyncSafe();
  if (cronStore) {
    bindings.push(...collectCronBindings(cronStore, resolveRef));
  }

  for (const agentId of listAgentIds(cfg)) {
    const entries = readSessionEntriesSafe(resolveDefaultSessionStorePath(agentId));
    bindings.push(...collectAgentBindings(agentId, entries, resolveRef));
  }

  const aliasRefs = [...aliasIndex.byAlias.values()].map(({ alias, ref }) => ({
    alias,
    ref: { provider: ref.provider, modelId: ref.model },
  }));
  bindings.push(...collectAliasBindings(aliasRefs));

  return bindings;
}

function loadCronJobsStoreSyncSafe() {
  try {
    return loadCronJobsStoreSync(resolveCronJobsStorePath());
  } catch {
    return null;
  }
}

function readSessionEntriesSafe(storePath: string) {
  try {
    // Read-only binding scan: no clone keeps this on the shared store cache
    // (the former readSessionEntries snapshot helper was removed upstream).
    return Object.entries(loadSessionStore(storePath));
  } catch {
    return [];
  }
}

/**
 * Builds the reassignment plan from current state. Returns an empty plan when no
 * models are deprecated, so callers can short-circuit before touching stores.
 */
export async function buildRuntimeReassignmentPlan(
  cfg: OpenClawConfig,
): Promise<RuntimeReassignmentPlan> {
  const { db } = openOpenClawStateDatabase();
  const deprecated = listDiscoveredModels(db, { status: "deprecated" });
  const upgrades = listSilentUpgrades(db);

  const catalog = await loadPreparedModelCatalog({ config: cfg, readOnly: true });

  // Collect pre-announced deprecations from catalog entries (manifest/provider-index
  // data that carries a replacedBy hint before the model actually vanishes).
  const catalogReplacements: DeprecatedReplacement[] = [];
  for (const entry of catalog) {
    if (entry.replacedBy) {
      catalogReplacements.push({
        provider: entry.provider,
        deprecatedModelId: entry.id,
        replacementModelId: entry.replacedBy,
      });
    }
  }

  // Also collect pre-announced deprecations from the provider-index preview catalog
  // (pre-install discovery data; models here may not yet be in the runtime catalog).
  const providerIndexReplacements: DeprecatedReplacement[] = [];
  try {
    const index = loadOpenClawProviderIndex();
    if (index) {
      for (const provider of Object.values(index.providers)) {
        if (!provider.previewCatalog) continue;
        for (const model of provider.previewCatalog.models) {
          if (model.status === "deprecated" && model.replacedBy) {
            providerIndexReplacements.push({
              provider: provider.id,
              deprecatedModelId: model.id,
              replacementModelId: model.replacedBy,
            });
          }
        }
      }
    }
  } catch {
    // Provider-index is advisory; failures never block reassignment planning.
  }

  // Merge pre-specified replacements, with catalog entries taking priority.
  const preSpecifiedByKey = new Map<string, DeprecatedReplacement>();
  // Provider-index second so catalog entries take priority.
  for (const r of providerIndexReplacements) {
    const key = `${r.provider}/${r.deprecatedModelId}`.toLowerCase();
    if (!preSpecifiedByKey.has(key)) preSpecifiedByKey.set(key, r);
  }
  for (const r of catalogReplacements) {
    const key = `${r.provider}/${r.deprecatedModelId}`.toLowerCase();
    preSpecifiedByKey.set(key, r);
  }

  if (deprecated.length === 0 && upgrades.length === 0 && preSpecifiedByKey.size === 0) {
    return { plan: { actions: [], unresolved: [] }, deprecatedCount: 0 };
  }

  const candidates = catalog.map(toCandidate);
  const defaultRef = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const deprecatedReplacements = buildReplacementDecisions({
    deprecated: deprecated.map((row) => ({ provider: row.provider, modelId: row.modelId })),
    candidates,
    defaultModelByProvider: new Map([[defaultRef.provider, defaultRef.model]]),
  });
  // Silent upgrades repoint the superseded id directly onto its served id.
  const upgradeReplacements = upgrades.map((u) => ({
    provider: u.provider,
    deprecatedModelId: u.from,
    replacementModelId: u.to,
  }));
  // Pre-specified replacements take priority over scored ones.
  const replacements = [
    ...deprecatedReplacements.filter(
      (r) => !preSpecifiedByKey.has(`${r.provider}/${r.deprecatedModelId}`.toLowerCase()),
    ),
    ...upgradeReplacements,
    ...preSpecifiedByKey.values(),
  ];

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
  const resolveRef = buildResolveRef(cfg, aliasIndex);
  const bindings = collectAllBindings(cfg, resolveRef, aliasIndex);
  const plan = planReassignments({ bindings, replacements });
  return { plan, deprecatedCount: deprecated.length + preSpecifiedByKey.size };
}

/**
 * An alias pin whose target id the provider is silently serving as a different
 * (typically dated-checkpoint) id — e.g. alias "fast" pins `deepseek-v4-pro`
 * while the provider serves `DeepSeek-V4-Pro-0813`. Surfaced by doctor so the
 * sub-version is visible and diffable across runs instead of invisible.
 */
export type AliasServedVersion = {
  alias: string;
  provider: string;
  /** The model id the alias is pinned to (what we request). */
  pinnedModelId: string;
  /** The id the provider actually serves (the dated checkpoint sub-version). */
  servedModelId: string;
  /** When the served id was last probe-confirmed for the pinned id (ms epoch). */
  lastSeenMs: number;
};

/**
 * Cross-references configured alias pins against recorded silent-upgrade links
 * from the served-model probe. Read-only; failures return an empty list.
 */
export function listAliasServedVersions(cfg: OpenClawConfig): AliasServedVersion[] {
  try {
    const { db } = openOpenClawStateDatabase();
    const upgrades = listSilentUpgrades(db);
    if (upgrades.length === 0) {
      return [];
    }
    const byFromKey = new Map(
      upgrades.map((u) => [`${u.provider}/${u.from}`.toLowerCase(), u] as const),
    );
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
    const out: AliasServedVersion[] = [];
    for (const { alias, ref } of aliasIndex.byAlias.values()) {
      // listSilentUpgrades dedupes per (provider, from), so at most one link.
      const hit = byFromKey.get(`${ref.provider}/${ref.model}`.toLowerCase());
      if (hit) {
        out.push({
          alias,
          provider: hit.provider,
          pinnedModelId: ref.model,
          servedModelId: hit.to,
          lastSeenMs: hit.lastSeenMs,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Builds a `(provider, modelId) => displayName` lookup from active discovered
 * rows, so alias repointing can relabel to the live display name (e.g. the Kimi
 * coding plan's "K2.7 Code") when discovery provides one.
 */
export function buildDiscoveredDisplayNames(): (
  provider: string,
  modelId: string,
) => string | undefined {
  const { db } = openOpenClawStateDatabase();
  const rows = listDiscoveredModels(db, { status: "active" });
  const byKey = new Map<string, string>();
  for (const row of rows) {
    const name = row.name?.trim();
    if (name) {
      byKey.set(
        `${normalizeModelCatalogProviderId(row.provider)}/${row.modelId.toLowerCase()}`,
        name,
      );
    }
  }
  return (provider, modelId) =>
    byKey.get(`${normalizeModelCatalogProviderId(provider)}/${modelId.trim().toLowerCase()}`);
}

/** Store deps that apply a plan to the real cron + session stores. */
export function buildRuntimeApplyDeps(params: {
  nowMs: number;
  dryRun?: boolean;
}): ReassignApplyDeps {
  const cronStorePath = resolveCronJobsStorePath();
  return {
    loadCronStore: () => loadCronJobsStore(cronStorePath),
    saveCronStore: (store) => saveCronJobsStore(cronStorePath, store),
    patchAgentSession: async (agentId, sessionKey, patch) => {
      // Merge-patch the existing entry; missing sessions are skipped (returns null),
      // matching the removed applySessionStoreEntryPatch helper.
      await patchSessionEntryWithKey(
        { storePath: resolveDefaultSessionStorePath(agentId), sessionKey },
        () => patch,
      );
    },
    nowMs: params.nowMs,
    dryRun: params.dryRun,
  };
}
