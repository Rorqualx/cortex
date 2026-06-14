/**
 * `openclaw models refresh` — polls a provider's live /models endpoint, updates
 * the discovered-model snapshot, and reports newly added + deprecated models.
 *
 * An explicit `--provider` runs that provider even if it is not opted into
 * `discovery: "refreshable"` (an explicit operator request overrides opt-in);
 * with no provider, every refreshable provider is refreshed.
 */
import {
  listRefreshableProviders,
  type ProviderDiscoveryReport,
  runProviderModelDiscovery,
} from "../../model-catalog/discovery-orchestrator.js";
import type { RuntimeEnv } from "../../runtime.js";
import { loadModelsConfig } from "./load-config.js";

export type ModelsRefreshOptions = {
  provider?: string;
  json?: boolean;
};

function formatReport(report: ProviderDiscoveryReport): string {
  if (!report.ok) {
    return `  ${report.provider}: skipped (${report.reason})`;
  }
  const added = report.added.length ? report.added.join(", ") : "none";
  const deprecated = report.deprecated.length ? report.deprecated.join(", ") : "none";
  const probed = report.probedAdded?.length ? report.probedAdded.join(", ") : "none";
  return [
    `  ${report.provider}: ${report.activeCount} live model(s)`,
    `    added:        ${added}`,
    `    served-only:  ${probed}`,
    `    deprecated:   ${deprecated}`,
  ].join("\n");
}

export async function modelsRefreshCommand(
  opts: ModelsRefreshOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = await loadModelsConfig({ commandName: "models refresh", runtime });
  const explicit = opts.provider?.trim();
  const providers = explicit ? [explicit] : listRefreshableProviders(cfg);

  if (providers.length === 0) {
    runtime.log(
      'No providers to refresh. Mark a provider with `discovery: "refreshable"` in models.providers, or pass --provider <id>.',
    );
    return;
  }

  const nowMs = Date.now();
  const reports: ProviderDiscoveryReport[] = [];
  for (const provider of providers) {
    reports.push(await runProviderModelDiscovery({ provider, cfg, nowMs, probeServed: true }));
  }

  if (opts.json) {
    runtime.log(JSON.stringify({ reports }, null, 2));
    return;
  }

  runtime.log("Model discovery refresh:");
  for (const report of reports) {
    runtime.log(formatReport(report));
  }
  const anyDeprecated = reports.some((r) => r.ok && r.deprecated.length > 0);
  if (anyDeprecated) {
    runtime.log(
      "\nDeprecated models stay recorded but are hidden from selection. Run `openclaw doctor --fix` to reassign any crons/agents pinned to them.",
    );
  }
}
