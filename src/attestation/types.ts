/**
 * Attestation types — all data structures for the 4-layer attestation system.
 *
 * Layer 1: Response Receipt   (tamper-evident metadata per model response)
 * Layer 2: HMAC Signing       (cryptographic signature on receipts)
 * Layer 3: Chain-of-Custody   (delegation chain tracking)
 * Layer 4: Provider Capture   (provider-level attestation headers)
 */

// ---------------------------------------------------------------------------
// Layer 1 — Response Receipt
// ---------------------------------------------------------------------------

/** Tamper-evident receipt appended to every model response. */
export interface AttestationReceipt {
  /** Unique receipt identifier (UUID v4). */
  id: string;
  /** ISO-8601 timestamp when the response was received by the gateway. */
  timestamp: string;
  /** Model provider: "zai" | "deepseek" | "openai" | "moonshot" | etc. */
  provider: string;
  /** Model identifier: "glm-5.1" | "deepseek-v4-pro" | etc. */
  model: string;
  /** OpenClaw session key. */
  sessionId: string;
  /** Turn identifier within the session. */
  turnId: string;
  /** SHA-256 hex digest of the request payload (serialized JSON). */
  requestHash: string;
  /** SHA-256 hex digest of the response content (final text). */
  responseHash: string;
  /** OpenClaw gateway build version. */
  gatewayVersion: string;
}

// ---------------------------------------------------------------------------
// Layer 2 — HMAC Signing
// ---------------------------------------------------------------------------

/** HMAC algorithm identifiers we support. */
export type AttestationAlgorithm = "hmac-sha256";

/** A receipt signed with an HMAC key. */
export interface SignedAttestationReceipt extends AttestationReceipt {
  /** Signing algorithm used. */
  algorithm: AttestationAlgorithm;
  /** HMAC-SHA256 hex digest of the serialized receipt payload. */
  signature: string;
}

// ---------------------------------------------------------------------------
// Layer 3 — Chain-of-Custody
// ---------------------------------------------------------------------------

/** A single link in the delegation chain. */
export interface CustodyChainLink {
  /** Receipt ID for this link. */
  receiptId: string;
  /** Receipt ID of the parent link (null for root session). */
  parentReceiptId: string | null;
  /** Agent identifier. */
  agentId: string;
  /** Tool calls invoked during this turn. */
  toolCalls: string[];
  /** Any model overrides applied during this turn. */
  modelOverrides: string[];
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/** A full custody chain for a session. */
export interface CustodyChain {
  /** Session key this chain belongs to. */
  sessionId: string;
  /** Ordered chain links. */
  links: CustodyChainLink[];
}

// ---------------------------------------------------------------------------
// Layer 4 — Provider Attestation Capture
// ---------------------------------------------------------------------------

/** A provider-level attestation header captured from an HTTP response. */
export interface ProviderAttestation {
  /** Provider identifier. */
  provider: string;
  /** HTTP header name (e.g., "x-oai-attestation"). */
  headerName: string;
  /** Opaque provider token value. */
  headerValue: string;
  /** ISO-8601 timestamp when captured. */
  capturedAt: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Per-provider attestation config. */
export interface ProviderAttestationConfig {
  /** Whether to capture attestation headers from this provider. */
  captureHeaders: boolean;
}

/** Top-level attestation config (maps to `attestation.*` in openclaw.json). */
export interface AttestationConfig {
  /** Enable/disable the entire attestation subsystem. Default: false. */
  enabled: boolean;
  /** HMAC signing algorithm. Default: "hmac-sha256". */
  algorithm: AttestationAlgorithm;
  /** Filesystem path to the signing key. Default: "~/.openclaw/attestation-key". */
  keyPath: string;
  /** Per-provider header capture config. */
  providers: Record<string, ProviderAttestationConfig>;
}

/** Full attestation record stored alongside a turn. */
export interface AttestationRecord {
  receipt: SignedAttestationReceipt;
  custodyLink?: CustodyChainLink;
  providerAttestation?: ProviderAttestation;
}
