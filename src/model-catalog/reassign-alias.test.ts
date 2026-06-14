// Covers the config alias-map rewriter: repoint+relabel and drop.
import { describe, expect, it } from "vitest";
import { type AliasModelMap, applyAliasReassignments } from "./reassign-alias.js";
import type { ReassignmentAction } from "./reassign-plan.js";

const aliases: AliasModelMap = {
  "zai/glm-5.1": { alias: "GLM" },
  "kimi/kimi-for-coding": { alias: "Kimi" },
  "zai/glm-4-long": { alias: "GLM 4 Long" },
};

describe("applyAliasReassignments", () => {
  it("repoints an alias to the replacement and keeps the label when no display name", () => {
    const actions: ReassignmentAction[] = [
      {
        binding: { kind: "alias", alias: "GLM", ref: { provider: "zai", modelId: "glm-5.1" } },
        outcome: "rewrite",
        replacementModelId: "glm-5.2",
      },
    ];
    const { aliases: next, changes } = applyAliasReassignments({ aliases, actions });
    expect(next["zai/glm-5.1"]).toBeUndefined();
    expect(next["zai/glm-5.2"]).toEqual({ alias: "GLM" });
    expect(changes).toEqual([
      {
        alias: "GLM",
        outcome: "repoint",
        fromKey: "zai/glm-5.1",
        toKey: "zai/glm-5.2",
        newLabel: "GLM",
      },
    ]);
  });

  it("relabels to the live display name when discovery provides one", () => {
    const actions: ReassignmentAction[] = [
      {
        binding: {
          kind: "alias",
          alias: "Kimi",
          ref: { provider: "kimi", modelId: "kimi-for-coding" },
        },
        outcome: "rewrite",
        replacementModelId: "kimi-for-coding-next",
      },
    ];
    const { aliases: next } = applyAliasReassignments({
      aliases,
      actions,
      displayNameFor: (p, id) => (id === "kimi-for-coding-next" ? "K3 Code" : undefined),
    });
    expect(next["kimi/kimi-for-coding-next"]).toEqual({ alias: "K3 Code" });
  });

  it("drops an alias whose model has no replacement", () => {
    const actions: ReassignmentAction[] = [
      {
        binding: {
          kind: "alias",
          alias: "GLM 4 Long",
          ref: { provider: "zai", modelId: "glm-4-long" },
        },
        outcome: "clear",
      },
    ];
    const { aliases: next, changes } = applyAliasReassignments({ aliases, actions });
    expect(next["zai/glm-4-long"]).toBeUndefined();
    expect(changes).toEqual([{ alias: "GLM 4 Long", outcome: "drop", fromKey: "zai/glm-4-long" }]);
  });

  it("preserves other entries and non-alias fields", () => {
    const withExtra: AliasModelMap = { "zai/glm-5.1": { alias: "GLM", thinking: "high" } };
    const actions: ReassignmentAction[] = [
      {
        binding: { kind: "alias", alias: "GLM", ref: { provider: "zai", modelId: "glm-5.1" } },
        outcome: "rewrite",
        replacementModelId: "glm-5.2",
      },
    ];
    const { aliases: next } = applyAliasReassignments({ aliases: withExtra, actions });
    expect(next["zai/glm-5.2"]).toEqual({ alias: "GLM", thinking: "high" });
  });

  it("ignores non-alias actions and unmatched aliases", () => {
    const actions: ReassignmentAction[] = [
      {
        binding: { kind: "cron-model", jobId: "j1", ref: { provider: "zai", modelId: "glm-5.1" } },
        outcome: "clear",
      },
      {
        binding: { kind: "alias", alias: "Nonexistent", ref: { provider: "zai", modelId: "x" } },
        outcome: "clear",
      },
    ];
    const { aliases: next, changes } = applyAliasReassignments({ aliases, actions });
    expect(changes).toEqual([]);
    expect(next).toEqual(aliases);
  });
});
