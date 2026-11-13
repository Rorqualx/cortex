/**
 * F7 protected spans (2026-11-13): policy-bearing tool output (workspace red
 * lines, TOML exec policy, egress/vault rules) must survive both lossy stages
 * of the compression pipeline verbatim — the content-router compressors and
 * the token-budget trim. These tests pin the matcher shapes and the
 * grounding-faithfulness guarantee: policy spans survive max compression.
 *
 * Patterns are linear-time — these tests pin the shapes (ReDoS-safe per the
 * skill-forge gate history).
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../agents/runtime/index.js";
import { compressAssembledContext } from "./index.js";
import { hasProtectedSpan } from "./protected-spans.js";
import { enforceTokenBudget } from "./token-budget-enforcer.js";
import { DEFAULT_COMPRESSION_CONFIG, type CompressionConfig } from "./types.js";

function makeConfig(overrides?: Partial<CompressionConfig>): CompressionConfig {
  return { ...DEFAULT_COMPRESSION_CONFIG, enabled: true, ...overrides };
}

/** Raw text of a message (string content or text parts), un-escaped. */
function messageText(msg: AgentMessage | undefined): string {
  if (!msg || !("content" in msg) || !msg.content) {
    return "";
  }
  if (typeof msg.content === "string") {
    return msg.content;
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p: unknown) =>
        typeof p === "object" && p !== null && "text" in p
          ? String((p as { text: string }).text)
          : "",
      )
      .join("\n");
  }
  return "";
}

/** Exec-policy config dump long enough to look compressible (>800 chars). */
function execPolicyDump(): string {
  const rules = [
    "[exec_policy]",
    'allow = ["pnpm", "node scripts/run-vitest.mjs", "git status", "git diff"]',
    'deny = ["rm -rf", "curl | sh"]',
    "requireApproval = true",
  ].join("\n");
  const padding = Array.from({ length: 40 }, (_, i) => `policy context note ${i} lorem ipsum`).join(
    "\n",
  );
  return `${rules}\n${padding}`;
}

describe("hasProtectedSpan", () => {
  it("matches TOML exec-policy sections and exec-policy keys", () => {
    expect(hasProtectedSpan('[exec_policy]\nallow = ["pnpm"]')).toBe(true);
    expect(hasProtectedSpan('{"execPolicy": {"mode": "strict"}}')).toBe(true);
    expect(hasProtectedSpan("exec-policy denied the command")).toBe(true);
  });

  it("matches egress/vault rule identifiers", () => {
    expect(hasProtectedSpan("secrets.egressProxy.enabled = true")).toBe(true);
    expect(hasProtectedSpan("egressProxy allowedHosts: [example.com]")).toBe(true);
    expect(hasProtectedSpan('egress_allowlist_hosts = ["10.0.0.0/8"]')).toBe(true);
    expect(hasProtectedSpan("vault.key rotation pending")).toBe(true);
    expect(hasProtectedSpan("vault_session cache row")).toBe(true);
    expect(hasProtectedSpan("auth_kind = bearer")).toBe(true);
    expect(hasProtectedSpan("auth_config_json stored")).toBe(true);
  });

  it("matches workspace Red Lines markdown headers", () => {
    expect(hasProtectedSpan("## Red Lines\n\n- Don't exfiltrate private data. Ever.")).toBe(true);
    expect(hasProtectedSpan("### RED LINES (strict mode)")).toBe(true);
  });

  it("does not match ordinary compressible content", () => {
    expect(
      hasProtectedSpan(
        JSON.stringify(
          Array.from({ length: 20 }, (_, i) => ({ file: `m${i}.ts`, line: i, hit: "import x" })),
        ),
      ),
    ).toBe(false);
    expect(hasProtectedSpan("PASS src/app.test.ts\nPASS src/util.test.ts\n3 suites passed")).toBe(
      false,
    );
    expect(hasProtectedSpan("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new")).toBe(false);
    expect(hasProtectedSpan("the return policy changed and the vault door was red")).toBe(false);
    expect(hasProtectedSpan("")).toBe(false);
  });
});

describe("compressToolResults protected-span exemption", () => {
  it("keeps policy-bearing tool results verbatim while compressing siblings", async () => {
    const policyText = execPolicyDump();
    const plainText = JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({
        file: `src/mod${i}.ts`,
        line: i * 3,
        hit: "match",
      })),
    );
    const messages: AgentMessage[] = [
      { role: "user", content: "check the config and the scan results" } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call-policy",
        content: [{ type: "text", text: policyText }],
      } as unknown as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "call-scan",
        content: [{ type: "text", text: plainText }],
      } as unknown as AgentMessage,
    ];

    const result = await compressAssembledContext(messages, makeConfig({ minContentChars: 1 }));

    // The sibling array got compressed.
    expect(result.stats.messagesCompressed).toBe(1);

    // The policy dump survived verbatim: exact allow/deny lines intact.
    const policyMessage = result.messages.find(
      (m) => (m as { toolCallId?: string }).toolCallId === "call-policy",
    );
    const text = messageText(policyMessage);
    expect(text).toContain(
      'allow = ["pnpm", "node scripts/run-vitest.mjs", "git status", "git diff"]',
    );
    expect(text).toContain('deny = ["rm -rf", "curl | sh"]');
  });
});

describe("enforceTokenBudget protected-span exemption (grounding-faithfulness gate)", () => {
  it("policy spans survive max compression — tiny budget never drops them", () => {
    const filler = "x".repeat(2000);
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: `ordinary note one ${filler}`,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: `ordinary note two ${filler}`,
      } as unknown as AgentMessage,
      {
        role: "assistant",
        content: execPolicyDump(),
      } as unknown as AgentMessage,
      { role: "user", content: "summarize" } as unknown as AgentMessage,
    ];

    // Budget of 100 tokens forces maximal dropping (fillers alone are ~500
    // tokens each). The policy message must be among the survivors.
    const result = enforceTokenBudget(messages, 100, DEFAULT_COMPRESSION_CONFIG);
    const policyMessage = result.find((m) => messageText(m).includes("[exec_policy]"));
    expect(policyMessage).toBeDefined();
    const text = messageText(policyMessage);
    expect(text).toContain(
      'allow = ["pnpm", "node scripts/run-vitest.mjs", "git status", "git diff"]',
    );
    expect(text).toContain('deny = ["rm -rf", "curl | sh"]');

    // Sanity: the budget actually dropped ordinary content.
    expect(result.length).toBeLessThan(messages.length);
  });
});
