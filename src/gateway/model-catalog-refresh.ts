/**
 * Gateway background model-catalog refresh. On a fixed cadence it discovers live
 * models for every `discovery: "refreshable"` provider, reconciles the persisted
 * snapshot (auto-populate new, flag vanished), then reassigns any crons/agents
 * pinned to a now-deprecated model. Returns a stop function the gateway clears on
 * shutdown, mirroring the model-pricing refresh lifecycle.
 *
 * This is metadata maintenance, not a request hot path: it writes SQLite and runs
 * off a self-rescheduling timer (unref'd so it never holds the process open).
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_REFRESH_INTERVAL_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

type RefreshLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

/** Resolves the configured cadence in ms, or null when disabled (<= 0). */
export function resolveModelCatalogRefreshIntervalMs(config: OpenClawConfig): number | null {
  const raw = config.models?.refreshIntervalHours;
  const hours =
    typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_REFRESH_INTERVAL_HOURS;
  if (hours <= 0) {
    return null;
  }
  return hours * HOUR_MS;
}

/** Runs one discovery + reassignment pass; isolated so the timer can await it. */
export async function runModelCatalogRefreshOnce(
  config: OpenClawConfig,
  log: RefreshLogger,
): Promise<void> {
  const { runAllRefreshableProviderDiscovery } =
    await import("../model-catalog/discovery-orchestrator.js");
  const reports = await runAllRefreshableProviderDiscovery({ cfg: config, nowMs: Date.now() });
  const added = reports.reduce((sum, r) => sum + (r.ok ? r.added.length : 0), 0);
  const deprecated = reports.reduce((sum, r) => sum + (r.ok ? r.deprecated.length : 0), 0);
  if (added > 0 || deprecated > 0) {
    log.info(
      `model discovery: +${added} new, ${deprecated} deprecated across ${reports.length} provider(s)`,
    );
  }
  if (deprecated === 0) {
    return;
  }
  const { buildRuntimeReassignmentPlan, buildRuntimeApplyDeps } =
    await import("../model-catalog/reassign-runtime.js");
  const { applyReassignmentPlan } = await import("../model-catalog/reassign-apply.js");
  const { plan } = await buildRuntimeReassignmentPlan(config);
  if (plan.actions.length === 0) {
    return;
  }
  const result = await applyReassignmentPlan(plan, buildRuntimeApplyDeps({ nowMs: Date.now() }));
  const reassigned = result.cronChanges.length + result.agentChanges.length;
  if (reassigned > 0) {
    log.info(`model reassignment: updated ${reassigned} deprecated pin(s)`);
  }
  if (result.deadAliases.length > 0) {
    log.warn(
      `aliases still point at deprecated models: ${result.deadAliases.join(", ")} (remove from agents.defaults.models)`,
    );
  }
}

/**
 * Starts the periodic refresh. Returns a stop function; a no-op stop is returned
 * when the cadence is disabled. The first pass runs after one interval (boot-time
 * discovery is handled separately by onboard/CLI), and each pass reschedules the
 * next so a slow run never overlaps itself.
 *
 * `getLog` is a thunk so the child logger is only materialized when the task
 * actually logs (on first tick), keeping activation-time logging order clean.
 */
export function startGatewayModelCatalogRefresh(params: {
  config: OpenClawConfig;
  getLog: () => RefreshLogger & { error: (msg: string) => void };
}): () => void {
  const intervalMs = resolveModelCatalogRefreshIntervalMs(params.config);
  if (intervalMs === null) {
    return () => {};
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    timer = setTimeout(() => {
      timer = null;
      const log = params.getLog();
      void runModelCatalogRefreshOnce(params.config, log)
        .catch((error: unknown) => {
          log.error(`model catalog refresh failed: ${String(error)}`);
        })
        .finally(() => {
          if (!stopped) {
            schedule();
          }
        });
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
