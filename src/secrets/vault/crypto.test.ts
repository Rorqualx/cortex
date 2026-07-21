import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  loadOrCreateVaultKey,
  resolveVaultKeyPath,
} from "./crypto.js";

describe("vault crypto", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-vault-crypto-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("round-trips a secret through encrypt/decrypt", () => {
    const key = loadOrCreateVaultKey(env);
    const secret = "sk_live_super_secret_value";
    const payload = encryptSecret(secret, key);
    expect(payload.ciphertext).not.toContain(secret);
    expect(decryptSecret(payload, key)).toBe(secret);
  });

  it("uses a fresh iv per encryption so ciphertext is non-deterministic", () => {
    const key = loadOrCreateVaultKey(env);
    const a = encryptSecret("same-value", key);
    const b = encryptSecret("same-value", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("throws when the auth tag does not match (tamper detection)", () => {
    const key = loadOrCreateVaultKey(env);
    const payload = encryptSecret("tamper-me", key);
    const flipped = Buffer.from(payload.ciphertext, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() =>
      decryptSecret({ ...payload, ciphertext: flipped.toString("base64") }, key),
    ).toThrow();
  });

  it("creates a 32-byte key file with 0600 perms and reuses it", () => {
    const key = loadOrCreateVaultKey(env);
    expect(key).toHaveLength(32);
    const keyPath = resolveVaultKeyPath(env);
    expect(fs.existsSync(keyPath)).toBe(true);
    if (process.platform !== "win32") {
      const mode = fs.statSync(keyPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const again = loadOrCreateVaultKey(env);
    expect(again.equals(key)).toBe(true);
  });

  it("rejects a key file with loosened permissions", () => {
    if (process.platform === "win32") {
      return;
    }
    loadOrCreateVaultKey(env);
    const keyPath = resolveVaultKeyPath(env);
    fs.chmodSync(keyPath, 0o644);
    expect(() => loadOrCreateVaultKey(env)).toThrow(/too open/);
  });
});
