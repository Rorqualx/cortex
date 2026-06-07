/**
 * Layer 2 — HMAC signing key management.
 *
 * Generates, loads, and rotates the gateway's attestation signing key.
 * The key is stored as a hex-encoded random bytes file on disk.
 * Auto-generated on first use if missing.
 *
 * Zero external dependencies — uses only `node:crypto` and `node:fs`.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default key length in bytes (256 bits). */
const DEFAULT_KEY_BYTES = 32;

/** Default key file path. */
export const DEFAULT_KEY_PATH = path.join(os.homedir(), ".openclaw", "attestation-key");

/**
 * Resolve a key path, expanding ~ to the user's home directory.
 */
export function resolveKeyPath(keyPath: string): string {
  if (keyPath.startsWith("~")) {
    return path.join(os.homedir(), keyPath.slice(1));
  }
  return keyPath;
}

/**
 * Generate a new random signing key.
 * @param bytes - Key length in bytes. Default: 32 (256 bits).
 * @returns Hex-encoded key string.
 */
export function generateKey(bytes: number = DEFAULT_KEY_BYTES): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Load the signing key from disk. Generates a new one if the file doesn't exist.
 *
 * @param keyPath - Path to the key file.
 * @param options - Optional generation parameters.
 * @returns Hex-encoded key string.
 */
export function loadOrGenerateKey(
  keyPath: string = DEFAULT_KEY_PATH,
  options?: { bytes?: number },
): string {
  const resolved = resolveKeyPath(keyPath);
  try {
    const existing = fs.readFileSync(resolved, "utf-8").trim();
    if (existing.length >= 16) {
      return existing;
    }
  } catch {
    // File doesn't exist or is unreadable — generate a new one.
  }

  const key = generateKey(options?.bytes);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  // Write with owner-only permissions (0600).
  fs.writeFileSync(resolved, key, { mode: 0o600 });
  return key;
}

/**
 * Rotate the signing key — generates a new key, replacing the old one.
 * Returns the new key.
 *
 * @param keyPath - Path to the key file.
 * @param options - Optional generation parameters.
 * @returns The new hex-encoded key string.
 */
export function rotateKey(
  keyPath: string = DEFAULT_KEY_PATH,
  options?: { bytes?: number },
): string {
  const resolved = resolveKeyPath(keyPath);
  const key = generateKey(options?.bytes);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, key, { mode: 0o600 });
  return key;
}

/**
 * Check whether a key file exists on disk.
 */
export function keyFileExists(keyPath: string = DEFAULT_KEY_PATH): boolean {
  const resolved = resolveKeyPath(keyPath);
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
