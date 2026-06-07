/**
 * Layer 4 — Provider-level attestation header capture.
 *
 * For providers that emit attestation headers (e.g., OpenAI's x-oai-attestation),
 * this module captures and stores those headers alongside our own receipts.
 *
 * Verification of provider attestations is provider-specific and left to
 * the consumer — this module just captures the raw data.
 */
import type { ProviderAttestation, ProviderAttestationConfig } from "./types.js";

/** Known provider header names (extensible). */
const KNOWN_HEADERS: Record<string, string[]> = {
  openai: ["x-oai-attestation"],
  anthropic: ["x-anthropic-attestation"],
};

/**
 * Get the header names to capture for a given provider.
 * Falls back to the known set, then to empty if unrecognized.
 */
export function getProviderHeaders(provider: string, config?: ProviderAttestationConfig): string[] {
  if (config && !config.captureHeaders) return [];
  return KNOWN_HEADERS[provider] ?? [];
}

/**
 * Capture provider attestation headers from an HTTP response.
 *
 * @param provider - Provider identifier.
 * @param headers - HTTP response headers (key → value).
 * @param config - Per-provider config (if available).
 * @returns Array of captured attestations (may be empty).
 */
export function captureProviderAttestations(
  provider: string,
  headers: Record<string, string>,
  config?: ProviderAttestationConfig,
): ProviderAttestation[] {
  const headerNames = getProviderHeaders(provider, config);
  const results: ProviderAttestation[] = [];

  for (const headerName of headerNames) {
    // Try case-insensitive match — HTTP headers are case-insensitive.
    const value = findHeader(headers, headerName);
    if (value) {
      results.push({
        provider,
        headerName,
        headerValue: value,
        capturedAt: new Date().toISOString(),
      });
    }
  }

  return results;
}

/**
 * Case-insensitive header lookup.
 */
function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

/**
 * Serialize a provider attestation to JSON.
 */
export function serializeProviderAttestation(attestation: ProviderAttestation): string {
  return JSON.stringify(attestation);
}

/**
 * Parse a provider attestation from JSON.
 */
export function parseProviderAttestation(json: string): ProviderAttestation {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (
    typeof parsed.provider !== "string" ||
    typeof parsed.headerName !== "string" ||
    typeof parsed.headerValue !== "string" ||
    typeof parsed.capturedAt !== "string"
  ) {
    throw new Error("Invalid provider attestation: missing required string fields");
  }
  return parsed as unknown as ProviderAttestation;
}
