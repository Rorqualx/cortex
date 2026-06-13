import { describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueMessageOutcome } from "../../agents/embedded-agent-runner/runs.js";
import { steerWithCompactionRetry } from "./steer-compaction-retry.js";

const compacting = (): EmbeddedAgentQueueMessageOutcome => ({
  queued: false,
  sessionId: "s1",
  reason: "compacting",
  gatewayHealth: "live",
});
const queued = (): EmbeddedAgentQueueMessageOutcome => ({
  queued: true,
  sessionId: "s1",
  target: "embedded_run",
  gatewayHealth: "live",
});
const noActiveRun = (): EmbeddedAgentQueueMessageOutcome => ({
  queued: false,
  sessionId: "s1",
  reason: "no_active_run",
  gatewayHealth: "live",
});

const noDelay = () => Promise.resolve();

describe("steerWithCompactionRetry", () => {
  it("returns immediately when the first attempt is accepted", async () => {
    const attempt = vi.fn().mockResolvedValueOnce(queued());
    const outcome = await steerWithCompactionRetry({ attempt, delay: noDelay });
    expect(outcome.queued).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("retries through compaction and succeeds once it settles", async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce(compacting())
      .mockResolvedValueOnce(compacting())
      .mockResolvedValueOnce(queued());
    const outcome = await steerWithCompactionRetry({ attempt, delay: noDelay });
    expect(outcome.queued).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("stops retrying and surfaces the failure once the budget is exhausted", async () => {
    let clock = 0;
    const now = () => clock;
    const delay = (ms: number) => {
      clock += ms;
      return Promise.resolve();
    };
    const attempt = vi.fn().mockResolvedValue(compacting());
    const outcome = await steerWithCompactionRetry({
      attempt,
      budgetMs: 1_000,
      pollMs: 250,
      now,
      delay,
    });
    expect(outcome.queued).toBe(false);
    expect(outcome.queued === false && outcome.reason).toBe("compacting");
    // initial attempt + 4 polls (0,250,500,750) before the clock reaches 1000.
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it("stops retrying as soon as the run is no longer active", async () => {
    const attempt = vi.fn().mockResolvedValue(compacting());
    const outcome = await steerWithCompactionRetry({
      attempt,
      isRunActive: () => false,
      delay: noDelay,
    });
    expect(outcome.queued).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry a terminal (non-compacting) failure", async () => {
    const attempt = vi.fn().mockResolvedValueOnce(noActiveRun());
    const outcome = await steerWithCompactionRetry({ attempt, delay: noDelay });
    expect(outcome.queued === false && outcome.reason).toBe("no_active_run");
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
