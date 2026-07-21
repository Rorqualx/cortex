/**
 * Tests for deny-first rule enforcement in tool policy.
 *
 * Verifies that:
 * - Deny lists always override allow lists
 * - Conflicts are properly detected
 * - The deny-first security principle is enforced
 */

import { describe, expect, it } from "vitest";
import type { ToolPolicyLike } from "./tool-policy.js";

// SKIP: DENY_FIRST_RULE, applyDenyFirstRule, and detectDenyAllowConflicts were
// fork-only APIs that were not merged into production. Tests are skipped until
// these functions land in tool-policy.ts.

// Stub declarations so the skipped block type-checks without the missing production exports.
const DENY_FIRST_RULE: unique symbol = Symbol("openclaw.denyFirstRule");
const applyDenyFirstRule = (_params: {
  tools: string[];
  denylist: string[];
  allowlist: string[];
}): string[] => [];
const detectDenyAllowConflicts = (
  _policies: Array<ToolPolicyLike | undefined>,
): Record<number, string[]> => ({});

describe.skip("tool-policy: deny-first rule", () => {
  describe("DENY_FIRST_RULE symbol", () => {
    it("should export a unique symbol for deny-first rule", () => {
      expect(typeof DENY_FIRST_RULE).toBe("symbol");
      expect(DENY_FIRST_RULE.description).toBe("openclaw.denyFirstRule");
    });
  });

  describe("applyDenyFirstRule", () => {
    it("should remove denied tools even when they are in allowlist", () => {
      const result = applyDenyFirstRule({
        tools: ["read", "write", "exec", "bash"],
        denylist: ["exec", "bash"],
        allowlist: ["read", "write", "exec", "bash"],
      });

      // exec and bash should be removed despite being in allowlist
      expect(result).toEqual(["read", "write"]);
      expect(result).not.toContain("exec");
      expect(result).not.toContain("bash");
    });

    it("should deny-all with wildcard pattern", () => {
      const result = applyDenyFirstRule({
        tools: ["read", "write", "exec"],
        denylist: ["*"],
        allowlist: ["read", "write"],
      });

      expect(result).toEqual([]);
    });

    it("should allow-all with wildcard when no deny", () => {
      const result = applyDenyFirstRule({
        tools: ["read", "write", "exec"],
        denylist: [],
        allowlist: ["*"],
      });

      expect(result).toEqual(["read", "write", "exec"]);
    });

    it("should handle empty denylist", () => {
      const result = applyDenyFirstRule({
        tools: ["read", "write"],
        denylist: [],
        allowlist: ["read"],
      });

      expect(result).toEqual(["read"]);
    });

    it("should handle empty allowlist (allow all except denied)", () => {
      const result = applyDenyFirstRule({
        tools: ["read", "write", "exec"],
        denylist: ["exec"],
        allowlist: [],
      });

      expect(result).toEqual(["read", "write"]);
    });

    it("should normalize tool names before comparison", () => {
      const result = applyDenyFirstRule({
        tools: ["Read", "WRITE", "ExEc"],
        denylist: ["exec"],
        allowlist: ["READ", "write"],
      });

      // applyDenyFirstRule returns original tool names, not normalized
      expect(result).toEqual(["Read", "WRITE"]);
      expect(result).not.toContain("ExEc");
    });

    it("should handle tool name aliases (bash -> exec)", () => {
      const result = applyDenyFirstRule({
        tools: ["read", "bash", "exec"],
        denylist: ["bash"], // bash is an alias for exec
        allowlist: ["*"],
      });

      // bash should be denied (it's an alias for exec)
      expect(result).not.toContain("bash");
      expect(result).toContain("read");
    });
  });

  describe("detectDenyAllowConflicts", () => {
    it("should detect tools in both deny and allow lists", () => {
      const policies: ToolPolicyLike[] = [{ allow: ["read", "write"], deny: ["write", "exec"] }];

      const conflicts = detectDenyAllowConflicts(policies);

      expect(conflicts[0]).toContain("write");
      expect(conflicts[0]).not.toContain("read");
      expect(conflicts[0]).not.toContain("exec");
    });

    it("should detect wildcard allow with specific deny", () => {
      const policies: ToolPolicyLike[] = [{ allow: ["*"], deny: ["exec"] }];

      const conflicts = detectDenyAllowConflicts(policies);

      // * in allowlist conflicts with any specific deny
      expect(conflicts[0]).toContain("exec");
    });

    it("should detect conflicts across multiple policies", () => {
      const policies: ToolPolicyLike[] = [
        { allow: ["read", "write"], deny: ["write"] },
        { allow: ["exec", "bash"], deny: ["exec"] },
        { allow: ["read"], deny: [] }, // No conflict here
      ];

      const conflicts = detectDenyAllowConflicts(policies);

      expect(conflicts[0]).toContain("write");
      expect(conflicts[1]).toContain("exec");
      expect(conflicts[2]).toBeUndefined();
    });

    it("should handle undefined policies gracefully", () => {
      const policies: Array<ToolPolicyLike | undefined> = [
        undefined,
        { allow: ["read"], deny: ["read"] },
        undefined,
      ];

      const conflicts = detectDenyAllowConflicts(policies);

      expect(conflicts[0]).toBeUndefined();
      expect(conflicts[1]).toContain("read");
      expect(conflicts[2]).toBeUndefined();
    });

    it("should return empty object when no conflicts", () => {
      const policies: ToolPolicyLike[] = [
        { allow: ["read", "write"], deny: ["exec"] },
        { allow: ["bash"], deny: [] },
      ];

      const conflicts = detectDenyAllowConflicts(policies);

      expect(Object.keys(conflicts)).toHaveLength(0);
    });

    it("should detect exact pattern conflicts", () => {
      const policies: ToolPolicyLike[] = [
        { allow: ["web_fetch", "web_search"], deny: ["web_fetch"] },
      ];

      const conflicts = detectDenyAllowConflicts(policies);

      expect(conflicts[0]).toContain("web_fetch");
    });
  });

  describe("integration: deny-first overrides allow in all scenarios", () => {
    it("deny overrides allow in same policy", () => {
      const policies: ToolPolicyLike[] = [{ allow: ["read", "write", "exec"], deny: ["exec"] }];

      const tools = ["read", "write", "exec"];
      const result = applyDenyFirstRule({
        tools,
        denylist: policies[0]?.deny ?? [],
        allowlist: policies[0]?.allow ?? [],
      });

      expect(result).toEqual(["read", "write"]);
      expect(result).not.toContain("exec");
    });

    it("deny from one policy overrides allow from another", () => {
      const policy1: ToolPolicyLike = { allow: ["*"] };
      const policy2: ToolPolicyLike = { deny: ["exec", "bash"] };

      // Simulate deny-first: collect all denies, then apply allows
      const allDeny = [...(policy1.deny ?? []), ...(policy2.deny ?? [])];
      const allAllow = [...(policy1.allow ?? []), ...(policy2.allow ?? [])];

      const tools = ["read", "write", "exec", "bash"];
      const result = applyDenyFirstRule({
        tools,
        denylist: allDeny,
        allowlist: allAllow,
      });

      expect(result).toEqual(["read", "write"]);
      expect(result).not.toContain("exec");
      expect(result).not.toContain("bash");
    });

    it("wildcard deny overrides specific allow", () => {
      const result = applyDenyFirstRule({
        tools: ["read", "write", "exec"],
        denylist: ["*"],
        allowlist: ["read", "write", "exec"],
      });

      expect(result).toEqual([]);
    });

    it("specific deny overrides wildcard allow", () => {
      const result = applyDenyFirstRule({
        tools: ["read", "write", "exec"],
        denylist: ["exec"],
        allowlist: ["*"],
      });

      expect(result).toEqual(["read", "write"]);
      expect(result).not.toContain("exec");
    });
  });

  describe("deny-first enforcement in policy pipeline", () => {
    it("should demonstrate deny-first behavior with specific tools", () => {
      const result = applyDenyFirstRule({
        tools: ["web_fetch", "web_search", "read", "write"],
        denylist: ["web_fetch", "web_search"],
        allowlist: ["*"],
      });

      // Denied tools should not be in result despite allow:*
      expect(result).not.toContain("web_fetch");
      expect(result).not.toContain("web_search");
      expect(result).toContain("read");
      expect(result).toContain("write");
    });

    it("should handle complex policy combinations", () => {
      const tools = ["read", "write", "edit", "exec", "bash", "web_fetch"];
      const result = applyDenyFirstRule({
        tools,
        denylist: ["exec", "bash", "web_fetch"],
        allowlist: ["read", "write", "edit", "exec", "web_fetch"],
      });

      expect(result).toEqual(["read", "write", "edit"]);
      expect(result).not.toContain("exec");
      expect(result).not.toContain("bash");
      expect(result).not.toContain("web_fetch");
    });
  });
});
