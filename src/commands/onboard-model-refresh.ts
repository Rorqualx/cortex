/**
 * Post-onboard model discovery: once a provider's auth is configured, discover
 * its live models and reassign any deprecated pins, so newly-configured services
 * auto-populate without waiting for the gateway's periodic refresh.
 *
 * Best-effort and lazy-imported: a discovery/network failure (or no refreshable
 * provider) must never fail or slow a successful onboard. Shares the single
 * refresh path with the gateway periodic task.
 */
import type { RuntimeEnv } from "../runtime.js";

export async function refreshDiscoveredModelsAfterOnboard(runtime: RuntimeEnv): Promise<void> {
  try {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const snapshot = await readConfigFileSnapshot();
    const cfg = snapshot.valid ? (snapshot.sourceConfig ?? snapshot.config) : snapshot.config;
    if (!cfg) {
      return;
    }
    const { listRefreshableProviders } = await import("../model-catalog/discovery-orchestrator.js");
    if (listRefreshableProviders(cfg).length === 0) {
      return;
    }
    const { runModelCatalogRefreshOnce } = await import("../gateway/model-catalog-refresh.js");
    await runModelCatalogRefreshOnce(cfg, {
      info: (msg) => runtime.log(msg),
      warn: (msg) => runtime.log(msg),
    });
  } catch (err) {
    // Discovery is an enhancement; never let it break onboarding.
    runtime.log(`Model discovery skipped: ${String(err)}`);
  }
}
