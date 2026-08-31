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
    const { buildRuntimeReassignmentPlan, listAliasServedVersions } =
      await import("../model-catalog/reassign-runtime.js");
    const { plan } = await buildRuntimeReassignmentPlan(ctx.cfg);
    const findings: HealthFinding[] = plan.actions.map((action) => ({
      checkId: CHECK_ID,
      severity: action.binding.kind === "alias" ? ("info" as const) : ("warning" as const),
      message:
        action.outcome === "rewrite"
          ? `Pinned to a deprecated or superseded model; reassign ${describeReassignment(action)}.`
          : `Pinned to a deprecated model with no replacement: ${describeReassignment(action)}.`,
      fixHint: "Run `openclaw doctor --fix` to reassign deprecated/superseded model pins.",
    }));
    // Silent checkpoint sub-versions (e.g. deepseek-v4-pro served as
    // DeepSeek-V4-Pro-0813): surface the dated sub-version per alias pin so a
    // provider swapping checkpoints under an unchanged alias is diffable
    // across doctor runs instead of invisible.
    for (const v of listAliasServedVersions(ctx.cfg)) {
      const confirmed = new Date(v.lastSeenMs).toISOString().slice(0, 10);
      findings.push({
        checkId: CHECK_ID,
        severity: "info" as const,
        message: `Alias "${v.alias}" pins ${v.pinnedModelId}; provider currently serves ${v.servedModelId} (checkpoint sub-version, confirmed ${confirmed}).`,
        fixHint:
          "Run `openclaw doctor --fix` to re-point the alias onto the served id and re-probe it.",
      });
    }
    return findings;
  },
  async repair(ctx: HealthRepairContext): Promise<HealthRepairResult> {
    const { buildRuntimeReassignmentPlan, buildRuntimeApplyDeps, buildDiscoveredDisplayNames } =
      await import("../model-catalog/reassign-runtime.js");
    const { applyReassignmentPlan } = await import("../model-catalog/reassign-apply.js");
    const { applyAliasReassignments } = await import("../model-catalog/reassign-alias.js");
    const { plan } = await buildRuntimeReassignmentPlan(ctx.cfg);
    const dryRun = ctx.dryRun === true;
    if (plan.actions.length === 0) {
      // Even with nothing to reassign, silently-upgraded alias checkpoints are
      // worth re-probing so the recorded sub-version stays current (diffable).
      const probed = dryRun ? [] : await reprobeAliasServedVersions(ctx.cfg);
      return probed.length > 0
        ? {
            status: "repaired",
            changes: probed,
            effects: [{ kind: "state", action: "probe-alias-served-versions", dryRunSafe: false }],
          }
        : { status: "skipped", reason: "no deprecated or superseded model pins", changes: [] };
    }
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

    // Re-probe alias pins (network, best-effort) so the recorded served
    // sub-version is stamped fresh even after repointing — the next doctor run
    // can diff it against this one and catch a silent checkpoint swap.
    if (!dryRun) {
      changes.push(...(await reprobeAliasServedVersions(ctx.cfg)));
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

/**
 * Re-probes every configured alias pin (best-effort, never throws): asks the
 * provider what it actually serves for the pinned id and records the
 * observation in the discovered store. When the served id differs from the
 * pinned id — e.g. `deepseek-v4-pro` answered with `DeepSeek-V4-Pro-0813` —
 * the dated sub-version link is stamped so future silent swaps are diffable.
 * Returns human-readable change lines for the doctor repair report.
 */
async function reprobeAliasServedVersions(cfg: HealthRepairContext["cfg"]): Promise<string[]> {
  try {
    const { buildModelAliasIndex } = await import("../agents/model-selection-shared.js");
    const { DEFAULT_PROVIDER } = await import("../agents/defaults.js");
    const { probeServedModel, probeProtocolForApi } =
      await import("../model-catalog/served-model-probe.js");
    const { upsertProbedServedModels } = await import("../model-catalog/discovered-store.js");
    const { openOpenClawStateDatabase } = await import("../state/openclaw-state-db.js");
    const { resolveDiscoveryEndpoint } = await import("../model-catalog/discovery-orchestrator.js");

    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
    const byProvider = new Map<string, Set<string>>();
    for (const { ref } of aliasIndex.byAlias.values()) {
      const set = byProvider.get(ref.provider) ?? new Set<string>();
      set.add(ref.model);
      byProvider.set(ref.provider, set);
    }

    const changes: string[] = [];
    const nowMs = Date.now();
    for (const [provider, modelIds] of byProvider) {
      const endpoint = await resolveDiscoveryEndpoint(cfg, provider);
      if (!endpoint) {
        continue; // no usable credentials/baseUrl for this provider
      }
      for (const modelId of modelIds) {
        const served = await probeServedModel({
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKey,
          modelId,
          protocol: probeProtocolForApi(endpoint.api),
        });
        if (!served) {
          continue; // probe failure — skip silently, never fail the repair
        }
        if (served.trim().toLowerCase() === modelId.toLowerCase()) {
          // No upgrade: skip the upsert so an existing upgrade link stamped on
          // a snapshot row (e.g. 0811 -> 0813) is never clobbered.
          continue;
        }
        const { db } = openOpenClawStateDatabase();
        upsertProbedServedModels(
          db,
          provider,
          [
            {
              modelId: served,
              raw: { id: served, via: "doctor-probe", upgradedFrom: [modelId] },
            },
          ],
          nowMs,
        );
        changes.push(`probed alias target ${modelId} -> served ${served} (sub-version recorded)`);
      }
    }
    return changes;
  } catch {
    // Probing is advisory — a failure must never fail the repair.
    return [];
  }
}
