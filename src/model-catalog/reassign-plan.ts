/**
 * Pure planner that decides how to reassign model bindings off deprecated models.
 *
 * Discovery flags a model deprecated (install-scoped) when it vanishes from a
 * provider's live /models set; `reconcile.ts#pickReplacementModel` then chooses a
 * nearest-capability survivor. This module takes those (deprecated -> replacement)
 * decisions plus the set of places a model id is pinned (cron payload model +
 * fallbacks, an agent's session model override, config aliases) and produces a
 * typed plan of rewrites/clears. Kept free of I/O so the doctor `--fix` flow can
 * collect bindings from the real stores, plan here, then apply per binding kind.
 */
import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { type ReplacementCandidate, pickReplacementModel } from "./reconcile.js";

/** A model reference resolved to its owning provider + bare model id. */
export type ResolvedModelRef = { provider: string; modelId: string };

/**
 * One place a model id is pinned that may need reassignment. The doctor
 * collectors resolve each raw ref (alias/qualified/bare) to a `ResolvedModelRef`
 * via the runtime resolver before handing bindings to the planner.
 */
export type ModelBinding =
  | { kind: "cron-model"; jobId: string; ref: ResolvedModelRef }
  | { kind: "cron-fallback"; jobId: string; index: number; ref: ResolvedModelRef }
  | { kind: "agent-model"; agentId: string; sessionKey: string; ref: ResolvedModelRef }
  | { kind: "alias"; alias: string; ref: ResolvedModelRef };

/** A deprecated model and the replacement chosen for it (null = none survives). */
export type DeprecatedReplacement = {
  provider: string;
  deprecatedModelId: string;
  replacementModelId: string | null;
};

/**
 * What to do with one binding. `rewrite` swaps to the replacement model id;
 * `clear` means no survivor exists, so the writer drops the pin per kind
 * (disable the cron job, remove the fallback entry, unset the agent override,
 * drop the alias) and warns.
 */
export type ReassignmentAction =
  | { binding: ModelBinding; outcome: "rewrite"; replacementModelId: string }
  | { binding: ModelBinding; outcome: "clear" };

/** Result of planning: concrete actions plus the bindings left without a survivor. */
export type ReassignmentPlan = {
  actions: ReassignmentAction[];
  /** Bindings whose model is deprecated with no replacement (subset of actions). */
  unresolved: ModelBinding[];
};

/**
 * Builds the deprecated->replacement decisions for a set of deprecated models by
 * scoring nearest-capability survivors per provider. `candidates` are the active
 * catalog rows; `deprecatedMeta` supplies the deprecated model's capability hints
 * when still known (a vanished model often has none, in which case scoring falls
 * back to the provider default).
 */
export function buildReplacementDecisions(params: {
  deprecated: readonly { provider: string; modelId: string }[];
  candidates: readonly ReplacementCandidate[];
  deprecatedMeta?: ReadonlyMap<string, ReplacementCandidate>;
  defaultModelByProvider?: ReadonlyMap<string, string>;
}): DeprecatedReplacement[] {
  return params.deprecated.map((entry) => {
    const provider = normalizeModelCatalogProviderId(entry.provider);
    const defaultModelId = params.defaultModelByProvider?.get(provider);
    const meta = params.deprecatedMeta?.get(refKey(entry.provider, entry.modelId));
    // With no capability hints for the vanished model, a defaulted reasoning=false
    // would bias scoring toward a non-reasoning model; prefer the provider default
    // outright when it is an active candidate.
    if (!meta && defaultModelId) {
      const defaultIsActive = params.candidates.some(
        (c) => c.provider === provider && c.id === defaultModelId,
      );
      if (defaultIsActive) {
        return { provider, deprecatedModelId: entry.modelId, replacementModelId: defaultModelId };
      }
    }
    const replacementModelId = pickReplacementModel({
      deprecated: meta ?? { provider, id: entry.modelId },
      candidates: params.candidates,
      defaultModelId,
    });
    return { provider, deprecatedModelId: entry.modelId, replacementModelId };
  });
}

function refKey(provider: string, modelId: string): string {
  return `${normalizeModelCatalogProviderId(provider)}/${modelId.trim().toLowerCase()}`;
}

/**
 * Indexes replacements by normalized provider/model key. The value is the
 * replacement model id, or null when the model is deprecated but has no survivor.
 * Absence from the map means the model is not deprecated (leave the binding be).
 */
export function buildReplacementIndex(
  replacements: readonly DeprecatedReplacement[],
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const entry of replacements) {
    index.set(refKey(entry.provider, entry.deprecatedModelId), entry.replacementModelId);
  }
  return index;
}

/**
 * Plans reassignment for the given bindings against the deprecated->replacement
 * decisions. Bindings whose model is not deprecated yield no action.
 */
export function planReassignments(params: {
  bindings: readonly ModelBinding[];
  replacements: readonly DeprecatedReplacement[];
}): ReassignmentPlan {
  const index = buildReplacementIndex(params.replacements);
  const actions: ReassignmentAction[] = [];
  const unresolved: ModelBinding[] = [];
  for (const binding of params.bindings) {
    const key = refKey(binding.ref.provider, binding.ref.modelId);
    if (!index.has(key)) {
      continue;
    }
    const replacement = index.get(key) ?? null;
    if (replacement === null || replacement === binding.ref.modelId) {
      // No survivor, or the only candidate is the deprecated model itself.
      unresolved.push(binding);
      actions.push({ binding, outcome: "clear" });
      continue;
    }
    actions.push({ binding, outcome: "rewrite", replacementModelId: replacement });
  }
  return { actions, unresolved };
}
