/**
 * Layer 2 — HMAC signing and verification for attestation receipts.
 *
 * Signs receipts with HMAC-SHA256 using the gateway's attestation key.
 * The signature covers the canonical serialized receipt payload.
 * Verification recomputes the HMAC and compares.
 *
 * Zero external dependencies — uses only `node:crypto`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AttestationReceipt,
  AttestationAlgorithm,
  SignedAttestationReceipt,
} from "./types.js";

/** Base receipt fields used for signing (excludes algorithm and signature). */
const RECEIPT_SIGNATURE_FIELDS: readonly string[] = [
  "id",
  "timestamp",
  "provider",
  "model",
  "sessionId",
  "turnId",
  "requestHash",
  "responseHash",
  "gatewayVersion",
] as const;

/**
 * Canonical serialization of receipt fields for signing.
 * Explicitly selects only the base receipt fields, excluding algorithm and signature.
 */
function serializeForSigning(receipt: AttestationReceipt | SignedAttestationReceipt): string {
  const obj: Record<string, unknown> = {};
  for (const key of RECEIPT_SIGNATURE_FIELDS) {
    obj[key] = (receipt as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(obj, RECEIPT_SIGNATURE_FIELDS.slice());
}

/**
 * Compute an HMAC-SHA256 signature over a receipt.
 *
 * @param receipt - The receipt to sign.
 * @param key - Hex-encoded HMAC key.
 * @param algorithm - Algorithm identifier (currently only "hmac-sha256").
 * @returns Hex-encoded HMAC digest.
 */
export function signReceipt(
  receipt: AttestationReceipt,
  key: string,
  algorithm: AttestationAlgorithm = "hmac-sha256",
): string {
  if (algorithm !== "hmac-sha256") {
    throw new Error(`Unsupported attestation algorithm: ${algorithm}`);
  }
  const payload = serializeForSigning(receipt);
  return createHmac("sha256", Buffer.from(key, "hex")).update(payload, "utf-8").digest("hex");
}

/**
 * Create a signed receipt from an unsigned receipt.
 *
 * @param receipt - The unsigned receipt.
 * @param key - Hex-encoded HMAC key.
 * @param algorithm - Algorithm identifier.
 * @returns A SignedAttestationReceipt with the signature attached.
 */
export function createSignedReceipt(
  receipt: AttestationReceipt,
  key: string,
  algorithm: AttestationAlgorithm = "hmac-sha256",
): SignedAttestationReceipt {
  const signature = signReceipt(receipt, key, algorithm);
  return {
    ...receipt,
    algorithm,
    signature,
  };
}

/**
 * Verify a signed receipt's HMAC signature.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 * Returns `true` if the signature is valid, `false` otherwise.
 *
 * @param signed - The signed receipt to verify.
 * @param key - Hex-encoded HMAC key.
 * @returns Whether the signature is valid.
 */
export function verifySignedReceipt(signed: SignedAttestationReceipt, key: string): boolean {
  try {
    const expected = signReceipt(signed, key, signed.algorithm);
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(signed.signature, "hex");
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

/**
 * Extract the unsigned receipt from a signed one (strip signature fields).
 */
export function stripSignature(signed: SignedAttestationReceipt): AttestationReceipt {
  const { algorithm: _a, signature: _s, ...receipt } = signed;
  return receipt;
}
