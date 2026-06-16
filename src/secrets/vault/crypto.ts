/** AES-256-GCM encryption for vault secret values, sealed by a 0600 key file. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertNoSymlinkParentsSync } from "../../infra/fs-safe-advanced.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { resolveOpenClawStateSqliteDir } from "../../state/openclaw-state-db.paths.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_FILE_NAME = "vault.key";

/** Encrypted secret payload; every field is base64. The key never appears here. */
export type EncryptedSecret = {
  iv: string;
  ciphertext: string;
  tag: string;
};

/** Resolve the master key file path inside the shared state SQLite directory. */
export function resolveVaultKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveOpenClawStateSqliteDir(env), KEY_FILE_NAME);
}

function assertSafeKeyDestination(keyPath: string): void {
  // The key sits beside the state DB; reject symlinked parents so a swapped
  // directory cannot redirect the master key to an attacker-controlled path.
  assertNoSymlinkParentsSync({
    rootDir: resolveRequiredHomeDir(),
    targetPath: keyPath,
    allowOutsideRoot: true,
    messagePrefix: "Refusing to traverse symlink in vault key path",
  });
  try {
    const stat = fs.lstatSync(keyPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to use a symlinked vault key file: ${keyPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function ensureKeyDir(keyPath: string): void {
  const dir = path.dirname(keyPath);
  fs.mkdirSync(dir, { recursive: true });
  const dirStat = fs.lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Refusing to use unsafe vault key directory: ${dir}`);
  }
  if (process.platform !== "win32") {
    fs.chmodSync(dir, 0o700);
  }
}

/**
 * Load the 32-byte master key, creating it on first use. The file is written
 * 0600 and re-checked on every read so a loosened-permissions key is rejected
 * rather than silently trusted.
 */
export function loadOrCreateVaultKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const keyPath = resolveVaultKeyPath(env);
  assertSafeKeyDestination(keyPath);
  let existing: Buffer | undefined;
  try {
    existing = fs.readFileSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
  if (existing) {
    if (existing.length !== KEY_BYTES) {
      throw new Error(
        `Vault key file is corrupt (${existing.length} bytes, expected ${KEY_BYTES}): ${keyPath}`,
      );
    }
    assertKeyPermissions(keyPath);
    return existing;
  }
  ensureKeyDir(keyPath);
  const key = randomBytes(KEY_BYTES);
  // Write 0600 directly so the key is never briefly world-readable on disk.
  fs.writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") {
    fs.chmodSync(keyPath, 0o600);
  }
  return key;
}

function assertKeyPermissions(keyPath: string): void {
  if (process.platform === "win32") {
    return;
  }
  const stat = fs.statSync(keyPath);
  const tooOpen = (stat.mode & 0o077) !== 0;
  if (tooOpen) {
    throw new Error(
      `Vault key permissions are too open (must be 0600): ${keyPath}. Run "chmod 600 ${keyPath}".`,
    );
  }
}

/** Encrypt a plaintext secret value with AES-256-GCM. */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

/** Decrypt an AES-256-GCM secret payload. Throws on tamper (auth tag mismatch). */
export function decryptSecret(payload: EncryptedSecret, key: Buffer): string {
  const iv = Buffer.from(payload.iv, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
