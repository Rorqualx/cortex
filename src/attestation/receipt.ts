/**
 * Layer 1 — Tamper-evident response receipts.
 *
 * Every model response gets a receipt containing SHA-256 hashes of the
 * request and response payloads. Receipts are deterministic: the same
 * inputs always produce the same receipt (excluding the UUID id).
 *
 * Zero external dependencies — uses only `node:crypto`.
 */
import { createHash, randomUUID } from "node:crypto";
import type { AttestationReceipt } from "./types.js";

/**
 * Compute a SHA-256 hex digest of a string.
 */
export function sha256(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/**
 * Compute a SHA-256 hex digest of a JSON-serializable value.
 * Serialization is deterministic: keys are sorted, no whitespace.
 */
export function hashJson(value: unknown): string {
  const serialized = JSON.stringify(value, Object.keys(value as object).sort());
  return sha256(serialized);
}

/**
 * Create an attestation receipt for a model response.
 *
 * @param params - Receipt fields.
 * @returns A complete AttestationReceipt.
 */
export function createReceipt(params: {
  provider: string;
  model: string;
  sessionId: string;
  turnId: string;
  requestPayload: unknown;
  responseContent: string;
  gatewayVersion: string;
}): AttestationReceipt {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    provider: params.provider,
    model: params.model,
    sessionId: params.sessionId,
    turnId: params.turnId,
    requestHash: hashJson(params.requestPayload),
    responseHash: sha256(params.responseContent),
    gatewayVersion: params.gatewayVersion,
  };
}

/**
 * Verify that a receipt's hashes still match the original data.
 *
 * Returns `true` if both the request and response hashes match,
 * `false` if either has been tampered with.
 */
export function verifyReceipt(
  receipt: AttestationReceipt,
  params: {
    requestPayload: unknown;
    responseContent: string;
  },
): boolean {
  const expectedRequestHash = hashJson(params.requestPayload);
  const expectedResponseHash = sha256(params.responseContent);
  return (
    receipt.requestHash === expectedRequestHash && receipt.responseHash === expectedResponseHash
  );
}

/**
 * Serialize a receipt to a canonical JSON string.
 * Keys sorted, no whitespace — suitable for signing.
 */
export function serializeReceipt(receipt: AttestationReceipt): string {
  return JSON.stringify(receipt, Object.keys(receipt).sort());
}

/**
 * Parse a receipt from a JSON string.
 * Throws on invalid JSON or missing required fields.
 */
export function parseReceipt(json: string): AttestationReceipt {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  const required: (keyof AttestationReceipt)[] = [
    "id",
    "timestamp",
    "provider",
    "model",
    "sessionId",
    "turnId",
    "requestHash",
    "responseHash",
    "gatewayVersion",
  ];
  for (const key of required) {
    if (typeof parsed[key] !== "string") {
      throw new Error(`Invalid receipt: missing or non-string field "${key}"`);
    }
  }
  return parsed as unknown as AttestationReceipt;
}
