import { listAgentIds } from "../agents/agent-scope-config.js";
/**
 * Runtime wiring for model reassignment: reads the deprecated discovery snapshot,
 * the live catalog, and every model binding (crons, agent sessions, aliases),
 * then produces a plan plus the store deps to apply it. Kept on its own module so
 * the doctor check and gateway task lazy-import it without pulling the state DB,
 * cron store, and session store into light import paths.
 */
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../agents/model-selection-shared.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import { readSessionEntries } from "../config/sessions/store-load.js";
import { applySessionStoreEntryPatch } from "../config/sessions/store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  loadCronJobsStore,
  loadCronJobsStoreSync,
  resolveCronJobsStorePath,
  saveCronJobsStore,
} from "../cron/store.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { listDiscoveredModels } from "./discovered-store.js";
import type { ReassignApplyDeps } from "./reassign-apply.js";
import {
  collectAgentBindings,
  collectAliasBindings,
  collectCronBindings,
  type ResolveRef,
} from "./reassign-collect.js";
import {
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
    return readSessionEntries(storePath);
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
  if (deprecated.length === 0) {
    return { plan: { actions: [], unresolved: [] }, deprecatedCount: 0 };
  }

  const catalog = await loadModelCatalog({ config: cfg, readOnly: true });
  const candidates = catalog.map(toCandidate);
  const defaultRef = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const replacements = buildReplacementDecisions({
    deprecated: deprecated.map((row) => ({ provider: row.provider, modelId: row.modelId })),
    candidates,
    defaultModelByProvider: new Map([[defaultRef.provider, defaultRef.model]]),
  });

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
  const resolveRef = buildResolveRef(cfg, aliasIndex);
  const bindings = collectAllBindings(cfg, resolveRef, aliasIndex);
  const plan = planReassignments({ bindings, replacements });
  return { plan, deprecatedCount: deprecated.length };
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
      await applySessionStoreEntryPatch({
        storePath: resolveDefaultSessionStorePath(agentId),
        sessionKey,
        patch: patch as Partial<SessionEntry>,
      });
    },
    nowMs: params.nowMs,
    dryRun: params.dryRun,
  };
}
