// Covers the pure reassignment planner: rewrite vs clear across binding kinds.
import { describe, expect, it } from "vitest";
import {
  type DeprecatedReplacement,
  type ModelBinding,
  buildReplacementDecisions,
  buildReplacementIndex,
  planReassignments,
} from "./reassign-plan.js";
import type { ReplacementCandidate } from "./reconcile.js";

const replacements: DeprecatedReplacement[] = [
  { provider: "zai", deprecatedModelId: "glm-4.6v", replacementModelId: "glm-5.1" },
  { provider: "zai", deprecatedModelId: "glm-4-long", replacementModelId: null },
];

describe("buildReplacementIndex", () => {
  it("keys by normalized provider/model and preserves null survivors", () => {
    const index = buildReplacementIndex(replacements);
    expect(index.get("zai/glm-4.6v")).toBe("glm-5.1");
    expect(index.get("zai/glm-4-long")).toBeNull();
    expect(index.has("zai/glm-5.1")).toBe(false);
  });

  it("normalizes case and whitespace in the deprecated id", () => {
    const index = buildReplacementIndex([
      { provider: "ZAI", deprecatedModelId: " GLM-4.6V ", replacementModelId: "glm-5.1" },
    ]);
    expect(index.get("zai/glm-4.6v")).toBe("glm-5.1");
  });
});

describe("buildReplacementDecisions", () => {
  const candidates: ReplacementCandidate[] = [
    { provider: "zai", id: "glm-5.1", reasoning: true, contextWindow: 200_000 },
    { provider: "zai", id: "glm-5", reasoning: true, contextWindow: 128_000 },
    { provider: "zai", id: "glm-4.5-air", reasoning: false, contextWindow: 128_000 },
  ];

  it("scores a nearest-capability survivor using deprecated metadata", () => {
    const decisions = buildReplacementDecisions({
      deprecated: [{ provider: "zai", modelId: "glm-4.6v" }],
      candidates,
      deprecatedMeta: new Map([
        [
          "zai/glm-4.6v",
          { provider: "zai", id: "glm-4.6v", reasoning: false, contextWindow: 130_000 },
        ],
      ]),
    });
    // Non-reasoning deprecated -> non-reasoning candidate wins on reasoning parity.
    expect(decisions).toEqual([
      { provider: "zai", deprecatedModelId: "glm-4.6v", replacementModelId: "glm-4.5-air" },
    ]);
  });

  it("prefers the provider default when metadata is unknown and a default is given", () => {
    const decisions = buildReplacementDecisions({
      deprecated: [{ provider: "zai", modelId: "glm-4-long" }],
      candidates,
      defaultModelByProvider: new Map([["zai", "glm-5.1"]]),
    });
    expect(decisions[0]?.replacementModelId).toBe("glm-5.1");
  });

  it("returns null replacement when no candidate survives for the provider", () => {
    const decisions = buildReplacementDecisions({
      deprecated: [{ provider: "moonshot", modelId: "kimi-old" }],
      candidates,
    });
    expect(decisions).toEqual([
      { provider: "moonshot", deprecatedModelId: "kimi-old", replacementModelId: null },
    ]);
  });
});

describe("planReassignments", () => {
  it("leaves non-deprecated bindings untouched", () => {
    const bindings: ModelBinding[] = [
      { kind: "cron-model", jobId: "j1", ref: { provider: "zai", modelId: "glm-5.1" } },
    ];
    const plan = planReassignments({ bindings, replacements });
    expect(plan.actions).toEqual([]);
    expect(plan.unresolved).toEqual([]);
  });

  it("rewrites a deprecated binding to its replacement (case-insensitive match)", () => {
    const bindings: ModelBinding[] = [
      { kind: "cron-model", jobId: "j1", ref: { provider: "zai", modelId: "GLM-4.6V" } },
    ];
    const plan = planReassignments({ bindings, replacements });
    expect(plan.actions).toEqual([
      { binding: bindings[0], outcome: "rewrite", replacementModelId: "glm-5.1" },
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  it("clears a deprecated binding with no survivor and records it unresolved", () => {
    const bindings: ModelBinding[] = [
      {
        kind: "agent-model",
        agentId: "podrick",
        sessionKey: "default",
        ref: { provider: "zai", modelId: "glm-4-long" },
      },
    ];
    const plan = planReassignments({ bindings, replacements });
    expect(plan.actions).toEqual([{ binding: bindings[0], outcome: "clear" }]);
    expect(plan.unresolved).toEqual([bindings[0]]);
  });

  it("clears when the only replacement equals the deprecated id (no real survivor)", () => {
    const bindings: ModelBinding[] = [
      { kind: "alias", alias: "GLM", ref: { provider: "zai", modelId: "glm-x" } },
    ];
    const plan = planReassignments({
      bindings,
      replacements: [{ provider: "zai", deprecatedModelId: "glm-x", replacementModelId: "glm-x" }],
    });
    expect(plan.actions).toEqual([{ binding: bindings[0], outcome: "clear" }]);
    expect(plan.unresolved).toEqual([bindings[0]]);
  });

  it("handles mixed binding kinds in one pass", () => {
    const bindings: ModelBinding[] = [
      { kind: "cron-model", jobId: "j1", ref: { provider: "zai", modelId: "glm-4.6v" } },
      {
        kind: "cron-fallback",
        jobId: "j1",
        index: 0,
        ref: { provider: "zai", modelId: "glm-4-long" },
      },
      {
        kind: "agent-model",
        agentId: "a",
        sessionKey: "s",
        ref: { provider: "zai", modelId: "glm-5" },
      },
      { kind: "alias", alias: "Long", ref: { provider: "zai", modelId: "glm-4-long" } },
    ];
    const plan = planReassignments({ bindings, replacements });
    expect(plan.actions).toEqual([
      { binding: bindings[0], outcome: "rewrite", replacementModelId: "glm-5.1" },
      { binding: bindings[1], outcome: "clear" },
      { binding: bindings[3], outcome: "clear" },
    ]);
    expect(plan.unresolved).toEqual([bindings[1], bindings[3]]);
  });
});
