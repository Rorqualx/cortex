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
    return plan.actions.map((action) => ({
      checkId: CHECK_ID,
      severity: action.binding.kind === "alias" ? ("info" as const) : ("warning" as const),
      message:
        action.outcome === "rewrite"
          ? `Pinned to a deprecated or superseded model; reassign ${describeReassignment(action)}.`
          : `Pinned to a deprecated model with no replacement: ${describeReassignment(action)}.`,
      fixHint: "Run `openclaw doctor --fix` to reassign deprecated/superseded model pins.",
    }));
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
