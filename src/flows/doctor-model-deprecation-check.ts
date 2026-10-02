/**
 * Doctor health check: reports crons/agents pinned to models that live discovery
 * has flagged deprecated, and `--fix` reassigns them to nearest-capability
 * survivors (or disables/clears when none survive). Aliases pointing at a dead
 * model are surfaced as warnings for config normalization, not auto-edited here.
 *
 * The heavy runtime wiring (state DB, cron store, session stores, catalog) is
 * lazy-imported inside detect/repair so registering the check stays cheap.
 */
import type {
  HealthCheck,
  HealthCheckContext,
  HealthFinding,
  HealthRepairContext,
  HealthRepairResult,
} from "./health-checks.js";

const CHECK_ID = "core/doctor/model-deprecation";

/**
 * Input-modality caps per model, keyed `${provider}/${modelId}` (lowercased).
 * Built from the provider-index preview catalog; advisory only — models absent
 * from the index contribute no signal.
 */
export type ModelInputCaps = ReadonlyMap<string, ReadonlySet<string>>;

/** Minimal structural shape consumed from the provider index. */
type ProviderIndexLike = {
  providers: Record<
    string,
    {
      id?: string;
      previewCatalog?:
        | {
            models: readonly { id: string; input?: readonly string[] }[];
          }
        | undefined;
    }
  >;
};

/** Projects provider-index preview models into an input-modality lookup. */
export function buildProviderIndexInputCaps(index: ProviderIndexLike): ModelInputCaps {
  const caps = new Map<string, ReadonlySet<string>>();
  for (const provider of Object.values(index.providers)) {
    for (const model of provider.previewCatalog?.models ?? []) {
      caps.set(`${provider.id}/${model.id}`.toLowerCase(), new Set(model.input ?? []));
    }
  }
  return caps;
}

/**
 * Warning note for reassignments that silently drop image input: the pinned
 * (deprecated) model accepted images while the replacement is text-only.
 * Null when the swap keeps vision, either side is unknown, or nothing survives.
 */
export function visionDropNote(
  action: {
    binding: { kind: string; ref: { provider: string; modelId: string } };
    outcome: "rewrite" | "clear";
    replacementModelId?: string;
  },
  caps: ModelInputCaps,
): string | null {
  if (action.outcome !== "rewrite" || !action.replacementModelId) {
    return null;
  }
  const { provider, modelId } = action.binding.ref;
  const fromCaps = caps.get(`${provider}/${modelId}`.toLowerCase());
  const toCaps = caps.get(`${provider}/${action.replacementModelId}`.toLowerCase());
  if (!fromCaps || !toCaps) {
    return null;
  }
  if (!fromCaps.has("image") || toCaps.has("image")) {
    return null;
  }
  return `${modelId} accepts images but ${action.replacementModelId} is text-only — this reassignment silently drops vision capability`;
}

async function loadInputCaps(): Promise<ModelInputCaps> {
  try {
    const { loadOpenClawProviderIndex } = await import("../model-catalog/provider-index/index.js");
    return buildProviderIndexInputCaps(loadOpenClawProviderIndex());
  } catch {
    return new Map();
  }
}

function describeReassignment(action: {
  binding: { kind: string; jobId?: string; agentId?: string; sessionKey?: string; alias?: string };
  outcome: "rewrite" | "clear";
  replacementModelId?: string;
}): string {
  const target =
    action.binding.kind === "cron-model" || action.binding.kind === "cron-fallback"
      ? `cron ${action.binding.jobId}`
      : action.binding.kind === "agent-model"
        ? `agent ${action.binding.agentId} (session ${action.binding.sessionKey})`
        : `alias "${action.binding.alias}"`;
  if (action.outcome === "rewrite") {
    return `${target} -> ${action.replacementModelId}`;
  }
  return `${target}: no replacement available`;
}

export const MODEL_DEPRECATION_HEALTH_CHECK: HealthCheck = {
  id: CHECK_ID,
  kind: "core",
  description: "Crons and agents are not pinned to deprecated provider models.",
  source: "doctor",
  async detect(ctx: HealthCheckContext): Promise<readonly HealthFinding[]> {
    const { buildRuntimeReassignmentPlan } = await import("../model-catalog/reassign-runtime.js");
    const { plan } = await buildRuntimeReassignmentPlan(ctx.cfg);
    const caps = await loadInputCaps();
    return plan.actions.map((action) => {
      const note = visionDropNote(action, caps);
      const base =
        action.outcome === "rewrite"
          ? `Pinned to a deprecated or superseded model; reassign ${describeReassignment(action)}.`
          : `Pinned to a deprecated model with no replacement: ${describeReassignment(action)}.`;
      return {
        checkId: CHECK_ID,
        // A vision-dropping swap deserves operator visibility even for aliases,
        // which otherwise report as info-only.
        severity:
          note !== null || action.binding.kind !== "alias"
            ? ("warning" as const)
            : ("info" as const),
        message: note !== null ? `${base} Note: ${note}.` : base,
        fixHint: "Run `openclaw doctor --fix` to reassign deprecated/superseded model pins.",
      };
    });
  },
  async repair(ctx: HealthRepairContext): Promise<HealthRepairResult> {
    const { buildRuntimeReassignmentPlan, buildRuntimeApplyDeps, buildDiscoveredDisplayNames } =
      await import("../model-catalog/reassign-runtime.js");
    const { applyReassignmentPlan } = await import("../model-catalog/reassign-apply.js");
    const { applyAliasReassignments } = await import("../model-catalog/reassign-alias.js");
    const { plan } = await buildRuntimeReassignmentPlan(ctx.cfg);
    if (plan.actions.length === 0) {
      return { status: "skipped", reason: "no deprecated or superseded model pins", changes: [] };
    }
    const dryRun = ctx.dryRun === true;
    const deps = buildRuntimeApplyDeps({ nowMs: Date.now(), dryRun });
    const result = await applyReassignmentPlan(plan, deps);

    const changes: string[] = [
      ...result.cronChanges.map((c) =>
        c.field === "model"
          ? c.disabled
            ? `disabled cron ${c.jobId} (model ${c.from} deprecated, no replacement)`
            : `cron ${c.jobId} model ${c.from} -> ${c.to}`
          : `cron ${c.jobId} fallback[${c.index}] ${c.from} -> ${c.to ?? "removed"}`,
      ),
      ...result.agentChanges.map((c) =>
        c.to
          ? `agent ${c.agentId} (${c.sessionKey}) ${c.from} -> ${c.to}`
          : `agent ${c.agentId} (${c.sessionKey}) cleared override ${c.from}`,
      ),
    ];

    // Aliases live in openclaw.json; doctor --fix is the flow allowed to rewrite
    // it. Repoint/relabel/drop alias entries and return the new config to persist.
    let config: HealthRepairResult["config"];
    const aliasMap = ctx.cfg.agents?.defaults?.models;
    if (aliasMap && typeof aliasMap === "object" && !Array.isArray(aliasMap)) {
      const displayNameFor = buildDiscoveredDisplayNames();
      const { aliases, changes: aliasChanges } = applyAliasReassignments({
        aliases: aliasMap as Record<string, { alias?: string }>,
        actions: plan.actions,
        displayNameFor,
      });
      for (const c of aliasChanges) {
        changes.push(
          c.outcome === "repoint"
            ? `alias "${c.alias}" ${c.fromKey} -> ${c.toKey} (label "${c.newLabel}")`
            : `dropped alias "${c.alias}" (${c.fromKey})`,
        );
      }
      if (aliasChanges.length > 0 && !dryRun) {
        const next = structuredClone(ctx.cfg);
        next.agents = next.agents ?? {};
        next.agents.defaults = next.agents.defaults ?? {};
        (next.agents.defaults as { models?: unknown }).models = aliases;
        config = next;
      }
    }

    // Surface silent capability drops (e.g. a retired vision alias repointed at
    // a text-only replacement) so the operator sees what the swap costs.
    const caps = await loadInputCaps();
    for (const action of plan.actions) {
      const note = visionDropNote(action, caps);
      if (note !== null) {
        changes.push(`${describeReassignment(action)} — ${note}`);
      }
    }

    const effects =
      changes.length > 0
        ? [
            {
              kind: "state" as const,
              action: dryRun
                ? "would-reassign-deprecated-model-pins"
                : "reassign-deprecated-model-pins",
              dryRunSafe: false,
            },
          ]
        : [];
    return {
      status: changes.length > 0 ? "repaired" : "skipped",
      changes,
      effects,
      ...(config ? { config } : {}),
    };
  },
};
