import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { asFiniteNumber, asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { estimateAcpEventRowBytes, estimateAcpSessionRowBytes } from "../acp/event-ledger-bytes.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { compactLegacyDeliveryQueueFailures } from "./openclaw-state-db-delivery-queue-backfill.js";
import * as operatorApprovalMigration from "./openclaw-state-db-operator-approval-migration.js";
import { decryptSecret, encryptSecret, loadOrCreateVaultKey } from "../secrets/vault/crypto.js";
import { ensureColumn, tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";

export function ensureOperatorApprovalResolutionRefs(db: DatabaseSync): void {
  if (!tableExists(db, "operator_approvals")) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    ensureColumn(db, "operator_approvals", "resolution_ref TEXT");
    const rows = db
      .prepare("SELECT approval_id, kind, resolution_ref FROM operator_approvals")
      .all() as Array<{
      approval_id?: unknown;
      kind?: unknown;
      resolution_ref?: unknown;
    }>;
    const update = db.prepare(
      "UPDATE operator_approvals SET resolution_ref = ? WHERE approval_id = ?",
    );
    for (const row of rows) {
      if (
        typeof row.approval_id !== "string" ||
        !operatorApprovalMigration.isCanonicalOperatorApprovalKind(row.kind)
      ) {
        throw new Error("operator approval row cannot be assigned a transport reference");
      }
      const resolutionRef = buildApprovalResolutionRef({
        approvalId: row.approval_id,
        approvalKind: row.kind,
      });
      if (row.resolution_ref !== resolutionRef) {
        update.run(resolutionRef, row.approval_id);
      }
    }
    const namespaceConflict = db
      .prepare(
        `SELECT canonical.approval_id
         FROM operator_approvals AS canonical
         JOIN operator_approvals AS referenced
           ON canonical.approval_id = referenced.resolution_ref
         WHERE canonical.approval_id <> referenced.approval_id
         LIMIT 1`,
      )
      .get();
    if (namespaceConflict) {
      throw new Error("operator approval ids conflict with durable transport references");
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_approvals_resolution_ref
        ON operator_approvals(resolution_ref);
    `);
  });
}

type LegacyRetainedResultRow = {
  run_id: string;
  payload_json: string;
  pending_final_delivery_payload_json?: string | null;
};

function nullableTextValue(record: Record<string, unknown> | null, key: string) {
  if (!record || !Object.hasOwn(record, key)) {
    return undefined;
  }
  const value = record[key];
  return typeof value === "string" || value === null ? value : undefined;
}

/** Promote shipped retained results before runtime hydrates canonical subagent state. */
export function repairLegacySubagentRetainedResults(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  const repair = () => {
    const hasLegacyPendingPayload = tableHasColumn(
      db,
      "subagent_runs",
      "pending_final_delivery_payload_json",
    );
    const rows = db
      .prepare(
        hasLegacyPendingPayload
          ? "SELECT run_id, payload_json, pending_final_delivery_payload_json FROM subagent_runs"
          : "SELECT run_id, payload_json FROM subagent_runs",
      )
      .all() as LegacyRetainedResultRow[];
    const updateRun = db.prepare(
      `UPDATE subagent_runs
          SET payload_json = ?
        WHERE run_id = ?`,
    );
    for (const row of rows) {
      const stored = safeParseJsonRecord(row.payload_json) ?? null;
      const parent = stored ? asNullableRecord(stored.parentCompletion) : null;
      const payload = parent?.completionTarget === "parent" ? parent : stored;
      const completion = payload ? asNullableRecord(payload.completion) : null;
      if (!payload || !completion) {
        continue;
      }
      const delivery = asNullableRecord(payload.delivery);
      const deliveryPayload = delivery ? asNullableRecord(delivery.payload) : null;
      const pendingPayload = row.pending_final_delivery_payload_json
        ? (safeParseJsonRecord(row.pending_final_delivery_payload_json) ?? null)
        : null;
      const hasLegacyResult = Boolean(
        (deliveryPayload &&
          (Object.hasOwn(deliveryPayload, "frozenResultText") ||
            Object.hasOwn(deliveryPayload, "fallbackFrozenResultText"))) ||
        (pendingPayload &&
          (Object.hasOwn(pendingPayload, "frozenResultText") ||
            Object.hasOwn(pendingPayload, "fallbackFrozenResultText"))),
      );
      if (!hasLegacyResult) {
        continue;
      }
      const legacyPrimary =
        nullableTextValue(deliveryPayload, "frozenResultText") ??
        nullableTextValue(pendingPayload, "frozenResultText");
      const legacyFallback =
        nullableTextValue(deliveryPayload, "fallbackFrozenResultText") ??
        nullableTextValue(pendingPayload, "fallbackFrozenResultText");
      if (nullableTextValue(completion, "resultText") == null && legacyPrimary !== undefined) {
        completion.resultText = legacyPrimary;
      }
      if (
        nullableTextValue(completion, "fallbackResultText") == null &&
        legacyFallback !== undefined
      ) {
        completion.fallbackResultText = legacyFallback;
      }
      delete deliveryPayload?.frozenResultText;
      delete deliveryPayload?.fallbackFrozenResultText;
      updateRun.run(JSON.stringify(stored), row.run_id);
    }
  };
  if (db.isTransaction) {
    repair();
    return;
  }
  runSqliteImmediateTransactionSync(db, repair);
}

/** Canonicalize shipped subagent rows whose pause/kill owner only wrote root terminal fields. */
export function repairLegacySubagentExecutionPayloads(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  db.exec(`
    UPDATE subagent_runs
    SET payload_json = json_remove(
      CASE
        WHEN json_extract(payload_json, '$.pauseReason') = 'sessions_yield'
          AND json_extract(payload_json, '$.execution.status') <> 'terminal'
          AND json_type(payload_json, '$.endedAt') IN ('integer', 'real')
        THEN json_remove(json_set(
          payload_json,
          '$.execution.status', 'terminal',
          '$.execution.endedAt', json_extract(payload_json, '$.endedAt')
        ), '$.execution.outcome')
        WHEN (json_type(payload_json, '$.killReconciliation') = 'object'
          OR json_extract(payload_json, '$.endedReason') = 'subagent-killed')
          AND json_extract(payload_json, '$.execution.status') <> 'terminal'
          AND json_type(payload_json, '$.endedAt') IN ('integer', 'real')
          AND json_type(payload_json, '$.outcome') = 'object'
        THEN json_set(
          payload_json,
          '$.execution.status', 'terminal',
          '$.execution.endedAt', json_extract(payload_json, '$.endedAt'),
          '$.execution.outcome', json_extract(payload_json, '$.outcome')
        )
        ELSE payload_json
      END,
      '$.startedAt', '$.endedAt', '$.outcome'
    )
    WHERE json_valid(payload_json)
      AND (json_type(payload_json, '$.startedAt') IS NOT NULL
        OR json_type(payload_json, '$.endedAt') IS NOT NULL
        OR json_type(payload_json, '$.outcome') IS NOT NULL);
  `);
}

/** Canonicalize the shipped suspension reason before runtime hydrates subagent state. */
export function repairLegacySubagentSuspensionReasons(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) {
    return;
  }
  // v2026.6.34 persisted retry-limit; remove this backfill after its 7-day retention window.
  db.exec(`
    UPDATE subagent_runs
    SET payload_json = json_set(payload_json, '$.delivery.suspendedReason', 'permanent_failure')
    WHERE json_valid(payload_json)
      AND json_extract(payload_json, '$.delivery.suspendedReason') = 'retry-limit';
  `);
}

export function backfillAcpReplayEstimatedBytes(db: DatabaseSync): void {
  if (
    !tableExists(db, "acp_replay_events") ||
    !tableHasColumn(db, "acp_replay_events", "estimated_bytes")
  ) {
    return;
  }
  // The schema/Doctor owner holds the transaction. Stream canonical text in Node
  // so UTF-16 databases, NUL and existing JSON formatting use the writer's units.
  const replayDb =
    getNodeSqliteKysely<
      Pick<OpenClawStateKyselyDatabase, "acp_replay_events" | "acp_replay_sessions">
    >(db);
  const updateEvent = db.prepare(
    "UPDATE acp_replay_events SET estimated_bytes = ? WHERE session_id = ? AND seq = ?",
  );
  for (const row of iterateSqliteQuerySync(
    db,
    replayDb
      .selectFrom("acp_replay_events")
      .select(["session_id", "seq", "session_key", "run_id", "update_json", "estimated_bytes"]),
  )) {
    const expected = estimateAcpEventRowBytes({
      sessionId: row.session_id,
      sessionKey: row.session_key,
      runId: row.run_id,
      updateJson: row.update_json,
    });
    if (sqliteNumber(row.estimated_bytes) !== expected) {
      updateEvent.run(expected, row.session_id, row.seq);
    }
  }
  const updateSession = db.prepare(
    "UPDATE acp_replay_sessions SET estimated_bytes = ? WHERE session_id = ?",
  );
  for (const row of iterateSqliteQuerySync(
    db,
    replayDb
      .selectFrom("acp_replay_sessions as s")
      .select(["s.session_id", "s.session_key", "s.cwd", "s.estimated_bytes"])
      .select((eb) =>
        eb.fn
          .coalesce(
            eb
              .selectFrom("acp_replay_events as e")
              .select((events) => events.fn.sum<number>("e.estimated_bytes").as("total"))
              .whereRef("e.session_id", "=", "s.session_id"),
            eb.val(0),
          )
          .as("event_bytes"),
      ),
  )) {
    const expected =
      estimateAcpSessionRowBytes({
        sessionId: row.session_id,
        sessionKey: row.session_key,
        cwd: row.cwd,
      }) + sqliteNumber(row.event_bytes);
    if (sqliteNumber(row.estimated_bytes) !== expected) {
      updateSession.run(expected, row.session_id);
    }
  }
}

export function backfillCronRunLogEntryJson(db: DatabaseSync): void {
  if (!tableExists(db, "cron_run_logs") || !tableHasColumn(db, "cron_run_logs", "entry_json")) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, seq, ts
         FROM cron_run_logs
        WHERE entry_json = '{}'`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    seq: number | bigint;
    ts: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_run_logs
        SET entry_json = ?
      WHERE store_key = ? AND job_id = ? AND seq = ?`,
  );
  for (const row of rows) {
    update.run(
      JSON.stringify({ ts: sqliteNumber(row.ts), jobId: row.job_id, action: "finished" }),
      row.store_key,
      row.job_id,
      row.seq,
    );
  }
}

function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function backfillCronJobsFromJobJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "cron_jobs") ||
    !tableHasColumn(db, "cron_jobs", "job_json") ||
    !tableHasColumn(db, "cron_jobs", "payload_kind")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT store_key, job_id, job_json, updated_at
         FROM cron_jobs
        WHERE payload_kind = 'message'
           OR name = ''`,
    )
    .all() as Array<{
    store_key: string;
    job_id: string;
    job_json: string;
    updated_at: number | bigint;
  }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE cron_jobs
        SET name = ?,
            enabled = ?,
            agent_id = ?,
            payload_kind = ?,
            runtime_updated_at_ms = ?
      WHERE store_key = ?
        AND job_id = ?`,
  );
  for (const row of rows) {
    const job = safeParseJsonRecord(row.job_json) ?? null;
    if (!job) {
      continue;
    }
    // Legacy defaults are repaired only in the query-bearing projection; job_json owns config.
    const schedule = asNullableRecord(job.schedule);
    const payload = asNullableRecord(job.payload);
    const scheduleKind = textField(schedule ?? {}, "kind");
    const payloadKind = textField(payload ?? {}, "kind");
    const isAt = scheduleKind === "at" && textField(schedule ?? {}, "at");
    const isEvery = scheduleKind === "every" && asFiniteNumber((schedule ?? {}).everyMs) != null;
    const isCron = scheduleKind === "cron" && textField(schedule ?? {}, "expr");
    const isSystemEvent = payloadKind === "systemEvent" && textField(payload ?? {}, "text");
    const isAgentTurn = payloadKind === "agentTurn" && textField(payload ?? {}, "message");
    if (
      !schedule ||
      !payload ||
      (!isAt && !isEvery && !isCron) ||
      (!isSystemEvent && !isAgentTurn)
    ) {
      continue;
    }
    update.run(
      textField(job, "name") ?? row.job_id,
      job.enabled === false ? 0 : 1,
      textField(job, "agentId"),
      payloadKind,
      asFiniteNumber(job.updatedAtMs) ?? (sqliteNumber(row.updated_at) || 0),
      row.store_key,
      row.job_id,
    );
  }
}

export function backfillDeliveryQueueEntriesFromEntryJson(db: DatabaseSync): void {
  if (
    !tableExists(db, "delivery_queue_entries") ||
    !tableHasColumn(db, "delivery_queue_entries", "entry_json") ||
    !tableHasColumn(db, "delivery_queue_entries", "retry_count")
  ) {
    return;
  }
  compactLegacyDeliveryQueueFailures(db);
  const rows = db
    .prepare(
      `SELECT queue_name, id, entry_json
         FROM delivery_queue_entries
        WHERE status = 'pending'
          AND (retry_count = 0
            OR last_attempt_at IS NULL
            OR last_error IS NULL
            OR recovery_state IS NULL
            OR platform_send_started_at IS NULL
            OR entry_kind IS NULL
            OR session_key IS NULL
            OR channel IS NULL
            OR target IS NULL
            OR account_id IS NULL)`,
    )
    .all() as Array<{ queue_name: string; id: string; entry_json: string }>;
  if (rows.length === 0) {
    return;
  }
  const update = db.prepare(
    `UPDATE delivery_queue_entries
        SET entry_kind = COALESCE(?, entry_kind),
            session_key = COALESCE(?, session_key),
            channel = COALESCE(?, channel),
            target = COALESCE(?, target),
            account_id = COALESCE(?, account_id),
            retry_count = ?,
            last_attempt_at = COALESCE(?, last_attempt_at),
            last_error = COALESCE(?, last_error),
            recovery_state = COALESCE(?, recovery_state),
            platform_send_started_at = COALESCE(?, platform_send_started_at)
      WHERE queue_name = ?
        AND id = ?`,
  );
  for (const row of rows) {
    const entry = safeParseJsonRecord(row.entry_json) ?? null;
    if (!entry) {
      continue;
    }
    // Queue metadata is denormalized for recovery queries but entry_json remains source of truth.
    const session = asNullableRecord(entry.session);
    const route = asNullableRecord(entry.route);
    const deliveryContext = asNullableRecord(entry.deliveryContext);
    update.run(
      textField(entry, "kind"),
      textField(entry, "sessionKey") ?? (session ? textField(session, "key") : null),
      textField(entry, "channel") ??
        (route ? textField(route, "channel") : null) ??
        (deliveryContext ? textField(deliveryContext, "channel") : null),
      textField(entry, "to") ??
        (route ? textField(route, "to") : null) ??
        (deliveryContext ? textField(deliveryContext, "to") : null),
      textField(entry, "accountId") ??
        (route ? textField(route, "accountId") : null) ??
        (deliveryContext ? textField(deliveryContext, "accountId") : null),
      asSafeIntegerInRange(entry.retryCount, { min: 0 }) ?? 0,
      asSafeIntegerInRange(entry.lastAttemptAt, { min: 0 }) ?? null,
      textField(entry, "lastError"),
      textField(entry, "recoveryState"),
      asSafeIntegerInRange(entry.platformSendStartedAt, { min: 0 }) ?? null,
      row.queue_name,
      row.id,
    );
  }
}

// The caller owns the state.schema.ensure transaction so every probe, DDL
// change, and backfill observes one authoritative schema across processes.

const DEFAULT_LEGACY_VAULT_HEADER_TEMPLATE = "Authorization: Bearer {{value}}";

/**
 * Map a pre-auth_kind vault row (raw secret string + "Header: tmpl" string) to
 * canonical material + clear config. Lossless: the default bearer template
 * becomes a bearer token; any other template becomes a single fixed header
 * carrying the exact value that was injected before.
 */
function legacyVaultMaterial(
  headerTemplate: string,
  value: string,
): { authKind: string; material: Record<string, unknown>; config: Record<string, unknown> } {
  const template = headerTemplate.trim() || DEFAULT_LEGACY_VAULT_HEADER_TEMPLATE;
  if (template === DEFAULT_LEGACY_VAULT_HEADER_TEMPLATE) {
    return {
      authKind: "bearer",
      material: { kind: "bearer", token: value },
      config: { kind: "bearer" },
    };
  }
  const colon = template.indexOf(":");
  const name = colon === -1 ? "Authorization" : template.slice(0, colon).trim() || "Authorization";
  const valueTemplate = colon === -1 ? template : template.slice(colon + 1).trim();
  const rendered = valueTemplate.split("{{value}}").join(value);
  return {
    authKind: "header",
    material: { kind: "header", values: { [name]: rendered } },
    config: { kind: "header", headers: [name] },
  };
}

/**
 * Re-encrypt legacy vault rows (raw value blob + header_template) into the
 * canonical auth_kind/auth_config_json + JSON material shape so runtime never
 * reads the old shape. Idempotent: rows are selected only while their
 * auth_config_json is still the column default ('{}'), so re-running is a no-op.
 * Runs at boot (not just doctor) so an existing saved credential keeps working
 * across the upgrade without a manual repair step.
 */
export function backfillVaultAuthKinds(db: DatabaseSync, env: NodeJS.ProcessEnv): void {
  if (
    !tableExists(db, "vault_secret") ||
    !tableHasColumn(db, "vault_secret", "auth_config_json") ||
    !tableHasColumn(db, "vault_secret", "header_template")
  ) {
    return;
  }
  const rows = db
    .prepare(
      `SELECT name, header_template, value_iv, value_cipher, value_tag
         FROM vault_secret
        WHERE auth_config_json = '{}'`,
    )
    .all() as Array<{
    name: string;
    header_template: string | null;
    value_iv: string;
    value_cipher: string;
    value_tag: string;
  }>;
  if (rows.length === 0) {
    return;
  }
  let key: Buffer;
  try {
    key = loadOrCreateVaultKey(env);
  } catch {
    // Key unavailable (e.g. permissions) — leave rows for a later run/doctor.
    return;
  }
  const update = db.prepare(
    `UPDATE vault_secret
        SET auth_kind = ?, auth_config_json = ?, value_iv = ?, value_cipher = ?, value_tag = ?
      WHERE name = ?`,
  );
  for (const row of rows) {
    let plaintext: string;
    try {
      plaintext = decryptSecret(
        { iv: row.value_iv, ciphertext: row.value_cipher, tag: row.value_tag },
        key,
      );
    } catch {
      continue; // tampered / wrong key — skip rather than corrupt the row.
    }
    // No "already JSON" guard: the WHERE auth_config_json = '{}' filter already
    // selects only unmigrated rows (migrated rows carry a non-'{}' config), so a
    // legacy raw value that happens to be JSON is still migrated correctly.
    const migrated = legacyVaultMaterial(row.header_template ?? "", plaintext);
    const encrypted = encryptSecret(JSON.stringify(migrated.material), key);
    update.run(
      migrated.authKind,
      JSON.stringify(migrated.config),
      encrypted.iv,
      encrypted.ciphertext,
      encrypted.tag,
      row.name,
    );
  }
}
