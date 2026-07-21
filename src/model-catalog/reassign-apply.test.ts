// Covers applying a reassignment plan to (injected) cron + agent session stores.
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { CronJob, CronStoreFile } from "../cron/types.js";
import { applyReassignmentPlan } from "./reassign-apply.js";
import type { ReassignmentPlan } from "./reassign-plan.js";

function cronJob(id: string, model: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 1000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "go", model },
    state: {},
  };
}

const plan: ReassignmentPlan = {
  actions: [
    {
      binding: { kind: "cron-model", jobId: "j1", ref: { provider: "zai", modelId: "glm-4.6v" } },
      outcome: "rewrite",
      replacementModelId: "glm-5.1",
    },
    {
      binding: {
        kind: "agent-model",
        agentId: "podrick",
        sessionKey: "default",
        ref: { provider: "zai", modelId: "glm-4-long" },
      },
      outcome: "clear",
    },
    {
      binding: {
        kind: "alias",
        alias: "Podrick Cloud",
        ref: { provider: "zai", modelId: "glm-4.5-flash" },
      },
      outcome: "clear",
    },
  ],
  unresolved: [],
};

function deps(overrides?: Partial<Parameters<typeof applyReassignmentPlan>[1]>) {
  const saved: CronStoreFile[] = [];
  const patches: { agentId: string; sessionKey: string; patch: Partial<SessionEntry> }[] = [];
  return {
    saved,
    patches,
    base: {
      loadCronStore: async (): Promise<CronStoreFile> => ({
        version: 1,
        jobs: [cronJob("j1", "zai/glm-4.6v")],
      }),
      saveCronStore: async (store: CronStoreFile) => {
        saved.push(store);
      },
      patchAgentSession: async (
        agentId: string,
        sessionKey: string,
        patch: Partial<SessionEntry>,
      ) => {
        patches.push({ agentId, sessionKey, patch });
      },
      nowMs: 123,
      ...overrides,
    },
  };
}

describe("applyReassignmentPlan", () => {
  it("rewrites crons, clears agent overrides, and surfaces dead aliases", async () => {
    const d = deps();
    const result = await applyReassignmentPlan(plan, d.base);
    expect(result.cronChanges).toEqual([
      { jobId: "j1", field: "model", from: "zai/glm-4.6v", to: "zai/glm-5.1" },
    ]);
    expect(result.agentChanges).toEqual([
      { agentId: "podrick", sessionKey: "default", from: "zai/glm-4-long", to: null },
    ]);
    expect(result.deadAliases).toEqual(["Podrick Cloud"]);
    // cron store saved once with the rewritten model
    expect(d.saved).toHaveLength(1);
    const savedFile = d.saved[0];
    if (!savedFile) throw new Error("expected saved cron store");
    const savedJob = savedFile.jobs[0];
    if (!savedJob) throw new Error("expected saved job");
    const payload = savedJob.payload;
    expect(payload.kind === "agentTurn" && payload.model).toBe("zai/glm-5.1");
    // agent session patched to clear the override
    expect(d.patches).toEqual([
      {
        agentId: "podrick",
        sessionKey: "default",
        patch: {
          modelOverride: undefined,
          providerOverride: undefined,
          modelOverrideSource: undefined,
        },
      },
    ]);
  });

  it("computes changes but writes nothing under dryRun", async () => {
    const d = deps({ dryRun: true });
    const result = await applyReassignmentPlan(plan, d.base);
    expect(result.cronChanges).toHaveLength(1);
    expect(result.agentChanges).toHaveLength(1);
    expect(d.saved).toHaveLength(0);
    expect(d.patches).toHaveLength(0);
  });

  it("does not load the cron store when no cron actions exist", async () => {
    const loadCronStore = vi.fn(async (): Promise<CronStoreFile> => ({ version: 1, jobs: [] }));
    const agentAction = plan.actions[1];
    if (!agentAction) throw new Error("expected agent action");
    const agentOnlyPlan: ReassignmentPlan = {
      actions: [agentAction],
      unresolved: [],
    };
    const d = deps({ loadCronStore });
    await applyReassignmentPlan(agentOnlyPlan, d.base);
    expect(loadCronStore).not.toHaveBeenCalled();
    expect(d.patches).toHaveLength(1);
  });
});
