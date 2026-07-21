// Covers the pure cron-store reassignment transform: rewrite, disable, fallbacks.
import { describe, expect, it } from "vitest";
import type { CronJob, CronStoreFile } from "../cron/types.js";
import { applyCronReassignments } from "./reassign-cron.js";
import type { ReassignmentAction } from "./reassign-plan.js";

function job(id: string, model: string | undefined, fallbacks?: string[]): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
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

function store(...jobs: CronJob[]): CronStoreFile {
  return { version: 1, jobs };
}

const NOW = 999;

describe("applyCronReassignments", () => {
  it("rewrites a deprecated payload model to the qualified replacement", () => {
    const s = store(job("j1", "zai/glm-4.6v"));
    const actions: ReassignmentAction[] = [
      {
        binding: { kind: "cron-model", jobId: "j1", ref: { provider: "zai", modelId: "glm-4.6v" } },
        outcome: "rewrite",
        replacementModelId: "glm-5.1",
      },
    ];
    const result = applyCronReassignments(s, actions, NOW);
    const job0 = result.store.jobs[0];
    if (!job0) throw new Error("expected job");
    const payload = job0.payload;
    expect(payload.kind === "agentTurn" && payload.model).toBe("zai/glm-5.1");
    expect(job0.updatedAtMs).toBe(NOW);
    expect(result.changes).toEqual([
      { jobId: "j1", field: "model", from: "zai/glm-4.6v", to: "zai/glm-5.1" },
    ]);
  });

  it("disables a job whose model has no replacement instead of running it dead", () => {
    const s = store(job("j1", "zai/glm-4-long"));
    const actions: ReassignmentAction[] = [
      {
        binding: {
          kind: "cron-model",
          jobId: "j1",
          ref: { provider: "zai", modelId: "glm-4-long" },
        },
        outcome: "clear",
      },
    ];
    const result = applyCronReassignments(s, actions, NOW);
    const job0 = result.store.jobs[0];
    if (!job0) throw new Error("expected job");
    expect(job0.enabled).toBe(false);
    const payload = job0.payload;
    // The dead model is kept on the disabled job for audit, not silently erased.
    expect(payload.kind === "agentTurn" && payload.model).toBe("zai/glm-4-long");
    expect(result.changes).toEqual([
      { jobId: "j1", field: "model", from: "zai/glm-4-long", to: null, disabled: true },
    ]);
  });

  it("rewrites and removes fallback entries by index in one pass", () => {
    const s = store(job("j1", "zai/glm-5.1", ["zai/glm-4.6v", "zai/glm-4-long", "zai/glm-5"]));
    const actions: ReassignmentAction[] = [
      {
        binding: {
          kind: "cron-fallback",
          jobId: "j1",
          index: 0,
          ref: { provider: "zai", modelId: "glm-4.6v" },
        },
        outcome: "rewrite",
        replacementModelId: "glm-5.1",
      },
      {
        binding: {
          kind: "cron-fallback",
          jobId: "j1",
          index: 1,
          ref: { provider: "zai", modelId: "glm-4-long" },
        },
        outcome: "clear",
      },
    ];
    const result = applyCronReassignments(s, actions, NOW);
    const job0 = result.store.jobs[0];
    if (!job0) throw new Error("expected job");
    const payload = job0.payload;
    expect(payload.kind === "agentTurn" && payload.fallbacks).toEqual(["zai/glm-5.1", "zai/glm-5"]);
    expect(result.changes).toEqual([
      { jobId: "j1", field: "fallback", index: 0, from: "zai/glm-4.6v", to: "zai/glm-5.1" },
      { jobId: "j1", field: "fallback", index: 1, from: "zai/glm-4-long", to: null },
    ]);
  });

  it("drops the fallbacks field entirely when every entry is removed", () => {
    const s = store(job("j1", "zai/glm-5.1", ["zai/glm-4-long"]));
    const actions: ReassignmentAction[] = [
      {
        binding: {
          kind: "cron-fallback",
          jobId: "j1",
          index: 0,
          ref: { provider: "zai", modelId: "glm-4-long" },
        },
        outcome: "clear",
      },
    ];
    const result = applyCronReassignments(s, actions, NOW);
    const job0 = result.store.jobs[0];
    if (!job0) throw new Error("expected job");
    const payload = job0.payload;
    expect(payload.kind === "agentTurn" && "fallbacks" in payload).toBe(false);
  });

  it("returns the same store object when nothing matches", () => {
    const s = store(job("j1", "zai/glm-5.1"));
    const result = applyCronReassignments(s, [], NOW);
    expect(result.store).toBe(s);
    expect(result.changes).toEqual([]);
  });

  it("leaves systemEvent jobs untouched", () => {
    const sysJob: CronJob = {
      ...job("j1", undefined),
      payload: { kind: "systemEvent", text: "tick" },
    };
    const actions: ReassignmentAction[] = [
      {
        binding: {
          kind: "cron-model",
          jobId: "j1",
          ref: { provider: "zai", modelId: "glm-4-long" },
        },
        outcome: "clear",
      },
    ];
    const result = applyCronReassignments(store(sysJob), actions, NOW);
    expect(result.changes).toEqual([]);
    expect(result.store.jobs[0]?.enabled).toBe(true);
  });
});
