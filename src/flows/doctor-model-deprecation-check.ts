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
          ? `Pinned to a deprecated model; reassign ${describeReassignment(action)}.`
          : `Pinned to a deprecated model with no replacement: ${describeReassignment(action)}.`,
      fixHint: "Run `openclaw doctor --fix` to reassign deprecated model pins.",
    }));
  },
  async repair(ctx: HealthRepairContext): Promise<HealthRepairResult> {
    const { buildRuntimeReassignmentPlan, buildRuntimeApplyDeps } =
      await import("../model-catalog/reassign-runtime.js");
    const { applyReassignmentPlan } = await import("../model-catalog/reassign-apply.js");
    const { plan } = await buildRuntimeReassignmentPlan(ctx.cfg);
    if (plan.actions.length === 0) {
      return { status: "skipped", reason: "no deprecated model pins", changes: [] };
    }
    const deps = buildRuntimeApplyDeps({ nowMs: Date.now(), dryRun: ctx.dryRun === true });
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
    const warnings =
      result.deadAliases.length > 0
        ? [
            `Aliases still point at deprecated models: ${result.deadAliases.join(", ")}. Remove them from agents.defaults.models.`,
          ]
        : [];
    const effects =
      changes.length > 0
        ? [
            {
              kind: "state" as const,
              action:
                ctx.dryRun === true
                  ? "would-reassign-deprecated-model-pins"
                  : "reassign-deprecated-model-pins",
              dryRunSafe: false,
            },
          ]
        : [];
    return { status: changes.length > 0 ? "repaired" : "skipped", changes, warnings, effects };
  },
};
