import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import type { CronServiceState } from "./state.js";
import { isRunnableJob } from "./timer-runnable.js";

// A daily 10:00 UTC cron, evaluated at 12:00 with the 10:00 slot already past and the last run
// from the day before — i.e. today's slot was missed while the gateway was down.
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const MISSED_SLOT = Date.UTC(2026, 7, 30, 10, 0, 0);
const YESTERDAY_RUN = Date.UTC(2026, 7, 29, 10, 0, 0);

function dailyCronJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    name: "daily",
    enabled: true,
    schedule: { kind: "cron", expr: "0 10 * * *", tz: "UTC" },
    payload: { kind: "agentTurn", message: "x" },
    createdAtMs: Date.UTC(2026, 0, 1),
    updatedAtMs: Date.UTC(2026, 0, 1),
    state: { nextRunAtMs: MISSED_SLOT, lastRunAtMs: YESTERDAY_RUN, lastRunStatus: "ok" },
    ...overrides,
  } as CronJob;
}

// isRunnableJob reads only the job and params, never params.state.
const state = {} as CronServiceState;

describe("isRunnableJob skipMissedRuns", () => {
  it("suppresses a missed cron slot during the startup catch-up pass", () => {
    const job = dailyCronJob({ skipMissedRuns: true });
    expect(isRunnableJob({ state, job, nowMs: NOW, allowCronMissedRunByLastRun: true })).toBe(
      false,
    );
  });

  it("replays a missed cron slot during startup catch-up by default", () => {
    const job = dailyCronJob();
    expect(isRunnableJob({ state, job, nowMs: NOW, allowCronMissedRunByLastRun: true })).toBe(true);
  });

  it("still fires a due slot on a normal tick with skipMissedRuns set (only catch-up is skipped)", () => {
    const job = dailyCronJob({ skipMissedRuns: true });
    expect(isRunnableJob({ state, job, nowMs: NOW })).toBe(true);
  });
});
