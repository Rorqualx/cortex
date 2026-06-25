import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { encryptSecret, loadOrCreateVaultKey } from "./crypto.js";
import {
  buildAuthHeaders,
  deleteVaultSecret,
  deleteVaultSession,
  encodeBasicAuth,
  getVaultEntryForHost,
  getVaultGrant,
  getVaultSession,
  hostMatchesAllowlist,
  listVaultSecrets,
  recordVaultGrant,
  resolveVaultSecretMaterial,
  saveVaultSecret,
  saveVaultSession,
  setVaultSecretHosts,
} from "./store.js";

describe("vault store", () => {
  let stateDir: string;
  let options: { env: NodeJS.ProcessEnv };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vault-store-"));
    options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("saves an entry without exposing secret material in metadata", () => {
    saveVaultSecret(
      {
        name: "stripe",
        authKind: "bearer",
        token: "sk_live_123",
        hostAllowlist: ["api.stripe.com"],
      },
      options,
    );
    const entries = listVaultSecrets(options);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "stripe",
      hostAllowlist: ["api.stripe.com"],
      approvalPolicy: "ask",
      authKind: "bearer",
    });
    expect(JSON.stringify(entries[0])).not.toContain("sk_live_123");
  });

  it("resolves material only via the explicit resolve call, never in the list", () => {
    saveVaultSecret(
      {
        name: "router",
        authKind: "basic",
        username: "admin",
        password: "hunter2",
        hostAllowlist: ["api.example.com"],
      },
      options,
    );
    const material = resolveVaultSecretMaterial("router", options);
    expect(material).toEqual({ kind: "basic", username: "admin", password: "hunter2" });
    expect(resolveVaultSecretMaterial("missing", options)).toBeUndefined();
    expect(JSON.stringify(listVaultSecrets(options))).not.toContain("hunter2");
  });

  it("stores ordered header values and never leaks them in metadata", () => {
    saveVaultSecret(
      {
        name: "multi",
        authKind: "header",
        headers: [
          { name: "X-Api-Key", value: "key-abc" },
          { name: "X-Account", value: "acct-9" },
        ],
        hostAllowlist: ["api.example.com"],
      },
      options,
    );
    const entry = listVaultSecrets(options)[0];
    expect(entry.authKind).toBe("header");
    expect(entry.authConfig).toEqual({ kind: "header", headers: ["X-Api-Key", "X-Account"] });
    expect(JSON.stringify(entry)).not.toContain("key-abc");
    const material = resolveVaultSecretMaterial("multi", options);
    expect(material).toEqual({
      kind: "header",
      values: { "X-Api-Key": "key-abc", "X-Account": "acct-9" },
    });
  });

  it("stores login config (non-secret) but keeps credentials in material", () => {
    saveVaultSecret(
      {
        name: "asus",
        authKind: "login",
        username: "admin",
        password: "routerpass",
        hostAllowlist: ["192.168.50.1"],
        login: {
          loginUrl: "http://192.168.50.1/login.cgi",
          bodyTemplate: "login_authorization={{basic}}",
          extract: { from: "set-cookie", cookieName: "asus_token" },
          place: { as: "cookie", cookieName: "asus_token" },
        },
      },
      options,
    );
    const entry = listVaultSecrets(options)[0];
    expect(entry.authKind).toBe("login");
    expect(entry.authConfig).toMatchObject({
      kind: "login",
      login: { loginUrl: "http://192.168.50.1/login.cgi" },
    });
    expect(JSON.stringify(entry)).not.toContain("routerpass");
    expect(resolveVaultSecretMaterial("asus", options)).toEqual({
      kind: "login",
      username: "admin",
      password: "routerpass",
    });
  });

  it("builds the right headers per auth kind", () => {
    expect(buildAuthHeaders({ kind: "bearer", token: "abc" }, { kind: "bearer" })).toEqual([
      { name: "Authorization", value: "Bearer abc" },
    ]);
    expect(
      buildAuthHeaders({ kind: "basic", username: "u", password: "p" }, { kind: "basic" }),
    ).toEqual([{ name: "Authorization", value: `Basic ${encodeBasicAuth("u", "p")}` }]);
    // Basic encoding is exactly base64(user:pass).
    expect(encodeBasicAuth("admin", "hunter2")).toBe(
      Buffer.from("admin:hunter2").toString("base64"),
    );
    expect(
      buildAuthHeaders(
        { kind: "header", values: { B: "2", A: "1" } },
        { kind: "header", headers: ["A", "B"] },
      ),
    ).toEqual([
      { name: "A", value: "1" },
      { name: "B", value: "2" },
    ]);
    expect(
      buildAuthHeaders(
        { kind: "login", username: "u", password: "p" },
        { kind: "login", login: {} as never },
      ),
    ).toEqual([]);
  });

  it("matches hosts exactly and by subdomain but not by bare suffix", () => {
    expect(hostMatchesAllowlist("api.stripe.com", ["api.stripe.com"])).toBe(true);
    expect(hostMatchesAllowlist("API.Stripe.com", ["api.stripe.com"])).toBe(true);
    expect(hostMatchesAllowlist("eu.api.stripe.com", ["stripe.com"])).toBe(true);
    expect(hostMatchesAllowlist("evil-stripe.com", ["stripe.com"])).toBe(false);
    expect(hostMatchesAllowlist("stripe.com.evil.com", ["stripe.com"])).toBe(false);
  });

  it("finds an entry for a matching host and none for a mismatch", () => {
    saveVaultSecret(
      {
        name: "stripe",
        authKind: "bearer",
        token: "sk_live_123",
        hostAllowlist: ["api.stripe.com"],
      },
      options,
    );
    expect(getVaultEntryForHost("api.stripe.com", options)?.name).toBe("stripe");
    expect(getVaultEntryForHost("evil.com", options)).toBeUndefined();
  });

  it("updates hosts and persists/looks up grants", () => {
    saveVaultSecret(
      {
        name: "stripe",
        authKind: "bearer",
        token: "sk_live_123",
        hostAllowlist: ["api.stripe.com"],
      },
      options,
    );
    setVaultSecretHosts("stripe", ["api.stripe.com", "files.stripe.com"], options);
    expect(getVaultEntryForHost("files.stripe.com", options)?.name).toBe("stripe");

    expect(getVaultGrant("stripe", "api.stripe.com", options)).toBeUndefined();
    recordVaultGrant("stripe", "api.stripe.com", "allow-always", options);
    expect(getVaultGrant("stripe", "api.stripe.com", options)).toBe("allow-always");
  });

  it("caches, reads, expires, and clears session tokens", () => {
    const now = 1_000_000;
    saveVaultSession("asus", "192.168.50.1", "TOKEN-1", now + 1000, { ...options, now });
    expect(getVaultSession("asus", "192.168.50.1", { ...options, now: now + 500 })).toBe("TOKEN-1");
    // Expired sessions read back as undefined.
    expect(
      getVaultSession("asus", "192.168.50.1", { ...options, now: now + 2000 }),
    ).toBeUndefined();
    deleteVaultSession("asus", "192.168.50.1", options);
    expect(getVaultSession("asus", "192.168.50.1", { ...options, now: now + 500 })).toBeUndefined();
  });

  it("deletes an entry, its grants, and its sessions", () => {
    saveVaultSecret(
      {
        name: "stripe",
        authKind: "bearer",
        token: "sk_live_123",
        hostAllowlist: ["api.stripe.com"],
      },
      options,
    );
    recordVaultGrant("stripe", "api.stripe.com", "allow-always", options);
    saveVaultSession("stripe", "api.stripe.com", "tok", Date.now() + 10_000, options);
    deleteVaultSecret("stripe", options);
    expect(listVaultSecrets(options)).toHaveLength(0);
    expect(getVaultGrant("stripe", "api.stripe.com", options)).toBeUndefined();
    expect(getVaultSession("stripe", "api.stripe.com", options)).toBeUndefined();
  });

  it("migrates a legacy (raw value + header_template) row at reopen", () => {
    saveVaultSecret(
      {
        name: "legacy",
        authKind: "bearer",
        token: "placeholder",
        hostAllowlist: ["api.example.com"],
      },
      options,
    );
    // Rewrite the row into the pre-auth_kind shape: a raw (non-JSON) value blob,
    // a header_template, and the default auth_config_json so the boot backfill
    // treats it as legacy.
    const key = loadOrCreateVaultKey(options.env);
    const raw = encryptSecret("legacy-token-xyz", key);
    const { db } = openOpenClawStateDatabase(options);
    db.prepare(
      `UPDATE vault_secret
          SET value_iv = ?, value_cipher = ?, value_tag = ?,
              header_template = 'Authorization: Bearer {{value}}',
              auth_kind = 'bearer', auth_config_json = '{}'
        WHERE name = 'legacy'`,
    ).run(raw.iv, raw.ciphertext, raw.tag);
    closeOpenClawStateDatabaseForTest();

    // Reopen triggers backfillVaultAuthKinds.
    const entry = listVaultSecrets(options)[0];
    expect(entry.authKind).toBe("bearer");
    expect(entry.authConfig).toEqual({ kind: "bearer" });
    expect(resolveVaultSecretMaterial("legacy", options)).toEqual({
      kind: "bearer",
      token: "legacy-token-xyz",
    });
    // A legacy row whose raw value is itself JSON-with-`kind` must still migrate
    // (not be mistaken for already-canonical material and stranded).
    const jsonValue = '{"kind":"weird-token","x":1}';
    const rawJson = encryptSecret(jsonValue, key);
    const { db: db2 } = openOpenClawStateDatabase(options);
    db2
      .prepare(
        `UPDATE vault_secret
          SET value_iv = ?, value_cipher = ?, value_tag = ?,
              header_template = 'Authorization: Bearer {{value}}',
              auth_kind = 'bearer', auth_config_json = '{}'
        WHERE name = 'legacy'`,
      )
      .run(rawJson.iv, rawJson.ciphertext, rawJson.tag);
    closeOpenClawStateDatabaseForTest();
    expect(listVaultSecrets(options)[0].authConfig).toEqual({ kind: "bearer" });
    expect(resolveVaultSecretMaterial("legacy", options)).toEqual({
      kind: "bearer",
      token: jsonValue,
    });

    // Idempotent: a second reopen leaves it unchanged.
    closeOpenClawStateDatabaseForTest();
    expect(resolveVaultSecretMaterial("legacy", options)).toEqual({
      kind: "bearer",
      token: jsonValue,
    });
  });
});
