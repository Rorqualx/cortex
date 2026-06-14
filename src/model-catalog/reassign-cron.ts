/**
 * Pure cron-store transform that applies reassignment actions to a loaded
 * `CronStoreFile`. The cron store loads and saves the whole file, so this stays a
 * pure value->value rewrite (testable without SQLite); the doctor `--fix` flow
 * loads the store, applies this, and saves once.
 *
 * Rewrite swaps a deprecated cron `payload.model`/fallback to the qualified
 * replacement ref. Clear (no survivor) disables the job rather than running it on
 * a dead model; a cleared fallback entry is dropped from the list.
 */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { CronJob, CronStoreFile } from "../cron/types.js";
import type { ReassignmentAction, ResolvedModelRef } from "./reassign-plan.js";

/** One concrete change applied to a cron job, for reporting/warnings. */
export type CronReassignmentChange = {
  jobId: string;
  field: "model" | "fallback";
  /** Fallback list index when `field === "fallback"`. */
  index?: number;
  from: string;
  /** Replacement qualified ref, or null when the entry was removed/job disabled. */
  to: string | null;
  /** True when the job was disabled because its model had no replacement. */
  disabled?: boolean;
};

function qualify(ref: ResolvedModelRef, replacementModelId: string): string {
  return buildModelCatalogRef(ref.provider, replacementModelId);
}

type JobPlan = {
  modelRewrite?: string;
  disable?: boolean;
  fallbackRewrites: Map<number, string>;
  fallbackRemovals: Set<number>;
};

function emptyJobPlan(): JobPlan {
  return { fallbackRewrites: new Map(), fallbackRemovals: new Set() };
}

/** Groups actions by cron job id; ignores non-cron actions. */
function groupByJob(actions: readonly ReassignmentAction[]): Map<string, JobPlan> {
  const byJob = new Map<string, JobPlan>();
  for (const action of actions) {
    const { binding } = action;
    if (binding.kind !== "cron-model" && binding.kind !== "cron-fallback") {
      continue;
    }
    const plan = byJob.get(binding.jobId) ?? emptyJobPlan();
    byJob.set(binding.jobId, plan);
    if (binding.kind === "cron-model") {
      if (action.outcome === "rewrite") {
        plan.modelRewrite = qualify(binding.ref, action.replacementModelId);
      } else {
        plan.disable = true;
      }
      continue;
    }
    if (action.outcome === "rewrite") {
      plan.fallbackRewrites.set(binding.index, qualify(binding.ref, action.replacementModelId));
    } else {
      plan.fallbackRemovals.add(binding.index);
    }
  }
  return byJob;
}

function rewriteFallbacks(
  jobId: string,
  fallbacks: readonly string[],
  plan: JobPlan,
  changes: CronReassignmentChange[],
): string[] {
  const next: string[] = [];
  fallbacks.forEach((entry, index) => {
    if (plan.fallbackRemovals.has(index)) {
      changes.push({ jobId, field: "fallback", index, from: entry, to: null });
      return;
    }
    const replacement = plan.fallbackRewrites.get(index);
    if (replacement && replacement !== entry) {
      changes.push({ jobId, field: "fallback", index, from: entry, to: replacement });
      next.push(replacement);
      return;
    }
    next.push(entry);
  });
  return next;
}

function applyJobPlan(
  job: CronJob,
  plan: JobPlan,
  nowMs: number,
): { job: CronJob; changes: CronReassignmentChange[] } {
  if (job.payload.kind !== "agentTurn") {
    return { job, changes: [] };
  }
  const changes: CronReassignmentChange[] = [];
  let payload = job.payload;
  let enabled = job.enabled;

  if (plan.modelRewrite && payload.model && payload.model !== plan.modelRewrite) {
    changes.push({ jobId: job.id, field: "model", from: payload.model, to: plan.modelRewrite });
    payload = { ...payload, model: plan.modelRewrite };
  } else if (plan.disable && payload.model && enabled) {
    changes.push({ jobId: job.id, field: "model", from: payload.model, to: null, disabled: true });
    enabled = false;
  }

  if (payload.fallbacks && (plan.fallbackRewrites.size > 0 || plan.fallbackRemovals.size > 0)) {
    const nextFallbacks = rewriteFallbacks(job.id, payload.fallbacks, plan, changes);
    if (changes.some((c) => c.field === "fallback")) {
      payload =
        nextFallbacks.length > 0
          ? { ...payload, fallbacks: nextFallbacks }
          : omitFallbacks(payload);
    }
  }

  if (changes.length === 0) {
    return { job, changes };
  }
  return { job: { ...job, payload, enabled, updatedAtMs: nowMs }, changes };
}

function omitFallbacks(payload: Extract<CronJob["payload"], { kind: "agentTurn" }>) {
  const { fallbacks: _drop, ...rest } = payload;
  return rest;
}

/**
 * Applies reassignment actions to a cron store, returning a new store and the
 * list of changes. Only `cron-model`/`cron-fallback` actions are consulted; jobs
 * with no matching action are returned unchanged.
 */
export function applyCronReassignments(
  store: CronStoreFile,
  actions: readonly ReassignmentAction[],
  nowMs: number,
): { store: CronStoreFile; changes: CronReassignmentChange[] } {
  const byJob = groupByJob(actions);
  if (byJob.size === 0) {
    return { store, changes: [] };
  }
  const changes: CronReassignmentChange[] = [];
  let mutated = false;
  const jobs = store.jobs.map((job) => {
    const plan = byJob.get(job.id);
    if (!plan) {
      return job;
    }
    const result = applyJobPlan(job, plan, nowMs);
    if (result.changes.length > 0) {
      mutated = true;
      changes.push(...result.changes);
    }
    return result.job;
  });
  return { store: mutated ? { ...store, jobs } : store, changes };
}
