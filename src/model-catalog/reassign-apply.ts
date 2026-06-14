/**
 * Applies a reassignment plan to live runtime state: cron jobs (one store
 * load/save) and agent session overrides (one patch per affected session).
 * Store operations are injected so this is integration-testable with in-memory
 * deps and reusable by the doctor `--fix` repair.
 *
 * Config aliases are NOT mutated here — dropping dead aliases is a config edit
 * owned by config normalization (Part A / doctor config repair); this surfaces
 * them as warnings so the caller can report them.
 */
import type { SessionEntry } from "../config/sessions/types.js";
import type { CronStoreFile } from "../cron/types.js";
import { buildAgentModelPatch } from "./reassign-agent.js";
import { type CronReassignmentChange, applyCronReassignments } from "./reassign-cron.js";
import type { ReassignmentAction, ReassignmentPlan } from "./reassign-plan.js";

/** Injected store ops + run mode for applying a plan. */
export type ReassignApplyDeps = {
  loadCronStore: () => Promise<CronStoreFile>;
  saveCronStore: (store: CronStoreFile) => Promise<void>;
  patchAgentSession: (
    agentId: string,
    sessionKey: string,
    patch: Partial<SessionEntry>,
  ) => Promise<void>;
  nowMs: number;
  /** When true, compute changes but do not write. */
  dryRun?: boolean;
};

/** One applied agent-session override change, for reporting. */
export type AgentReassignmentChange = {
  agentId: string;
  sessionKey: string;
  from: string;
  to: string | null;
};

/** Summary of what a plan changed (or would change under dryRun). */
export type ReassignApplyResult = {
  cronChanges: CronReassignmentChange[];
  agentChanges: AgentReassignmentChange[];
  /** Aliases pointing at a deprecated model; cleaned by config normalization. */
  deadAliases: string[];
};

function hasCronAction(actions: readonly ReassignmentAction[]): boolean {
  return actions.some((a) => a.binding.kind === "cron-model" || a.binding.kind === "cron-fallback");
}

export async function applyReassignmentPlan(
  plan: ReassignmentPlan,
  deps: ReassignApplyDeps,
): Promise<ReassignApplyResult> {
  const cronChanges = await applyCronActions(plan.actions, deps);
  const agentChanges = await applyAgentActions(plan.actions, deps);
  const deadAliases = plan.actions
    .filter((a) => a.binding.kind === "alias")
    .map((a) => (a.binding.kind === "alias" ? a.binding.alias : ""))
    .filter(Boolean);
  return { cronChanges, agentChanges, deadAliases };
}

async function applyCronActions(
  actions: readonly ReassignmentAction[],
  deps: ReassignApplyDeps,
): Promise<CronReassignmentChange[]> {
  if (!hasCronAction(actions)) {
    return [];
  }
  const store = await deps.loadCronStore();
  const { store: nextStore, changes } = applyCronReassignments(store, actions, deps.nowMs);
  if (changes.length > 0 && !deps.dryRun) {
    await deps.saveCronStore(nextStore);
  }
  return changes;
}

async function applyAgentActions(
  actions: readonly ReassignmentAction[],
  deps: ReassignApplyDeps,
): Promise<AgentReassignmentChange[]> {
  const changes: AgentReassignmentChange[] = [];
  for (const action of actions) {
    if (action.binding.kind !== "agent-model") {
      continue;
    }
    const patch = buildAgentModelPatch(action);
    if (!patch) {
      continue;
    }
    const { agentId, sessionKey, ref } = action.binding;
    changes.push({
      agentId,
      sessionKey,
      from: `${ref.provider}/${ref.modelId}`,
      to: patch.modelOverride ?? null,
    });
    if (!deps.dryRun) {
      await deps.patchAgentSession(agentId, sessionKey, patch);
    }
  }
  return changes;
}
