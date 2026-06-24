// Client-side gateway token generation.
//
// Mirrors the server's randomToken() (src/commands/random-token.ts): 24 random
// bytes encoded as hex (48 chars). Using Web Crypto here means the plaintext is
// generated in the browser, so the UI can both persist it to gateway.auth.token
// and display it once without the gateway ever having to send a secret back —
// the gateway redacts the token from every RPC response by design.

const GATEWAY_TOKEN_BYTES = 24;

/** Generates a new opaque gateway token (24 random bytes, hex-encoded). */
export function generateGatewayToken(): string {
  const bytes = new Uint8Array(GATEWAY_TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
