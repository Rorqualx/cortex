/**
 * Persisted snapshot of live model discovery results (shared state DB).
 *
 * Rows here record what a refreshable provider's /models endpoint returned for
 * THIS install, so the runtime catalog can auto-populate new models and hide
 * vanished ones without rewriting openclaw.json. Status is install-scoped and is
 * only flipped to "deprecated" after a successful, non-empty fetch — see
 * `reconcile.ts` for the diff that drives upsert vs deprecate.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  buildModelCatalogMergeKey,
  buildModelCatalogRef,
  normalizeModelCatalogProviderId,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

type DiscoveredStoreDatabase = Pick<OpenClawStateKyselyDatabase, "model_catalog_discovered">;

/** Availability of a discovered model for this install's configured endpoint. */
export type DiscoveredModelStatus = "active" | "deprecated";

/** One model id returned by a provider /models fetch, before persistence. */
export type DiscoveredModelInput = {
  modelId: string;
  /** Display label when the endpoint or caller supplies one; defaults to the id. */
  name?: string;
  /** Upstream creation timestamp (ms) when the endpoint reports it. */
  createdRemoteMs?: number;
  /** Raw endpoint entry, retained verbatim for record-keeping/debugging. */
  raw: unknown;
};

/** Read shape returned to discovery consumers (catalog merge, reconcile, CLI). */
export type DiscoveredModelRecord = {
  provider: string;
  modelId: string;
  ref: string;
  name: string | null;
  status: DiscoveredModelStatus;
  createdRemoteMs: number | null;
  lastSeenAtMs: number;
  deprecatedAtMs: number | null;
};

function getDiscoveredStoreKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<DiscoveredStoreDatabase>(db);
}

function toStatus(raw: string): DiscoveredModelStatus {
  return raw === "deprecated" ? "deprecated" : "active";
}

/** Loads discovered rows, optionally scoped to one provider, in deterministic order. */
export function listDiscoveredModels(
  db: DatabaseSync,
  opts?: { provider?: string; status?: DiscoveredModelStatus },
): DiscoveredModelRecord[] {
  let query = getDiscoveredStoreKysely(db)
    .selectFrom("model_catalog_discovered")
    .select([
      "provider",
      "model_id",
      "ref",
      "name",
      "status",
      "created_remote_ms",
      "last_seen_at_ms",
      "deprecated_at_ms",
    ]);
  const provider = opts?.provider ? normalizeModelCatalogProviderId(opts.provider) : undefined;
  if (provider) {
    query = query.where("provider", "=", provider);
  }
  if (opts?.status) {
    query = query.where("status", "=", opts.status);
  }
  query = query.orderBy("provider", "asc").orderBy("model_id", "asc");
  return executeSqliteQuerySync(db, query).rows.map((row) => ({
    provider: row.provider,
    modelId: row.model_id,
    ref: row.ref,
    name: row.name,
    status: toStatus(row.status),
    createdRemoteMs: row.created_remote_ms,
    lastSeenAtMs: row.last_seen_at_ms,
    deprecatedAtMs: row.deprecated_at_ms,
  }));
}

/**
 * Marks each discovered model active and refreshes its last-seen timestamp. A
 * model that was previously deprecated but is live again flips back to active.
 * `first_seen_at_ms` is preserved across upserts.
 */
export function upsertActiveDiscoveredModels(
  db: DatabaseSync,
  provider: string,
  models: readonly DiscoveredModelInput[],
  nowMs: number,
): void {
  const normalizedProvider = normalizeModelCatalogProviderId(provider);
  for (const model of models) {
    const modelId = model.modelId.trim();
    if (!modelId) {
      continue;
    }
    const name = model.name?.trim() || null;
    const createdRemoteMs = model.createdRemoteMs ?? null;
    const rawJson = JSON.stringify(model.raw ?? { id: modelId });
    executeSqliteQuerySync(
      db,
      getDiscoveredStoreKysely(db)
        .insertInto("model_catalog_discovered")
        .values({
          provider: normalizedProvider,
          model_id: modelId,
          ref: buildModelCatalogRef(normalizedProvider, modelId),
          merge_key: buildModelCatalogMergeKey(normalizedProvider, modelId),
          name,
          status: "active",
          created_remote_ms: createdRemoteMs,
          first_seen_at_ms: nowMs,
          last_seen_at_ms: nowMs,
          deprecated_at_ms: null,
          raw_json: rawJson,
          updated_at: nowMs,
        })
        // Re-seeing a model keeps its original first_seen and clears any prior
        // deprecation; we never overwrite first_seen_at_ms on conflict.
        .onConflict((conflict) =>
          conflict.columns(["provider", "model_id"]).doUpdateSet({
            name,
            status: "active",
            created_remote_ms: createdRemoteMs,
            last_seen_at_ms: nowMs,
            deprecated_at_ms: null,
            raw_json: rawJson,
            updated_at: nowMs,
          }),
        ),
    );
  }
}

/** Flips the given provider models to deprecated (install-scoped). No-op when empty. */
export function markDiscoveredModelsDeprecated(
  db: DatabaseSync,
  provider: string,
  modelIds: readonly string[],
  nowMs: number,
): void {
  if (modelIds.length === 0) {
    return;
  }
  const normalizedProvider = normalizeModelCatalogProviderId(provider);
  executeSqliteQuerySync(
    db,
    getDiscoveredStoreKysely(db)
      .updateTable("model_catalog_discovered")
      .set({ status: "deprecated", deprecated_at_ms: nowMs, updated_at: nowMs })
      .where("provider", "=", normalizedProvider)
      .where("model_id", "in", modelIds.map((id) => id.trim()).filter(Boolean))
      .where("status", "=", "active"),
  );
}
