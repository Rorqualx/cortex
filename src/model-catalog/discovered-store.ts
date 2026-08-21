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

/**
 * How a model was discovered. "models" = listed by the provider's GET /models;
 * "probe" = observed as the served model id in a completion response (an unlisted
 * or silently-upgraded model). Probe rows are never deprecated by the /models
 * reconcile, since /models is expected not to list them.
 */
export type DiscoveredModelSource = "models" | "probe";

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
  source: DiscoveredModelSource;
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

function toSource(raw: string): DiscoveredModelSource {
  return raw === "probe" ? "probe" : "models";
}

/** Loads discovered rows, optionally scoped to one provider, in deterministic order. */
export function listDiscoveredModels(
  db: DatabaseSync,
  opts?: { provider?: string; status?: DiscoveredModelStatus; source?: DiscoveredModelSource },
): DiscoveredModelRecord[] {
  let query = getDiscoveredStoreKysely(db)
    .selectFrom("model_catalog_discovered")
    .select([
      "provider",
      "model_id",
      "ref",
      "name",
      "status",
      "source",
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
  if (opts?.source) {
    query = query.where("source", "=", opts.source);
  }
  query = query.orderBy("provider", "asc").orderBy("model_id", "asc");
  return executeSqliteQuerySync(db, query).rows.map((row) => ({
    provider: row.provider,
    modelId: row.model_id,
    ref: row.ref,
    name: row.name,
    status: toStatus(row.status),
    source: toSource(row.source),
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
          source: "models",
          created_remote_ms: createdRemoteMs,
          first_seen_at_ms: nowMs,
          last_seen_at_ms: nowMs,
          deprecated_at_ms: null,
          raw_json: rawJson,
          updated_at: nowMs,
        })
        // Re-seeing a model keeps its original first_seen and clears any prior
        // deprecation; we never overwrite first_seen_at_ms on conflict. A model
        // now listed by /models is authoritative, so it upgrades to source=models.
        .onConflict((conflict) =>
          conflict.columns(["provider", "model_id"]).doUpdateSet({
            name,
            status: "active",
            source: "models",
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

/** A silently-upgraded model: requests for `from` are served as `to` (same provider). */
export type SilentModelUpgrade = { provider: string; from: string; to: string };

/**
 * Reads silent upgrades recorded by the served-model probe: rows whose
 * `raw_json.upgradedFrom` lists requested ids the provider answered with a
 * different served id. Used by doctor --fix to repoint pins/aliases off the
 * superseded id onto the served one. Links are scanned regardless of row
 * source: a served id that /models also lists keeps source="models", but its
 * raw_json still carries the probe-stamped upgrade link (snapshot identity).
 */
export function listSilentUpgrades(db: DatabaseSync, provider?: string): SilentModelUpgrade[] {
  let query = getDiscoveredStoreKysely(db)
    .selectFrom("model_catalog_discovered")
    .select(["provider", "model_id", "raw_json"]);
  const normalizedProvider = provider ? normalizeModelCatalogProviderId(provider) : undefined;
  if (normalizedProvider) {
    query = query.where("provider", "=", normalizedProvider);
  }
  query = query.orderBy("provider", "asc").orderBy("model_id", "asc");
  const upgrades: SilentModelUpgrade[] = [];
  const seen = new Set<string>();
  for (const row of executeSqliteQuerySync(db, query).rows) {
    let upgradedFrom: unknown;
    try {
      upgradedFrom = (JSON.parse(row.raw_json) as { upgradedFrom?: unknown }).upgradedFrom;
    } catch {
      continue;
    }
    if (!Array.isArray(upgradedFrom)) {
      continue;
    }
    for (const fromRaw of upgradedFrom) {
      const from = typeof fromRaw === "string" ? fromRaw.trim() : "";
      if (!from || from.toLowerCase() === row.model_id.toLowerCase()) {
        continue;
      }
      const key = `${row.provider}/${from.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      upgrades.push({ provider: row.provider, from, to: row.model_id });
    }
  }
  return upgrades;
}

/**
 * Records models observed as the served model id from completion responses
 * (source="probe"): unlisted or silently-upgraded models the /models list omits.
 * On conflict it refreshes last-seen/name/status but never downgrades an existing
 * source=models row to probe (the authoritative /models listing wins).
 */
export function upsertProbedServedModels(
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
          source: "probe",
          created_remote_ms: createdRemoteMs,
          first_seen_at_ms: nowMs,
          last_seen_at_ms: nowMs,
          deprecated_at_ms: null,
          raw_json: rawJson,
          updated_at: nowMs,
        })
        // Omit `source` on conflict so an existing source=models row is preserved.
        .onConflict((conflict) =>
          conflict.columns(["provider", "model_id"]).doUpdateSet({
            name,
            status: "active",
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
