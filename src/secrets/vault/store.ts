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

/** Closed discriminator for how a saved credential authenticates a request. */
export type VaultAuthKind = "bearer" | "basic" | "header" | "login";

/** Default session lifetime for the stateful 'login' kind when none is configured. */
export const DEFAULT_VAULT_SESSION_TTL_SECONDS = 1800;

/**
 * Secret material, encrypted as a JSON blob. Never returned by list/metadata —
 * only the egress handler and the login flow decrypt it at the moment of use.
 */
export type VaultSecretMaterial =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string }
  | { kind: "header"; values: Record<string, string> }
  | { kind: "login"; username: string; password: string };

/** Where the login response carries the session token (non-secret config). */
export type VaultLoginTokenSource =
  | { from: "set-cookie"; cookieName: string }
  | { from: "header"; header: string }
  | { from: "json"; path: string };

/** How the captured session token is placed on subsequent requests (non-secret config). */
export type VaultLoginTokenPlacement =
  | { as: "cookie"; cookieName: string }
  | { as: "header"; template: string };

/**
 * Non-secret config for the stateful login flow. The gateway POSTs credentials
 * to `loginUrl`, captures a token per `extract`, and replays it per `place`.
 * `bodyTemplate` placeholders: {{username}} {{password}} {{basic}} (base64
 * user:pass) {{basicRaw}} (user:pass). Credentials live in encrypted material,
 * never here.
 */
export type VaultLoginConfig = {
  loginUrl: string;
  method?: "POST" | "GET";
  bodyTemplate: string;
  contentType?: string;
  extraHeaders?: Record<string, string>;
  extract: VaultLoginTokenSource;
  place: VaultLoginTokenPlacement;
  ttlSeconds?: number;
};

/** Clear, value-free config describing how an entry authenticates. */
export type VaultAuthConfig =
  | { kind: "bearer" }
  | { kind: "basic" }
  | { kind: "header"; headers: string[] }
  | { kind: "login"; login: VaultLoginConfig };

/** Vault entry metadata. Never carries secret material. */
export type VaultSecretEntry = {
  name: string;
  hostAllowlist: string[];
  approvalPolicy: VaultApprovalPolicy;
  authKind: VaultAuthKind;
  authConfig: VaultAuthConfig;
  description?: string;
  createdAt: number;
  updatedAt: number;
};

type VaultSecretInputCommon = {
  name: string;
  hostAllowlist: string[];
  approvalPolicy?: VaultApprovalPolicy;
  description?: string;
};

/** Input for creating or replacing a vault entry. Secret fields are encrypted on save. */
export type VaultSecretInput = VaultSecretInputCommon &
  (
    | { authKind: "bearer"; token: string }
    | { authKind: "basic"; username: string; password: string }
    | { authKind: "header"; headers: { name: string; value: string }[] }
    | { authKind: "login"; username: string; password: string; login: VaultLoginConfig }
  );

export type VaultStoreOptions = OpenClawStateDatabaseOptions & { now?: number };

type VaultDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "vault_secret" | "vault_secret_grant" | "vault_session"
>;

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

function normalizeAuthKind(value: string): VaultAuthKind {
  return value === "basic" || value === "header" || value === "login" ? value : "bearer";
}

/**
 * Parse the clear auth config. Falls back to the bare `{kind}` shape for
 * bearer/basic (whose config carries no extra fields) so a row that only set
 * auth_kind still yields a well-formed config.
 */
function parseAuthConfig(authKind: VaultAuthKind, json: string): VaultAuthConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = undefined;
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (authKind === "header") {
    const headers = Array.isArray(record.headers)
      ? record.headers.filter((name): name is string => typeof name === "string")
      : [];
    return { kind: "header", headers };
  }
  if (authKind === "login") {
    return { kind: "login", login: record.login as VaultLoginConfig };
  }
  return { kind: authKind };
}

function rowToEntry(row: {
  name: string;
  host_allowlist_json: string;
  approval_policy: string;
  auth_kind: string;
  auth_config_json: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}): VaultSecretEntry {
  const authKind = normalizeAuthKind(row.auth_kind);
  return {
    name: row.name,
    hostAllowlist: parseHostAllowlist(row.host_allowlist_json),
    approvalPolicy: normalizeApprovalPolicy(row.approval_policy),
    authKind,
    authConfig: parseAuthConfig(authKind, row.auth_config_json),
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

/** Base64-encode `username:password` for an HTTP Basic Authorization header. */
export function encodeBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

/**
 * Build the header(s) to inject for the stateless auth kinds. The 'login' kind
 * is stateful (a network round trip) and is resolved separately, so it returns
 * no headers here.
 */
export function buildAuthHeaders(
  material: VaultSecretMaterial,
  config: VaultAuthConfig,
): { name: string; value: string }[] {
  switch (material.kind) {
    case "bearer":
      return [{ name: "Authorization", value: `Bearer ${material.token}` }];
    case "basic":
      return [
        {
          name: "Authorization",
          value: `Basic ${encodeBasicAuth(material.username, material.password)}`,
        },
      ];
    case "header": {
      // Emit headers in the saved order so injection is deterministic.
      const order = config.kind === "header" ? config.headers : Object.keys(material.values);
      return order
        .filter((name) => material.values[name] !== undefined)
        .map((name) => ({ name, value: material.values[name] }));
    }
    case "login":
      return [];
    default: {
      const exhaustive: never = material;
      return exhaustive;
    }
  }
}

/** Derive stored material + clear config from a save input. */
function splitInput(input: VaultSecretInput): {
  material: VaultSecretMaterial;
  config: VaultAuthConfig;
} {
  switch (input.authKind) {
    case "bearer":
      return { material: { kind: "bearer", token: input.token }, config: { kind: "bearer" } };
    case "basic":
      return {
        material: { kind: "basic", username: input.username, password: input.password },
        config: { kind: "basic" },
      };
    case "header": {
      const values: Record<string, string> = {};
      const headers: string[] = [];
      for (const header of input.headers) {
        const name = header.name.trim();
        if (!name) {
          continue;
        }
        values[name] = header.value;
        headers.push(name);
      }
      if (headers.length === 0) {
        throw new Error(`Vault secret "${input.name}" requires at least one header.`);
      }
      return { material: { kind: "header", values }, config: { kind: "header", headers } };
    }
    case "login":
      return {
        material: { kind: "login", username: input.username, password: input.password },
        config: { kind: "login", login: input.login },
      };
    default: {
      const exhaustive: never = input;
      return exhaustive;
    }
  }
}

/** Create or replace a vault entry, encrypting secret material before persistence. */
export function saveVaultSecret(input: VaultSecretInput, options: VaultStoreOptions = {}): void {
  const name = input.name.trim();
  if (!name) {
    throw new Error("Vault secret name is required.");
  }
  if (input.hostAllowlist.length === 0) {
    throw new Error(`Vault secret "${name}" requires at least one allowlisted host.`);
  }
  const { material, config } = splitInput(input);
  const key = loadOrCreateVaultKey(options.env ?? process.env);
  const encrypted = encryptSecret(JSON.stringify(material), key);
  const now = options.now ?? Date.now();
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  const values = {
    name,
    host_allowlist_json: JSON.stringify(input.hostAllowlist.map(normalizeHost)),
    // Retired column kept non-null for pre-migration DBs whose header_template is
    // NOT NULL; canonical readers ignore it (auth_kind/auth_config_json own this).
    header_template: "",
    value_iv: encrypted.iv,
    value_cipher: encrypted.ciphertext,
    value_tag: encrypted.tag,
    approval_policy: input.approvalPolicy ?? "ask",
    auth_kind: input.authKind,
    auth_config_json: JSON.stringify(config),
    credential_type: null,
    description: input.description?.trim() || null,
    created_at: now,
    updated_at: now,
  };
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("vault_secret")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("name").doUpdateSet({
          host_allowlist_json: values.host_allowlist_json,
          header_template: "",
          value_iv: values.value_iv,
          value_cipher: values.value_cipher,
          value_tag: values.value_tag,
          approval_policy: values.approval_policy,
          auth_kind: values.auth_kind,
          auth_config_json: values.auth_config_json,
          credential_type: null,
          description: values.description,
          updated_at: now,
        }),
      ),
  );
}

const ENTRY_COLUMNS = [
  "name",
  "host_allowlist_json",
  "approval_policy",
  "auth_kind",
  "auth_config_json",
  "description",
  "created_at",
  "updated_at",
] as const;

/** List vault entries (metadata only — secret material is never returned). */
export function listVaultSecrets(options: VaultStoreOptions = {}): VaultSecretEntry[] {
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    kysely.selectFrom("vault_secret").select(ENTRY_COLUMNS).orderBy("name"),
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

/** Delete an entry and any persisted grants and cached sessions for it. */
export function deleteVaultSecret(name: string, options: VaultStoreOptions = {}): void {
  const trimmed = name.trim();
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<VaultDatabase>(db);
    executeSqliteQuerySync(db, kysely.deleteFrom("vault_secret_grant").where("name", "=", trimmed));
    executeSqliteQuerySync(db, kysely.deleteFrom("vault_session").where("name", "=", trimmed));
    executeSqliteQuerySync(db, kysely.deleteFrom("vault_secret").where("name", "=", trimmed));
  }, options);
}

/**
 * Decrypt and return the secret material for an entry. Only the egress handler
 * and login flow call this, at the moment of use — material is never persisted
 * in cleartext and never returned to list/metadata callers.
 */
export function resolveVaultSecretMaterial(
  name: string,
  options: VaultStoreOptions = {},
): VaultSecretMaterial | undefined {
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
  const plaintext = decryptSecret(
    { iv: row.value_iv, ciphertext: row.value_cipher, tag: row.value_tag },
    key,
  );
  try {
    return JSON.parse(plaintext) as VaultSecretMaterial;
  } catch {
    return undefined;
  }
}

/**
 * Read a cached, non-expired session token for the stateful login kind.
 * Returns undefined when absent or expired so the caller re-authenticates.
 */
export function getVaultSession(
  name: string,
  host: string,
  options: VaultStoreOptions = {},
): string | undefined {
  const now = options.now ?? Date.now();
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("vault_session")
      .select(["token_iv", "token_cipher", "token_tag", "expires_at"])
      .where("name", "=", name.trim())
      .where("host", "=", normalizeHost(host)),
  );
  if (!row || row.expires_at <= now) {
    return undefined;
  }
  const key = loadOrCreateVaultKey(options.env ?? process.env);
  return decryptSecret({ iv: row.token_iv, ciphertext: row.token_cipher, tag: row.token_tag }, key);
}

/** Encrypt and cache a session token for an (entry, host) pair with a TTL. */
export function saveVaultSession(
  name: string,
  host: string,
  token: string,
  expiresAt: number,
  options: VaultStoreOptions = {},
): void {
  const now = options.now ?? Date.now();
  const normalizedHost = normalizeHost(host);
  const key = loadOrCreateVaultKey(options.env ?? process.env);
  const encrypted = encryptSecret(token, key);
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("vault_session")
      .values({
        name: name.trim(),
        host: normalizedHost,
        token_iv: encrypted.iv,
        token_cipher: encrypted.ciphertext,
        token_tag: encrypted.tag,
        expires_at: expiresAt,
        created_at: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["name", "host"]).doUpdateSet({
          token_iv: encrypted.iv,
          token_cipher: encrypted.ciphertext,
          token_tag: encrypted.tag,
          expires_at: expiresAt,
          created_at: now,
        }),
      ),
  );
}

/** Drop the cached session for an (entry, host) pair (e.g. after a 401). */
export function deleteVaultSession(
  name: string,
  host: string,
  options: VaultStoreOptions = {},
): void {
  const { db } = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<VaultDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("vault_session")
      .where("name", "=", name.trim())
      .where("host", "=", normalizeHost(host)),
  );
}

/**
 * Build a value-free catalog of saved credentials for the model, so it knows
 * which APIs it can authenticate against. Never includes secret material.
 */
export function describeVaultCatalogForModel(options: VaultStoreOptions = {}): string {
  const entries = listVaultSecrets(options);
  if (entries.length === 0) {
    return "";
  }
  const lines = entries.map((entry) => {
    const desc = entry.description ? ` — ${entry.description}` : "";
    return `- ${entry.name} (${entry.authKind}): ${entry.hostAllowlist.join(", ")}${desc}`;
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
