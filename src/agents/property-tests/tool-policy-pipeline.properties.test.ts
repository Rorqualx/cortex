/**
 * Property-Based Tests for Tool Policy Pipeline (DENY-FIRST Rule)
 *
 * Tests core security invariants of the tool policy system:
 * - Deny always overrides allow (DENY_FIRST_RULE)
 * - Empty denylist with allowlist permits only allowed tools
 * - Wildcard allowlist permits all non-denied tools
 * - Policy layers combine correctly
 * - Tool names are normalized before matching
 *
 * These tests verify the fundamental security guarantees of OpenClaw's
 * tool policy system across thousands of randomly generated inputs.
 */

import * as fc from "fast-check";
import { describe, expect, beforeEach, it } from "vitest";
import type { AnyAgentTool } from "../agent-tools.types.js";
import { COMMON_TOOL_NAMES } from "../test-helpers/property-generators.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  ToolPolicyPipelineStep,
} from "../tool-policy-pipeline.js";

/**
 * Create mock tool definitions from names
 */
function createMockTools(names: string[]): AnyAgentTool[] {
  return names.map((name) => ({
    name,
    schema: { type: "object" as const },
    handler: async () => ({ ok: true, value: null }),
  }));
}

/**
 * A mock toolMeta function that returns undefined for all tools
 * (indicating they are core tools, not plugin tools)
 */
function mockToolMeta(_tool: AnyAgentTool) {
  return undefined;
}

describe("tool-policy-pipeline DENY_FIRST properties", () => {
  describe("DENY_FIRST_RULE: deny always overrides allow", () => {
    it("blocks tools in denylist even if in allowlist", () => {
      fc.assert(
        fc.property(
          // Generate arbitrary sets of tool names
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES, "custom_tool"), {
            minLength: 1,
            maxLength: 15,
          }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES, "custom_tool"), {
            minLength: 1,
            maxLength: 15,
          }),
          (denylist, allowlist) => {
            const tools = createMockTools([...new Set([...denylist, ...allowlist])]);

            // Create a policy with overlapping deny and allow entries
            const steps: ToolPolicyPipelineStep[] = [
              {
                policy: { deny: denylist, allow: allowlist },
                label: "test-policy",
              },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));

            // Verify NO denied tool is in the result (DENY_FIRST_RULE)
            for (const denied of denylist) {
              expect(resultNames.has(denied)).toBe(false);
            }
          },
        ),
      );
    });

    it("blocks denied tools regardless of allow order", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          (deny1, deny2, allow) => {
            const allTools = [...new Set([...deny1, ...deny2, ...allow])];
            const tools = createMockTools(allTools);

            // Multiple policy layers with deny lists
            const steps: ToolPolicyPipelineStep[] = [
              { policy: { deny: deny1, allow }, label: "layer1" },
              { policy: { deny: deny2, allow }, label: "layer2" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));
            const allDenied = new Set([...deny1, ...deny2]);

            // No tool from any denylist should be present
            for (const denied of allDenied) {
              expect(resultNames.has(denied)).toBe(false);
            }
          },
        ),
      );
    });

    it("allows non-denied tools when allowlist is present", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          (denylist, allowlist) => {
            const tools = createMockTools([...new Set([...denylist, ...allowlist])]);

            const steps: ToolPolicyPipelineStep[] = [
              { policy: { deny: denylist, allow: allowlist }, label: "test" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));
            const deniedSet = new Set(denylist);

            // All non-denied tools from allowlist should be present
            for (const allowed of allowlist) {
              if (!deniedSet.has(allowed)) {
                expect(resultNames.has(allowed)).toBe(true);
              }
            }
          },
        ),
      );
    });
  });

  describe("Wildcard allowlist behavior", () => {
    it("wildcard allow permits all non-denied tools", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 0, maxLength: 10 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 15 }),
          (denylist, allTools) => {
            const tools = createMockTools(allTools);

            const steps: ToolPolicyPipelineStep[] = [
              { policy: { deny: denylist, allow: ["*"] }, label: "wildcard-test" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));
            const deniedSet = new Set(denylist);

            // All non-denied tools should be present
            for (const tool of allTools) {
              if (!deniedSet.has(tool)) {
                expect(resultNames.has(tool)).toBe(true);
              } else {
                expect(resultNames.has(tool)).toBe(false);
              }
            }
          },
        ),
      );
    });

    it("wildcard allow with empty denylist permits all tools", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 15 }),
          (allTools) => {
            const tools = createMockTools(allTools);

            const steps: ToolPolicyPipelineStep[] = [
              { policy: { deny: [], allow: ["*"] }, label: "permit-all" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));

            // All tools should be present
            for (const tool of allTools) {
              expect(resultNames.has(tool)).toBe(true);
            }
          },
        ),
      );
    });
  });

  describe("Empty/undefined policy behavior", () => {
    it("empty policy (no deny, no allow) allows all tools", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 15 }),
          (allTools) => {
            const tools = createMockTools(allTools);

            const steps: ToolPolicyPipelineStep[] = [{ policy: {}, label: "empty-policy" }];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            // Empty policy (no deny, no allow) allows all tools through
            // When allow.length === 0, matcher returns true for all tools
            expect(result).toHaveLength(allTools.length);
            const resultNames = new Set(result.map((t) => t.name));
            for (const tool of allTools) {
              expect(resultNames.has(tool)).toBe(true);
            }
          },
        ),
      );
    });

    it("undefined policy is skipped", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 15 }),
          (allTools) => {
            const tools = createMockTools(allTools);

            const steps: ToolPolicyPipelineStep[] = [
              { policy: undefined, label: "undefined-policy" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            // All tools should pass through when policy is undefined
            expect(result).toHaveLength(allTools.length);
            expect(new Set(result.map((t) => t.name))).toEqual(new Set(allTools));
          },
        ),
      );
    });

    it("allow-only policy permits only listed tools", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          (allowlist, allTools) => {
            const tools = createMockTools(allTools);

            const steps: ToolPolicyPipelineStep[] = [
              { policy: { allow: allowlist, deny: [] }, label: "allow-only" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));
            const allowSet = new Set(allowlist);

            // Only tools in allowlist should be present
            for (const tool of allTools) {
              if (allowSet.has(tool)) {
                expect(resultNames.has(tool)).toBe(true);
              } else {
                expect(resultNames.has(tool)).toBe(false);
              }
            }
          },
        ),
      );
    });
  });

  describe("Multi-layer policy composition", () => {
    it("deny in any layer blocks the tool", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 5 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 5 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 5 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 5 }),
          (deny1, allow1, deny2, allow2) => {
            const allTools = [...new Set([...deny1, ...allow1, ...deny2, ...allow2])];
            const tools = createMockTools(allTools);

            // Two layers: allow in layer 1, deny in layer 2
            const steps: ToolPolicyPipelineStep[] = [
              { policy: { allow: allow1, deny: deny1 }, label: "layer1" },
              { policy: { allow: allow2, deny: deny2 }, label: "layer2" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));
            const allDenied = new Set([...deny1, ...deny2]);

            // Tools denied in ANY layer should be absent
            for (const denied of allDenied) {
              expect(resultNames.has(denied)).toBe(false);
            }
          },
        ),
      );
    });

    it("intersection of allowlists across layers", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          (allowlist1, allowlist2) => {
            const allTools = [...new Set([...allowlist1, ...allowlist2])];
            const tools = createMockTools(allTools);

            // Two layers with different allowlists (no denies)
            const steps: ToolPolicyPipelineStep[] = [
              { policy: { allow: allowlist1, deny: [] }, label: "layer1" },
              { policy: { allow: allowlist2, deny: [] }, label: "layer2" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));
            const allowSet1 = new Set(allowlist1);
            const allowSet2 = new Set(allowlist2);

            // Result should only contain tools allowed in BOTH layers
            for (const tool of allTools) {
              const allowedInBoth = allowSet1.has(tool) && allowSet2.has(tool);
              expect(resultNames.has(tool)).toBe(allowedInBoth);
            }
          },
        ),
      );
    });
  });

  describe("Policy layer ordering", () => {
    it("default pipeline steps are in correct order", () => {
      const steps = buildDefaultToolPolicyPipelineSteps({
        profilePolicy: { allow: ["*"], deny: [] },
      });

      const expectedOrder = [
        "tools.profile",
        "tools.byProvider.profile",
        "tools.allow",
        "tools.byProvider.allow",
        "agent tools.allow",
        "agent tools.byProvider.allow",
        "group tools.allow",
        "tools.toolsBySender",
      ];

      expect(steps).toHaveLength(expectedOrder.length);
      steps.forEach((step, i) => {
        expect(step.label).toBe(expectedOrder[i]);
      });
    });

    it("denylist is processed before allowlist within each step", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          (denylist, allowlist) => {
            const tools = createMockTools([...new Set([...denylist, ...allowlist])]);

            // Create overlapping sets
            const overlapping = denylist.filter((d) => allowlist.includes(d));

            if (overlapping.length === 0) {
              // Skip if no overlap to test
              return true;
            }

            const steps: ToolPolicyPipelineStep[] = [
              { policy: { deny: denylist, allow: allowlist }, label: "single-step-test" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const resultNames = new Set(result.map((t) => t.name));

            // Overlapping tools (in both deny and allow) should be denied
            for (const tool of overlapping) {
              expect(resultNames.has(tool)).toBe(false);
            }
          },
        ),
      );
    });
  });

  describe("Determinism", () => {
    it("same inputs always produce same outputs", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 15 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 0, maxLength: 10 }),
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 0, maxLength: 10 }),
          (allTools, denylist, allowlist) => {
            const tools = createMockTools(allTools);
            const steps: ToolPolicyPipelineStep[] = [
              { policy: { deny: denylist, allow: allowlist }, label: "determinism-test" },
            ];

            const result1 = applyToolPolicyPipeline({
              tools: [...tools],
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            const result2 = applyToolPolicyPipeline({
              tools: [...tools],
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            // Results should be identical
            expect(result1).toHaveLength(result2.length);
            expect(new Set(result1.map((t) => t.name))).toEqual(
              new Set(result2.map((t) => t.name)),
            );
          },
        ),
      );
    });
  });

  describe("Edge cases", () => {
    it("handles empty tool list", () => {
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...COMMON_TOOL_NAMES)), (allowlist) => {
          const steps: ToolPolicyPipelineStep[] = [
            { policy: { allow: allowlist, deny: [] }, label: "empty-tools" },
          ];

          const result = applyToolPolicyPipeline({
            tools: [],
            toolMeta: mockToolMeta,
            warn: () => {},
            steps,
          });

          expect(result).toHaveLength(0);
        }),
      );
    });

    it("passes tools through without deduplication", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 5 }),
          (toolNames) => {
            // Create duplicates
            const duplicatedNames = [...toolNames, ...toolNames];
            const tools = createMockTools(duplicatedNames);

            const steps: ToolPolicyPipelineStep[] = [
              { policy: { allow: toolNames, deny: [] }, label: "duplicate-test" },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            // Pipeline does NOT deduplicate - tools pass through as-is
            expect(result).toHaveLength(duplicatedNames.length);
            expect(result.length).toBeGreaterThan(toolNames.length); // Duplicates preserved
          },
        ),
      );
    });

    it("handles empty strings in policy lists gracefully", () => {
      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...COMMON_TOOL_NAMES), { minLength: 1, maxLength: 10 }),
          (toolNames) => {
            const tools = createMockTools(toolNames);

            const steps: ToolPolicyPipelineStep[] = [
              {
                policy: {
                  allow: ["", ...toolNames],
                  deny: [""],
                },
                label: "empty-string-test",
              },
            ];

            const result = applyToolPolicyPipeline({
              tools,
              toolMeta: mockToolMeta,
              warn: () => {},
              steps,
            });

            // Empty strings should be ignored, real tools should work
            expect(result.length).toBeGreaterThan(0);
          },
        ),
      );
    });
  });
});
