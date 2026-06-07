import { createChain, appendLink, createLink, verifyChain } from "./custody.js";
import { loadOrGenerateKey } from "./key-manager.js";
import { captureProviderAttestations } from "./provider-capture.js";
import { createReceipt, verifyReceipt } from "./receipt.js";
import { createSignedReceipt, verifySignedReceipt } from "./signer.js";
/**
 * Integration adapter for the attestation subsystem.
 *
 * Thin glue between the attestation modules and the existing OpenClaw
 * infrastructure. Callers should use this as the public API surface;
 * import from the individual modules only for advanced use.
 *
 * Integration Points:
 * ─────────────────────────────────────────────────────────────────────
 * 1. Model response → embedded-agent-runner/run.ts
 *    Call createAttestationForResponse() after each model response.
 *
 * 2. Sub-agent spawn → agents session spawn
 *    Call appendCustodyLink() after sub-agent creation.
 *
 * 3. Provider HTTP headers → llm/providers/*.ts
 *    Call captureProviderHeaders() after receiving provider response.
 *
 * 4. Config → config/io.ts
 *    Read attestation.* fields from OpenClawConfig.
 *
 * 5. CLI → cli/attestation-cli.ts (future)
 *    Verify receipts, inspect chains.
 * ─────────────────────────────────────────────────────────────────────
 */
import type {
  AttestationConfig,
  AttestationRecord,
  CustodyChain,
  ProviderAttestationConfig,
  SignedAttestationReceipt,
} from "./types.js";
import type { CustodyChainLink } from "./types.js";

/** Default attestation config (disabled, HMAC-SHA256). */
export const DEFAULT_ATTESTATION_CONFIG: AttestationConfig = {
  enabled: false,
  algorithm: "hmac-sha256",
  keyPath: "~/.openclaw/attestation-key",
  providers: {},
};

/**
 * Merge partial config from openclaw.json with defaults.
 */
export function resolveAttestationConfig(partial?: Partial<AttestationConfig>): AttestationConfig {
  if (!partial) return { ...DEFAULT_ATTESTATION_CONFIG };
  return {
    enabled: partial.enabled ?? DEFAULT_ATTESTATION_CONFIG.enabled,
    algorithm: partial.algorithm ?? DEFAULT_ATTESTATION_CONFIG.algorithm,
    keyPath: partial.keyPath ?? DEFAULT_ATTESTATION_CONFIG.keyPath,
    providers: partial.providers ?? DEFAULT_ATTESTATION_CONFIG.providers,
  };
}

// In-memory chain registry (keyed by session ID).
const chainRegistry = new Map<string, CustodyChain>();

// Track the last receipt ID per session, so sub-agents can link to their parent.
const lastReceiptIdBySession = new Map<string, string>();

/**
 * Create a full attestation record for a model response.
 *
 * This is the main entry point for Layer 1 + Layer 2.
 * Call after each model response is received.
 *
 * @returns The attestation record, or null if attestation is disabled.
 */
export function createAttestationForResponse(params: {
  config: AttestationConfig;
  provider: string;
  model: string;
  sessionId: string;
  turnId: string;
  requestPayload: unknown;
  responseContent: string;
  gatewayVersion: string;
  responseHeaders?: Record<string, string>;
  agentId?: string;
  parentReceiptId?: string | null;
  toolCalls?: string[];
  modelOverrides?: string[];
  durationMs?: number;
}): AttestationRecord | null {
  if (!params.config.enabled) return null;

  // Layer 1: Create receipt.
  const receipt = createReceipt({
    provider: params.provider,
    model: params.model,
    sessionId: params.sessionId,
    turnId: params.turnId,
    requestPayload: params.requestPayload,
    responseContent: params.responseContent,
    gatewayVersion: params.gatewayVersion,
  });

  // Layer 2: Sign receipt.
  const key = loadOrGenerateKey(params.config.keyPath);
  const signed = createSignedReceipt(receipt, key, params.config.algorithm);

  const record: AttestationRecord = { receipt: signed };

  // Layer 3: Append custody chain link.
  if (params.agentId) {
    const chain = getOrCreateChain(params.sessionId);
    // Auto-resolve parent from session context if not explicitly provided.
    const resolvedParentId =
      params.parentReceiptId ?? lastReceiptIdBySession.get(params.sessionId) ?? null;
    const link = createLink({
      receiptId: receipt.id,
      parentReceiptId: resolvedParentId,
      agentId: params.agentId,
      toolCalls: params.toolCalls,
      modelOverrides: params.modelOverrides,
      durationMs: params.durationMs ?? 0,
    });
    appendLink(chain, link);
    record.custodyLink = link;
  }

  // Track the last receipt ID for this session.
  lastReceiptIdBySession.set(params.sessionId, receipt.id);

  // Layer 4: Capture provider attestation headers.
  if (params.responseHeaders) {
    const providerConfig: ProviderAttestationConfig | undefined =
      params.config.providers[params.provider];
    const attestations = captureProviderAttestations(
      params.provider,
      params.responseHeaders,
      providerConfig,
    );
    if (attestations.length > 0) {
      record.providerAttestation = attestations[0]; // Store the first matching one.
    }
  }

  return record;
}

/**
 * Get or create a custody chain for a session.
 */
function getOrCreateChain(sessionId: string): CustodyChain {
  let chain = chainRegistry.get(sessionId);
  if (!chain) {
    chain = createChain(sessionId);
    chainRegistry.set(sessionId, chain);
  }
  return chain;
}

/**
 * Get the custody chain for a session.
 */
export function getCustodyChain(sessionId: string): CustodyChain | undefined {
  return chainRegistry.get(sessionId);
}

/**
 * Get the last receipt ID for a session (used by sub-agents to link to parent).
 */
export function getLastReceiptId(sessionId: string): string | undefined {
  return lastReceiptIdBySession.get(sessionId);
}

/**
 * Verify an attestation record — checks both signature and content hashes.
 */
export function verifyAttestationRecord(
  record: AttestationRecord,
  params: {
    key: string;
    requestPayload: unknown;
    responseContent: string;
  },
): { signatureValid: boolean; contentIntact: boolean } {
  const signatureValid = verifySignedReceipt(record.receipt, params.key);
  const contentIntact = verifyReceipt(record.receipt, {
    requestPayload: params.requestPayload,
    responseContent: params.responseContent,
  });
  return { signatureValid, contentIntact };
}

/**
 * Verify the custody chain for a session.
 */
export function verifySessionChain(
  sessionId: string,
):
  | { valid: true }
  | { valid: false; brokenAt: CustodyChainLink }
  | { valid: false; error: string } {
  const chain = chainRegistry.get(sessionId);
  if (!chain) return { valid: false, error: `No chain found for session ${sessionId}` };
  return verifyChain(chain);
}

/**
 * Clear the chain registry (for testing or memory management).
 */
export function clearChainRegistry(): void {
  chainRegistry.clear();
  lastReceiptIdBySession.clear();
}
