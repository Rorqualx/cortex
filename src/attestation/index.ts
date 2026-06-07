/**
 * Attestation subsystem — barrel exports.
 *
 * Cryptographic proof that an AI agent's response actually came from the
 * claimed model, through the claimed provider, without tampering.
 *
 * Layers:
 *   1. Response Receipt  — tamper-evident metadata per model response
 *   2. HMAC Signing      — cryptographic signature on receipts
 *   3. Chain-of-Custody  — delegation chain tracking
 *   4. Provider Capture  — provider-level attestation headers
 *
 * Zero external dependencies. Uses only `node:crypto` and `node:fs`.
 */
export type {
  AttestationReceipt,
  AttestationAlgorithm,
  SignedAttestationReceipt,
  CustodyChainLink,
  CustodyChain,
  ProviderAttestation,
  ProviderAttestationConfig,
  AttestationConfig,
  AttestationRecord,
} from "./types.js";

export {
  createReceipt,
  verifyReceipt,
  serializeReceipt,
  parseReceipt,
  sha256,
  hashJson,
} from "./receipt.js";

export { signReceipt, createSignedReceipt, verifySignedReceipt, stripSignature } from "./signer.js";

export {
  generateKey,
  loadOrGenerateKey,
  rotateKey,
  keyFileExists,
  resolveKeyPath,
  DEFAULT_KEY_PATH,
} from "./key-manager.js";

export {
  createChain,
  appendLink,
  createLink,
  findRoot,
  findLinksByReceipt,
  findChildren,
  verifyChain,
  serializeChain,
  parseChain,
  totalChainDuration,
  chainDepth,
} from "./custody.js";

export {
  captureProviderAttestations,
  getProviderHeaders,
  serializeProviderAttestation,
  parseProviderAttestation,
} from "./provider-capture.js";

export {
  resolveAttestationConfig,
  createAttestationForResponse,
  verifyAttestationRecord,
  verifySessionChain,
  getCustodyChain,
  getLastReceiptId,
  clearChainRegistry,
  DEFAULT_ATTESTATION_CONFIG,
} from "./integration.js";
