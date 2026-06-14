/**
 * Applies the live-discovery snapshot to the assembled runtime model catalog:
 *  - auto-populates models the endpoint returned that aren't already present
 *    (minimal entries; rich metadata still comes from the manifest when known);
 *  - hides models flagged deprecated for this install (vanished upstream), even
 *    when a stale manifest/config row still declares them.
 *
 * Pure over already-read records so it is testable without the state DB; the DB
 * read happens at the catalog-load call site and is best-effort.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { DiscoveredModelRecord } from "./discovered-store.js";

function entryKey(provider: string, id: string): string {
  return normalizeLowercaseStringOrEmpty(`${normalizeProviderId(provider)}/${id}`);
}

/**
 * Returns the catalog with deprecated discovered models removed and newly
 * discovered (active, not-yet-present) models appended.
 */
export function applyDiscoveredCatalog(params: {
  models: readonly ModelCatalogEntry[];
  active: readonly DiscoveredModelRecord[];
  deprecated: readonly DiscoveredModelRecord[];
}): ModelCatalogEntry[] {
  const deprecatedKeys = new Set(
    params.deprecated.map((row) => entryKey(row.provider, row.modelId)),
  );
  const kept = params.models.filter(
    (entry) => !deprecatedKeys.has(entryKey(entry.provider, entry.id)),
  );

  const presentKeys = new Set(kept.map((entry) => entryKey(entry.provider, entry.id)));
  for (const row of params.active) {
    const key = entryKey(row.provider, row.modelId);
    if (presentKeys.has(key)) {
      continue;
    }
    presentKeys.add(key);
    kept.push({
      id: row.modelId,
      name: row.name?.trim() || row.modelId,
      provider: normalizeProviderId(row.provider),
    });
  }
  return kept;
}
