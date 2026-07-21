import fs from "node:fs";
import os from "node:os";
import path from "node:path";
/**
 * Attestation subsystem — comprehensive tests.
 *
 * Covers all 4 layers: receipt, signing, custody chain, provider capture.
 * Also covers key management.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
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
import {
  generateKey,
  loadOrGenerateKey,
  rotateKey,
  keyFileExists,
  resolveKeyPath,
  DEFAULT_KEY_PATH,
} from "./key-manager.js";
import {
  captureProviderAttestations,
  getProviderHeaders,
  parseProviderAttestation,
  serializeProviderAttestation,
} from "./provider-capture.js";
import {
  createReceipt,
  verifyReceipt,
  serializeReceipt,
  parseReceipt,
  sha256,
  hashJson,
} from "./receipt.js";
import { signReceipt, createSignedReceipt, verifySignedReceipt, stripSignature } from "./signer.js";
import type { AttestationReceipt, SignedAttestationReceipt, CustodyChain } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_KEY = "a".repeat(64); // 32 bytes hex

function makeReceipt(overrides?: Partial<Parameters<typeof createReceipt>[0]>): AttestationReceipt {
  return createReceipt({
    provider: "zai",
    model: "glm-5.1",
    sessionId: "session-test-001",
    turnId: "turn-001",
    requestPayload: { messages: [{ role: "user", content: "hello" }] },
    responseContent: "Hello! How can I help you?",
    gatewayVersion: "1.0.0-test",
    ...overrides,
  });
}

// Temporary directory for key file tests
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "attestation-test-"));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Layer 1: Receipt
// ---------------------------------------------------------------------------

describe("sha256", () => {
  it("produces a 64-char hex string", () => {
    const hash = sha256("test");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
  });

  it("differs for different inputs", () => {
    expect(sha256("hello")).not.toBe(sha256("world"));
  });
});

describe("hashJson", () => {
  it("sorts keys for determinism", () => {
    const a = hashJson({ b: 2, a: 1 });
    const b = hashJson({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("differs for different values", () => {
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
  });
});

describe("createReceipt", () => {
  it("creates a receipt with all required fields", () => {
    const r = makeReceipt();
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/); // UUID v4
    expect(r.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.provider).toBe("zai");
    expect(r.model).toBe("glm-5.1");
    expect(r.sessionId).toBe("session-test-001");
    expect(r.turnId).toBe("turn-001");
    expect(r.requestHash).toHaveLength(64);
    expect(r.responseHash).toHaveLength(64);
    expect(r.gatewayVersion).toBe("1.0.0-test");
  });

  it("produces different IDs for different calls", () => {
    const a = makeReceipt();
    const b = makeReceipt();
    expect(a.id).not.toBe(b.id);
  });

  it("hashes the request payload deterministically", () => {
    const payload = { messages: [{ role: "user", content: "hello" }] };
    const r = makeReceipt({ requestPayload: payload });
    expect(r.requestHash).toBe(hashJson(payload));
  });

  it("hashes the response content", () => {
    const r = makeReceipt({ responseContent: "test response" });
    expect(r.responseHash).toBe(sha256("test response"));
  });
});

describe("verifyReceipt", () => {
  it("returns true for matching data", () => {
    const payload = { messages: [{ role: "user", content: "hello" }] };
    const content = "Hello!";
    const r = createReceipt({
      provider: "zai",
      model: "glm-5.1",
      sessionId: "s1",
      turnId: "t1",
      requestPayload: payload,
      responseContent: content,
      gatewayVersion: "1.0",
    });
    expect(verifyReceipt(r, { requestPayload: payload, responseContent: content })).toBe(true);
  });

  it("returns false for tampered request", () => {
    const r = makeReceipt({ requestPayload: { a: 1 } });
    expect(
      verifyReceipt(r, { requestPayload: { a: 2 }, responseContent: "Hello! How can I help you?" }),
    ).toBe(false);
  });

  it("returns false for tampered response", () => {
    const r = makeReceipt();
    expect(
      verifyReceipt(r, {
        requestPayload: { messages: [{ role: "user", content: "hello" }] },
        responseContent: "TAMPERED",
      }),
    ).toBe(false);
  });
});

describe("serializeReceipt / parseReceipt", () => {
  it("round-trips a receipt through JSON", () => {
    const r = makeReceipt();
    const json = serializeReceipt(r);
    const parsed = parseReceipt(json);
    expect(parsed).toEqual(r);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseReceipt("not json")).toThrow();
  });

  it("throws on missing fields", () => {
    expect(() => parseReceipt('{"id":"test"}')).toThrow(/missing/);
  });
});

// ---------------------------------------------------------------------------
// Layer 2: Key Management
// ---------------------------------------------------------------------------

describe("generateKey", () => {
  it("produces a 64-char hex string (default 32 bytes)", () => {
    const key = generateKey();
    expect(key).toHaveLength(64);
    expect(key).toMatch(/^[0-9a-f]+$/);
  });

  it("respects custom byte length", () => {
    const key = generateKey(16);
    expect(key).toHaveLength(32); // 16 bytes = 32 hex chars
  });

  it("produces unique keys", () => {
    expect(generateKey()).not.toBe(generateKey());
  });
});

describe("loadOrGenerateKey", () => {
  it("generates a new key if file doesn't exist", () => {
    const keyPath = path.join(tmpDir, "test-key");
    const key = loadOrGenerateKey(keyPath);
    expect(key).toHaveLength(64);
    expect(fs.readFileSync(keyPath, "utf-8").trim()).toBe(key);
  });

  it("loads existing key from file", () => {
    const keyPath = path.join(tmpDir, "existing-key");
    fs.writeFileSync(keyPath, TEST_KEY);
    const loaded = loadOrGenerateKey(keyPath);
    expect(loaded).toBe(TEST_KEY);
  });

  it("regenerates if file is too short", () => {
    const keyPath = path.join(tmpDir, "short-key");
    fs.writeFileSync(keyPath, "abc");
    const key = loadOrGenerateKey(keyPath);
    expect(key).toHaveLength(64);
    expect(key).not.toBe("abc");
  });

  it("sets file permissions to 0600", () => {
    const keyPath = path.join(tmpDir, "perms-key");
    loadOrGenerateKey(keyPath);
    const stat = fs.statSync(keyPath);
    // On some platforms the mode includes file type bits, mask with 0o777.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("rotateKey", () => {
  it("replaces the existing key with a new one", () => {
    const keyPath = path.join(tmpDir, "rotate-key");
    const oldKey = loadOrGenerateKey(keyPath);
    const newKey = rotateKey(keyPath);
    expect(newKey).toHaveLength(64);
    expect(newKey).not.toBe(oldKey);
    expect(fs.readFileSync(keyPath, "utf-8").trim()).toBe(newKey);
  });
});

describe("keyFileExists", () => {
  it("returns true for existing file", () => {
    const keyPath = path.join(tmpDir, "exists-key");
    fs.writeFileSync(keyPath, TEST_KEY);
    expect(keyFileExists(keyPath)).toBe(true);
  });

  it("returns false for missing file", () => {
    expect(keyFileExists(path.join(tmpDir, "nope-key"))).toBe(false);
  });
});

describe("resolveKeyPath", () => {
  it("expands ~ to home directory", () => {
    const resolved = resolveKeyPath("~/test/key");
    expect(resolved).toBe(path.join(os.homedir(), "test/key"));
  });

  it("passes through absolute paths unchanged", () => {
    expect(resolveKeyPath("/absolute/path")).toBe("/absolute/path");
  });
});

// ---------------------------------------------------------------------------
// Layer 2: Signing
// ---------------------------------------------------------------------------

describe("signReceipt", () => {
  it("produces a 64-char hex signature", () => {
    const r = makeReceipt();
    const sig = signReceipt(r, TEST_KEY);
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]+$/);
  });

  it("is deterministic for same receipt + key", () => {
    const r = makeReceipt();
    expect(signReceipt(r, TEST_KEY)).toBe(signReceipt(r, TEST_KEY));
  });

  it("differs for different keys", () => {
    const r = makeReceipt();
    expect(signReceipt(r, TEST_KEY)).not.toBe(signReceipt(r, "b".repeat(64)));
  });

  it("throws for unsupported algorithm", () => {
    const r = makeReceipt();
    expect(() => signReceipt(r, TEST_KEY, "hmac-sha512" as any)).toThrow(/unsupported/i);
  });
});

describe("createSignedReceipt", () => {
  it("extends receipt with algorithm and signature", () => {
    const r = makeReceipt();
    const signed = createSignedReceipt(r, TEST_KEY);
    expect(signed.algorithm).toBe("hmac-sha256");
    expect(signed.signature).toHaveLength(64);
    // Original fields preserved.
    expect(signed.id).toBe(r.id);
    expect(signed.provider).toBe(r.provider);
    expect(signed.model).toBe(r.model);
  });
});

describe("verifySignedReceipt", () => {
  it("returns true for valid signature", () => {
    const r = makeReceipt();
    const signed = createSignedReceipt(r, TEST_KEY);
    expect(verifySignedReceipt(signed, TEST_KEY)).toBe(true);
  });

  it("returns false for wrong key", () => {
    const r = makeReceipt();
    const signed = createSignedReceipt(r, TEST_KEY);
    expect(verifySignedReceipt(signed, "b".repeat(64))).toBe(false);
  });

  it("returns false for tampered receipt", () => {
    const r = makeReceipt();
    const signed = createSignedReceipt(r, TEST_KEY);
    const tampered: SignedAttestationReceipt = { ...signed, model: "tampered-model" };
    expect(verifySignedReceipt(tampered, TEST_KEY)).toBe(false);
  });

  it("returns false for tampered signature", () => {
    const r = makeReceipt();
    const signed = createSignedReceipt(r, TEST_KEY);
    const tampered: SignedAttestationReceipt = { ...signed, signature: "f".repeat(64) };
    expect(verifySignedReceipt(tampered, TEST_KEY)).toBe(false);
  });

  it("returns false for wrong-length signature", () => {
    const r = makeReceipt();
    const signed = createSignedReceipt(r, TEST_KEY);
    const tampered: SignedAttestationReceipt = { ...signed, signature: "abcd" };
    expect(verifySignedReceipt(tampered, TEST_KEY)).toBe(false);
  });
});

describe("stripSignature", () => {
  it("removes algorithm and signature fields", () => {
    const r = makeReceipt();
    const signed = createSignedReceipt(r, TEST_KEY);
    const stripped = stripSignature(signed);
    expect("algorithm" in stripped).toBe(false);
    expect("signature" in stripped).toBe(false);
    expect(stripped.id).toBe(r.id);
  });
});

// ---------------------------------------------------------------------------
// Layer 3: Chain-of-Custody
// ---------------------------------------------------------------------------

describe("createChain", () => {
  it("creates an empty chain for a session", () => {
    const chain = createChain("session-1");
    expect(chain.sessionId).toBe("session-1");
    expect(chain.links).toHaveLength(0);
  });
});

describe("createLink", () => {
  it("creates a link with defaults", () => {
    const link = createLink({
      receiptId: "r1",
      parentReceiptId: null,
      agentId: "agent-1",
      durationMs: 1500,
    });
    expect(link.receiptId).toBe("r1");
    expect(link.parentReceiptId).toBeNull();
    expect(link.agentId).toBe("agent-1");
    expect(link.toolCalls).toEqual([]);
    expect(link.modelOverrides).toEqual([]);
    expect(link.durationMs).toBe(1500);
    expect(link.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts tool calls and model overrides", () => {
    const link = createLink({
      receiptId: "r2",
      parentReceiptId: "r1",
      agentId: "agent-2",
      toolCalls: ["exec", "read"],
      modelOverrides: ["deepseek-v4-flash"],
      durationMs: 3000,
    });
    expect(link.toolCalls).toEqual(["exec", "read"]);
    expect(link.modelOverrides).toEqual(["deepseek-v4-flash"]);
  });
});

describe("appendLink", () => {
  it("appends a link to the chain", () => {
    const chain = createChain("s1");
    const link = createLink({
      receiptId: "r1",
      parentReceiptId: null,
      agentId: "main",
      durationMs: 100,
    });
    appendLink(chain, link);
    expect(chain.links).toHaveLength(1);
    expect(chain.links[0]!.receiptId).toBe("r1");
  });
});

describe("findRoot", () => {
  it("finds the root link", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r1", parentReceiptId: null, agentId: "main", durationMs: 100 }),
    );
    appendLink(
      chain,
      createLink({ receiptId: "r2", parentReceiptId: "r1", agentId: "sub", durationMs: 200 }),
    );
    const root = findRoot(chain);
    expect(root?.receiptId).toBe("r1");
  });

  it("returns undefined for empty chain", () => {
    expect(findRoot(createChain("s1"))).toBeUndefined();
  });
});

describe("findLinksByReceipt", () => {
  it("finds links by receipt ID", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r1", parentReceiptId: null, agentId: "a", durationMs: 100 }),
    );
    appendLink(
      chain,
      createLink({ receiptId: "r2", parentReceiptId: "r1", agentId: "b", durationMs: 200 }),
    );
    expect(findLinksByReceipt(chain, "r1")).toHaveLength(1);
    expect(findLinksByReceipt(chain, "r99")).toHaveLength(0);
  });
});

describe("findChildren", () => {
  it("finds immediate children", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r1", parentReceiptId: null, agentId: "a", durationMs: 100 }),
    );
    appendLink(
      chain,
      createLink({ receiptId: "r2", parentReceiptId: "r1", agentId: "b", durationMs: 200 }),
    );
    appendLink(
      chain,
      createLink({ receiptId: "r3", parentReceiptId: "r1", agentId: "c", durationMs: 300 }),
    );
    const children = findChildren(chain, "r1");
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.receiptId)).toEqual(["r2", "r3"]);
  });
});

describe("verifyChain", () => {
  it("returns valid for a correct chain", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r1", parentReceiptId: null, agentId: "a", durationMs: 100 }),
    );
    appendLink(
      chain,
      createLink({ receiptId: "r2", parentReceiptId: "r1", agentId: "b", durationMs: 200 }),
    );
    expect(verifyChain(chain)).toEqual({ valid: true });
  });

  it("detects a broken chain (missing parent)", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r2", parentReceiptId: "r-missing", agentId: "b", durationMs: 200 }),
    );
    const result = verifyChain(chain);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.brokenAt.receiptId).toBe("r2");
    }
  });

  it("returns valid for an empty chain", () => {
    expect(verifyChain(createChain("s1"))).toEqual({ valid: true });
  });
});

describe("serializeChain / parseChain", () => {
  it("round-trips a chain through JSON", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r1", parentReceiptId: null, agentId: "a", durationMs: 100 }),
    );
    const json = serializeChain(chain);
    const parsed = parseChain(json);
    expect(parsed).toEqual(chain);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseChain("not json")).toThrow();
  });

  it("throws on missing sessionId", () => {
    expect(() => parseChain('{"links":[]}')).toThrow(/sessionId/);
  });

  it("throws on missing links", () => {
    expect(() => parseChain('{"sessionId":"s1"}')).toThrow(/links/);
  });

  it("throws on link missing receiptId", () => {
    expect(() => parseChain('{"sessionId":"s1","links":[{"agentId":"a"}]}')).toThrow(/receiptId/);
  });
});

describe("totalChainDuration", () => {
  it("sums all link durations", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r1", parentReceiptId: null, agentId: "a", durationMs: 100 }),
    );
    appendLink(
      chain,
      createLink({ receiptId: "r2", parentReceiptId: "r1", agentId: "b", durationMs: 200 }),
    );
    expect(totalChainDuration(chain)).toBe(300);
  });

  it("returns 0 for empty chain", () => {
    expect(totalChainDuration(createChain("s1"))).toBe(0);
  });
});

describe("chainDepth", () => {
  it("returns 0 for empty chain", () => {
    expect(chainDepth(createChain("s1"))).toBe(0);
  });

  it("returns 1 for root-only chain", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r1", parentReceiptId: null, agentId: "a", durationMs: 100 }),
    );
    expect(chainDepth(chain)).toBe(1);
  });

  it("computes depth for multi-level chain", () => {
    const chain = createChain("s1");
    appendLink(
      chain,
      createLink({ receiptId: "r1", parentReceiptId: null, agentId: "a", durationMs: 100 }),
    );
    appendLink(
      chain,
      createLink({ receiptId: "r2", parentReceiptId: "r1", agentId: "b", durationMs: 200 }),
    );
    appendLink(
      chain,
      createLink({ receiptId: "r3", parentReceiptId: "r2", agentId: "c", durationMs: 300 }),
    );
    expect(chainDepth(chain)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Layer 4: Provider Capture
// ---------------------------------------------------------------------------

describe("getProviderHeaders", () => {
  it("returns known headers for openai", () => {
    expect(getProviderHeaders("openai", { captureHeaders: true })).toEqual(["x-oai-attestation"]);
  });

  it("returns empty when captureHeaders is false", () => {
    expect(getProviderHeaders("openai", { captureHeaders: false })).toEqual([]);
  });

  it("returns empty when config is undefined and provider unknown", () => {
    expect(getProviderHeaders("unknown-provider")).toEqual([]);
  });

  it("returns known headers for provider without explicit config", () => {
    expect(getProviderHeaders("anthropic")).toEqual(["x-anthropic-attestation"]);
  });
});

describe("captureProviderAttestations", () => {
  it("captures matching headers", () => {
    const results = captureProviderAttestations(
      "openai",
      {
        "x-oai-attestation": "token-123",
        "content-type": "application/json",
      },
      { captureHeaders: true },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.provider).toBe("openai");
    expect(results[0]!.headerName).toBe("x-oai-attestation");
    expect(results[0]!.headerValue).toBe("token-123");
  });

  it("captures with case-insensitive header matching", () => {
    const results = captureProviderAttestations(
      "openai",
      {
        "X-OAI-ATTESTATION": "token-456",
      },
      { captureHeaders: true },
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.headerValue).toBe("token-456");
  });

  it("returns empty when no matching headers", () => {
    const results = captureProviderAttestations(
      "openai",
      {
        "content-type": "application/json",
      },
      { captureHeaders: true },
    );
    expect(results).toHaveLength(0);
  });

  it("returns empty when capture is disabled", () => {
    const results = captureProviderAttestations(
      "openai",
      {
        "x-oai-attestation": "token-123",
      },
      { captureHeaders: false },
    );
    expect(results).toHaveLength(0);
  });
});

describe("serializeProviderAttestation / parseProviderAttestation", () => {
  it("round-trips an attestation through JSON", () => {
    const attestation = {
      provider: "openai",
      headerName: "x-oai-attestation",
      headerValue: "token-abc",
      capturedAt: "2026-06-06T00:00:00.000Z",
    };
    const json = serializeProviderAttestation(attestation);
    const parsed = parseProviderAttestation(json);
    expect(parsed).toEqual(attestation);
  });

  it("throws on missing fields", () => {
    expect(() => parseProviderAttestation('{"provider":"openai"}')).toThrow(/missing/);
  });
});

// ---------------------------------------------------------------------------
// Integration: End-to-end flow
// ---------------------------------------------------------------------------

describe("end-to-end attestation flow", () => {
  it("creates, signs, and verifies a complete attestation record", () => {
    // 1. Generate a key.
    const key = generateKey();
    expect(key).toHaveLength(64);

    // 2. Create a receipt.
    const receipt = createReceipt({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      sessionId: "session-e2e",
      turnId: "turn-1",
      requestPayload: { prompt: "write hello world in rust" },
      responseContent: 'fn main() { println!("hello world"); }',
      gatewayVersion: "1.0.0",
    });

    // 3. Sign the receipt.
    const signed = createSignedReceipt(receipt, key);
    expect(signed.algorithm).toBe("hmac-sha256");
    expect(signed.signature).toHaveLength(64);

    // 4. Verify the signature.
    expect(verifySignedReceipt(signed, key)).toBe(true);

    // 5. Verify content hashes.
    expect(
      verifyReceipt(receipt, {
        requestPayload: { prompt: "write hello world in rust" },
        responseContent: 'fn main() { println!("hello world"); }',
      }),
    ).toBe(true);

    // 6. Tamper detection.
    expect(verifySignedReceipt({ ...signed, responseHash: "tampered" }, key)).toBe(false);
  });

  it("builds and verifies a multi-hop custody chain", () => {
    const chain = createChain("session-chain");

    // Root agent turn.
    const rootReceipt = makeReceipt({ sessionId: "session-chain", turnId: "t1" });
    appendLink(
      chain,
      createLink({
        receiptId: rootReceipt.id,
        parentReceiptId: null,
        agentId: "main",
        toolCalls: ["sessions_spawn"],
        durationMs: 500,
      }),
    );

    // Sub-agent turn.
    const subReceipt = makeReceipt({ sessionId: "session-chain", turnId: "t2" });
    appendLink(
      chain,
      createLink({
        receiptId: subReceipt.id,
        parentReceiptId: rootReceipt.id,
        agentId: "sub-agent-1",
        toolCalls: ["exec", "write"],
        modelOverrides: ["deepseek-v4-flash"],
        durationMs: 2500,
      }),
    );

    // Verify chain integrity.
    expect(verifyChain(chain)).toEqual({ valid: true });
    expect(chain.links).toHaveLength(2);
    expect(chainDepth(chain)).toBe(2);
    expect(totalChainDuration(chain)).toBe(3000);

    // Find children.
    const children = findChildren(chain, rootReceipt.id);
    expect(children).toHaveLength(1);
    expect(children[0]!.agentId).toBe("sub-agent-1");
  });

  it("captures provider attestation alongside receipt", () => {
    const providerAttestations = captureProviderAttestations(
      "openai",
      {
        "x-oai-attestation": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
        "x-request-id": "req-123",
      },
      { captureHeaders: true },
    );

    expect(providerAttestations).toHaveLength(1);
    expect(providerAttestations[0]!.headerName).toBe("x-oai-attestation");
  });
});
