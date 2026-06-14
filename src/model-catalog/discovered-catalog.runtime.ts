/**
 * Runtime bridge that overlays the persisted discovery snapshot onto an
 * assembled model catalog. Kept on a lazy subpath so the catalog hot path does
 * not import the state DB at module load; failures are swallowed so discovery
 * never breaks catalog loading.
 */
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { applyDiscoveredCatalog } from "./discovered-catalog-merge.js";
import { listDiscoveredModels } from "./discovered-store.js";

/** Reads the discovered snapshot from the shared state DB and applies it. */
export function applyDiscoveredCatalogFromState(models: ModelCatalogEntry[]): ModelCatalogEntry[] {
  try {
    const { db } = openOpenClawStateDatabase();
    const all = listDiscoveredModels(db);
    if (all.length === 0) {
      return models;
    }
    return applyDiscoveredCatalog({
      models,
      active: all.filter((row) => row.status === "active"),
      deprecated: all.filter((row) => row.status === "deprecated"),
    });
  } catch {
    // Discovery is an enhancement; a state-DB hiccup must not break the catalog.
    return models;
  }
}
