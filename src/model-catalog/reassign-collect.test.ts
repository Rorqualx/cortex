// Covers binding collectors for cron jobs, agent sessions, and aliases.
import { describe, expect, it } from "vitest";
import type { CronJob, CronStoreFile } from "../cron/types.js";
import {
  collectAgentBindings,
  collectAliasBindings,
  collectCronBindings,
  type ResolveRef,
  type SessionOverrideEntry,
} from "./reassign-collect.js";
import type { ResolvedModelRef } from "./reassign-plan.js";

// Test resolver: "provider/model" splits; bare returns null; provider hint used as provider.
const resolveRef: ResolveRef = (raw, providerHint) => {
  const slash = raw.indexOf("/");
  if (slash > 0) {
    return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
  }
  return providerHint ? { provider: providerHint, modelId: raw } : null;
};

function cronJob(id: string, model: string | undefined, fallbacks?: string[]): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 1000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: "go",
      ...(model ? { model } : {}),
      ...(fallbacks ? { fallbacks } : {}),
    },
    state: {},
  };
}

describe("collectCronBindings", () => {
  it("emits model + indexed fallback bindings for agentTurn jobs", () => {
    const store: CronStoreFile = {
      version: 1,
      jobs: [cronJob("j1", "zai/glm-4.6v", ["zai/glm-5", "bare-no-provider"])],
    };
    expect(collectCronBindings(store, resolveRef)).toEqual([
      { kind: "cron-model", jobId: "j1", ref: { provider: "zai", modelId: "glm-4.6v" } },
      { kind: "cron-fallback", jobId: "j1", index: 0, ref: { provider: "zai", modelId: "glm-5" } },
      // index 1 ("bare-no-provider") resolves to null and is skipped, but index numbering
      // for surviving entries reflects the original fallback position.
    ]);
  });

  it("skips systemEvent jobs", () => {
    const store: CronStoreFile = {
      version: 1,
      jobs: [{ ...cronJob("j1", undefined), payload: { kind: "systemEvent", text: "x" } }],
    };
    expect(collectCronBindings(store, resolveRef)).toEqual([]);
  });
});

describe("collectAgentBindings", () => {
  it("resolves each session override using its provider hint", () => {
    const entries: [string, SessionOverrideEntry][] = [
      ["default", { modelOverride: "glm-4-long", providerOverride: "zai" }],
      ["other", { modelOverride: "zai/glm-5.1" }],
    ];
    expect(collectAgentBindings("podrick", entries, resolveRef)).toEqual([
      {
        kind: "agent-model",
        agentId: "podrick",
        sessionKey: "default",
        ref: { provider: "zai", modelId: "glm-4-long" },
      },
      {
        kind: "agent-model",
        agentId: "podrick",
        sessionKey: "other",
        ref: { provider: "zai", modelId: "glm-5.1" },
      },
    ]);
  });

  it("skips entries without a model override", () => {
    const entries: [string, SessionOverrideEntry][] = [["default", {}]];
    expect(collectAgentBindings("a", entries, resolveRef)).toEqual([]);
  });
});

describe("collectAliasBindings", () => {
  it("emits one binding per alias", () => {
    const aliases: { alias: string; ref: ResolvedModelRef }[] = [
      { alias: "GLM", ref: { provider: "zai", modelId: "glm-5.1" } },
      { alias: "Podrick Cloud", ref: { provider: "zai", modelId: "glm-4.5-flash" } },
    ];
    expect(collectAliasBindings(aliases)).toEqual([
      { kind: "alias", alias: "GLM", ref: { provider: "zai", modelId: "glm-5.1" } },
      { kind: "alias", alias: "Podrick Cloud", ref: { provider: "zai", modelId: "glm-4.5-flash" } },
    ]);
  });
});
