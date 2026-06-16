import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deleteVaultSecret,
  getVaultEntryForHost,
  getVaultGrant,
  hostMatchesAllowlist,
  listVaultSecrets,
  recordVaultGrant,
  renderVaultHeader,
  resolveVaultSecretValue,
  saveVaultSecret,
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

  it("saves an entry without exposing the value in metadata", () => {
    saveVaultSecret(
      { name: "stripe", value: "sk_live_123", hostAllowlist: ["api.stripe.com"] },
      options,
    );
    const entries = listVaultSecrets(options);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "stripe",
      hostAllowlist: ["api.stripe.com"],
      approvalPolicy: "ask",
    });
    expect(JSON.stringify(entries[0])).not.toContain("sk_live_123");
  });

  it("resolves the decrypted value only via the explicit resolve call", () => {
    saveVaultSecret(
      { name: "stripe", value: "sk_live_123", hostAllowlist: ["api.stripe.com"] },
      options,
    );
    expect(resolveVaultSecretValue("stripe", options)).toBe("sk_live_123");
    expect(resolveVaultSecretValue("missing", options)).toBeUndefined();
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
      { name: "stripe", value: "sk_live_123", hostAllowlist: ["api.stripe.com"] },
      options,
    );
    expect(getVaultEntryForHost("api.stripe.com", options)?.name).toBe("stripe");
    expect(getVaultEntryForHost("evil.com", options)).toBeUndefined();
  });

  it("updates hosts and persists/looks up grants", () => {
    saveVaultSecret(
      { name: "stripe", value: "sk_live_123", hostAllowlist: ["api.stripe.com"] },
      options,
    );
    setVaultSecretHosts("stripe", ["api.stripe.com", "files.stripe.com"], options);
    expect(getVaultEntryForHost("files.stripe.com", options)?.name).toBe("stripe");

    expect(getVaultGrant("stripe", "api.stripe.com", options)).toBeUndefined();
    recordVaultGrant("stripe", "api.stripe.com", "allow-always", options);
    expect(getVaultGrant("stripe", "api.stripe.com", options)).toBe("allow-always");
  });

  it("deletes an entry and its grants", () => {
    saveVaultSecret(
      { name: "stripe", value: "sk_live_123", hostAllowlist: ["api.stripe.com"] },
      options,
    );
    recordVaultGrant("stripe", "api.stripe.com", "allow-always", options);
    deleteVaultSecret("stripe", options);
    expect(listVaultSecrets(options)).toHaveLength(0);
    expect(getVaultGrant("stripe", "api.stripe.com", options)).toBeUndefined();
  });

  it("renders header name and value from a template", () => {
    expect(renderVaultHeader("Authorization: Bearer {{value}}", "abc")).toEqual({
      name: "Authorization",
      value: "Bearer abc",
    });
    expect(renderVaultHeader("X-Api-Key: {{value}}", "abc")).toEqual({
      name: "X-Api-Key",
      value: "abc",
    });
  });
});
