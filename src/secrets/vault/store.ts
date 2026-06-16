/** SQLite-backed CRUD for vault secrets brokered to the agent at egress. */
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { decryptSecret, encryptSecret, loadOrCreateVaultKey } from "./crypto.js";

/** Whether the runtime injects silently ('auto') or prompts on first per-host use ('ask'). */
export type VaultApprovalPolicy = "auto" | "ask";

/** A saved decision for one (entry, host) pair. */
export type VaultGrantDecision = "allow-once" | "allow-always" | "deny";

/** Default header the value is injected into when an entry does not override it. */
export const DEFAULT_VAULT_HEADER_TEMPLATE = "Authorization: Bearer {{value}}";

const VALUE_PLACEHOLDER = "{{value}}";

/** Vault entry metadata. Never carries the plaintext value. */
export type VaultSecretEntry = {
  name: string;
  hostAllowlist: string[];
  headerTemplate: string;
  approvalPolicy: VaultApprovalPolicy;
  credentialType?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
};

/** Input for creating or replacing a vault entry. `value` is the plaintext to encrypt. */
export type VaultSecretInput = {
  name: string;
  value: string;
  hostAllowlist: string[];
  headerTemplate?: string;
  approvalPolicy?: VaultApprovalPolicy;
  credentialType?: string;
  description?: string;
};

export type VaultStoreOptions = OpenClawStateDatabaseOptions & { now?: number };

type VaultDatabase = Pick<OpenClawStateKyselyDatabase, "vault_secret" | "vault_secret_grant">;

function normalizeApprovalPolicy(value: string): VaultApprovalPolicy {
  return value === "auto" ? "auto" : "ask";
}

function normalizeGrantDecision(value: string): VaultGrantDecision {
  return value === "allow-always" || value === "deny" ? value : "allow-once";
}

/** Lower-case a host for case-insensitive allowlist comparison. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function parseHostAllowlist(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function rowToEntry(row: {
  name: string;
  host_allowlist_json: string;
  header_template: string;
  approval_policy: string;
  credential_type: string | null;
  description: string | null;
  created_at: number;
  updated_at: number;
}): VaultSecretEntry {
  return {
    name: row.name,
    hostAllowlist: parseHostAllowlist(row.host_allowlist_json),
    headerTemplate: row.header_template,
    approvalPolicy: normalizeApprovalPolicy(row.approval_policy),
    ...(row.credential_type ? { credentialType: row.credential_type } : {}),
    ...(row.description ? { description: row.description } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Whether a request host falls under one of the entry's allowlisted hosts. */
export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const target = normalizeHost(host);
  if (!target) {
    return false;
  }
  return allowlist.some((entry) => {
    const allowed = normalizeHost(entry);
    if (!allowed) {
      return false;
    }
    // Exact host, or a subdomain of the allowlisted host. Never a suffix match
    // on bare string (so "evil-stripe.com" does NOT match "stripe.com").
    return target === allowed || target.endsWith(`.${allowed}`);
  });
}

/** Render the injection header, splitting "Name: value-template" and filling {{value}}. */
export function renderVaultHeader(
  headerTemplate: string,
  value: string,
): { name: string; value: string } {
  const colon = headerTemplate.indexOf(":");
  if (colon === -1) {
    // Template without a header name defaults to Authorization.
    return { name: "Authorization", value: headerTemplate.split(VALUE_PLACEHOLDER).join(value) };
  }
  const name = headerTemplate.slice(0, colon).trim();
  const valueTemplate = headerTemplate.slice(colon + 1).trim();
  return { name, value: valueTemplate.split(VALUE_PLACEHOLDER).join(value) };
}

/** Create or replace a vault entry, encrypting the value before persistence. */
export function saveVaultSecret(input: VaultSecretInput, options: VaultStoreOptions = {}): void {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Vault secret name is required.");
  }
  if (input.hostAllowlist.length === 0) {
    throw new Error(`Vault secret "${name}" requires at least one allowlisted host.`);
  }
  const key = loadOrCreateVaultKey(options.env ?? process.env);
  const encrypted = encryptSecret(input.value, key);
  const now = options.now ?? Date.now();
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("vault_secret")
      .values({
        name,
        host_allowlist_json: JSON.stringify(input.hostAllowlist.map(normalizeHost)),
        header_template: input.headerTemplate?.trim() || DEFAULT_VAULT_HEADER_TEMPLATE,
        value_iv: encrypted.iv,
        value_cipher: encrypted.ciphertext,
        value_tag: encrypted.tag,
        approval_policy: input.approvalPolicy ?? "ask",
        credential_type: input.credentialType?.trim() || null,
        description: input.description?.trim() || null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("name").doUpdateSet({
          host_allowlist_json: JSON.stringify(input.hostAllowlist.map(normalizeHost)),
          header_template: input.headerTemplate?.trim() || DEFAULT_VAULT_HEADER_TEMPLATE,
          value_iv: encrypted.iv,
          value_cipher: encrypted.ciphertext,
          value_tag: encrypted.tag,
          approval_policy: input.approvalPolicy ?? "ask",
          credential_type: input.credentialType?.trim() || null,
          description: input.description?.trim() || null,
          updated_at: now,
        }),
      ),
  );
}

/** List vault entries (metadata only — values are never returned). */
export function listVaultSecrets(options: VaultStoreOptions = {}): VaultSecretEntry[] {
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    kysely
      .selectFrom("vault_secret")
      .select([
        "name",
        "host_allowlist_json",
        "header_template",
        "approval_policy",
        "credential_type",
        "description",
        "created_at",
        "updated_at",
      ])
      .orderBy("name"),
  );
  return result.rows.map(rowToEntry);
}

/** Find the entry whose allowlist matches the request host, if any. */
export function getVaultEntryForHost(
  host: string,
  options: VaultStoreOptions = {},
): VaultSecretEntry | undefined {
  return listVaultSecrets(options).find((entry) => hostMatchesAllowlist(host, entry.hostAllowlist));
}

/** Replace an entry's host allowlist. */
export function setVaultSecretHosts(
  name: string,
  hosts: string[],
  options: VaultStoreOptions = {},
): void {
  if (hosts.length === 0) {
    throw new Error(`Vault secret "${name}" requires at least one allowlisted host.`);
  }
  const now = options.now ?? Date.now();
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .updateTable("vault_secret")
      .set({ host_allowlist_json: JSON.stringify(hosts.map(normalizeHost)), updated_at: now })
      .where("name", "=", name.trim()),
  );
}

/** Delete an entry and any persisted grants for it. */
export function deleteVaultSecret(name: string, options: VaultStoreOptions = {}): void {
  const trimmed = name.trim();
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<VaultDatabase>(db);
    executeSqliteQuerySync(db, kysely.deleteFrom("vault_secret_grant").where("name", "=", trimmed));
    executeSqliteQuerySync(db, kysely.deleteFrom("vault_secret").where("name", "=", trimmed));
  }, options);
}

/**
 * Decrypt and return the plaintext value for an entry. Only the egress handler
 * calls this, at the moment of injection — the value is never persisted in
 * cleartext and never returned to list/metadata callers.
 */
export function resolveVaultSecretValue(
  name: string,
  options: VaultStoreOptions = {},
): string | undefined {
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("vault_secret")
      .select(["value_iv", "value_cipher", "value_tag"])
      .where("name", "=", name.trim()),
  );
  if (!row) {
    return undefined;
  }
  const key = loadOrCreateVaultKey(options.env ?? process.env);
  return decryptSecret({ iv: row.value_iv, ciphertext: row.value_cipher, tag: row.value_tag }, key);
}

/**
 * Build a value-free catalog of saved credentials for the model, so it knows
 * which APIs it can authenticate against. Never includes the secret value.
 */
export function describeVaultCatalogForModel(options: VaultStoreOptions = {}): string {
  const entries = listVaultSecrets(options);
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((entry) => {
    const type = entry.credentialType ? ` (${entry.credentialType})` : "";
    const desc = entry.description ? ` — ${entry.description}` : "";
    return `- ${entry.name}${type}: ${entry.hostAllowlist.join(", ")}${desc}`;
  });
  return `Saved credentials available for http_request (injected automatically by host; you never see the value):\n${lines.join("\n")}`;
}

/** Read a persisted grant decision for an (entry, host) pair, if one exists. */
export function getVaultGrant(
  name: string,
  host: string,
  options: VaultStoreOptions = {},
): VaultGrantDecision | undefined {
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("vault_secret_grant")
      .select(["decision"])
      .where("name", "=", name.trim())
      .where("host", "=", normalizeHost(host)),
  );
  return row ? normalizeGrantDecision(row.decision) : undefined;
}

/** Persist an allow-always / deny decision for an (entry, host) pair. */
export function recordVaultGrant(
  name: string,
  host: string,
  decision: VaultGrantDecision,
  options: VaultStoreOptions = {},
): void {
  const now = options.now ?? Date.now();
  const normalizedHost = normalizeHost(host);
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("vault_secret_grant")
      .values({ name: name.trim(), host: normalizedHost, decision, granted_at: now })
      .onConflict((conflict) =>
        conflict.columns(["name", "host"]).doUpdateSet({ decision, granted_at: now }),
      ),
  );
}
