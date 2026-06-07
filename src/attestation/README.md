# Attestation Subsystem

Cryptographic proof that an AI agent's response actually came from the claimed model, through the claimed provider, without tampering.

## Architecture

Four layers, zero external dependencies (`node:crypto` + `node:fs` only):

| Layer | Module                         | What                                               |
| ----- | ------------------------------ | -------------------------------------------------- |
| 1     | `receipt.ts`                   | Tamper-evident SHA-256 receipts per model response |
| 2     | `signer.ts` + `key-manager.ts` | HMAC-SHA256 signing and verification               |
| 3     | `custody.ts`                   | Chain-of-custody tracking for agent delegation     |
| 4     | `provider-capture.ts`          | Provider attestation header capture                |

## Quick Start

```typescript
import { resolveAttestationConfig, createAttestationForResponse } from "./integration.js";

const config = resolveAttestationConfig({ enabled: true });

const record = createAttestationForResponse({
  config,
  provider: "zai",
  model: "glm-5.1",
  sessionId: "session-123",
  turnId: "turn-1",
  requestPayload: { messages: [{ role: "user", content: "hello" }] },
  responseContent: "Hello! How can I help?",
  gatewayVersion: "1.0.0",
  agentId: "main",
});
```

## Integration Points

| Integration    | Where                          | What                                                            |
| -------------- | ------------------------------ | --------------------------------------------------------------- |
| Model response | `embedded-agent-runner/run.ts` | Call `createAttestationForResponse()` after each model response |
| Sub-agents     | `agents/subagent-*`            | Append custody chain links after spawn                          |
| Provider HTTP  | `llm/providers/*.ts`           | Capture attestation headers from responses                      |
| Config         | `config/io.ts`                 | Read `attestation.*` from `openclaw.json`                       |
| CLI            | `cli/` (future)                | `openclaw attestation verify`                                   |

## Config

```json
{
  "attestation": {
    "enabled": false,
    "algorithm": "hmac-sha256",
    "keyPath": "~/.openclaw/attestation-key",
    "providers": {
      "openai": { "captureHeaders": true }
    }
  }
}
```

## File Structure

```
src/attestation/
├── types.ts              # All type definitions
├── receipt.ts            # Receipt creation, hashing, serialization
├── signer.ts             # HMAC signing and verification
├── key-manager.ts        # Key generation, storage, rotation
├── custody.ts            # Chain-of-custody tracking
├── provider-capture.ts   # Provider header capture
├── integration.ts        # Integration adapter (public API)
├── index.ts              # Barrel exports
├── attestation.test.ts   # 72 tests
└── README.md             # This file
```

## Security Model

- **HMAC keys** are auto-generated with `0o600` permissions
- **Timing-safe comparison** prevents timing attacks on signature verification
- **Canonical serialization** (sorted keys) ensures deterministic signing
- Signing excludes `algorithm` and `signature` fields to prevent circular dependencies

## What This Is NOT

- Not end-to-end encryption (use TLS)
- Not model output verification (requires provider cooperation)
- Not a replacement for TLS/mTLS (application-layer provenance)
- Not zero-knowledge (receipts contain content hashes)

## Future Extensions

- Async key server for multi-gateway deployments
- Receipt API (HTTP endpoint)
- Merklized transcripts (Merkle tree over receipts)
- Ed25519 public key mode
- Compliance export (SOC 2 / HIPAA)
