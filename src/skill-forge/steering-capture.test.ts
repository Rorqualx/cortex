import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  queueSteeringPreemptCapture,
  resetSteeringCaptureThrottleForTests,
  STEERING_CAPTURE_THROTTLE_MS,
} from "./steering-capture.js";

const captureSessionToForge = vi.hoisted(() => vi.fn());

vi.mock("./capture.js", () => ({
  captureSessionToForge: captureSessionToForge,
}));

describe("queueSteeringPreemptCapture", () => {
  beforeEach(() => {
    resetSteeringCaptureThrottleForTests();
    captureSessionToForge.mockReset();
    captureSessionToForge.mockResolvedValue({
      status: "captured",
      outputDir: "/tmp/forge-capture",
      manifest: { trigger: "steering-preempt" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const baseParams = {
    sessionId: "embedded-run-1",
    sessionFile: "/state/sessions/embedded-run-1.jsonl",
    sessionKey: "telegram:12345:chat",
    workspaceDir: "/workspace",
  };

  it("queues a steering-preempt capture tagged with the session id", () => {
    let clock = 1_000_000;
    const queued = queueSteeringPreemptCapture({ ...baseParams, now: () => clock });

    expect(queued).toBe(true);
    expect(captureSessionToForge).toHaveBeenCalledTimes(1);
    expect(captureSessionToForge).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "embedded-run-1",
        sessionFile: baseParams.sessionFile,
        sessionKey: baseParams.sessionKey,
        workspaceDir: baseParams.workspaceDir,
        trigger: "steering-preempt",
      }),
    );

    // Detached promise resolves without throwing into the caller.
    return new Promise<void>((resolve) => setImmediate(() => resolve()));
  });

  it("throttles repeat preempts for the same session within the hour", () => {
    let clock = 1_000_000;
    const first = queueSteeringPreemptCapture({ ...baseParams, now: () => clock });
    const second = queueSteeringPreemptCapture({
      ...baseParams,
      now: () => clock + STEERING_CAPTURE_THROTTLE_MS - 1,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(captureSessionToForge).toHaveBeenCalledTimes(1);
  });

  it("allows a new capture after the throttle window elapses", () => {
    let clock = 1_000_000;
    expect(queueSteeringPreemptCapture({ ...baseParams, now: () => clock })).toBe(true);
    clock += STEERING_CAPTURE_THROTTLE_MS;
    expect(queueSteeringPreemptCapture({ ...baseParams, now: () => clock })).toBe(true);
    expect(captureSessionToForge).toHaveBeenCalledTimes(2);
  });

  it("throttles independently per session", () => {
    const clock = () => 1_000_000;
    expect(queueSteeringPreemptCapture({ ...baseParams, sessionId: "run-a", now: clock })).toBe(
      true,
    );
    expect(queueSteeringPreemptCapture({ ...baseParams, sessionId: "run-b", now: clock })).toBe(
      true,
    );
    expect(captureSessionToForge).toHaveBeenCalledTimes(2);
  });

  it("skips queuing when no session file is known", () => {
    const queued = queueSteeringPreemptCapture({
      ...baseParams,
      sessionFile: undefined,
      now: () => 1_000_000,
    });
    expect(queued).toBe(false);
    expect(captureSessionToForge).not.toHaveBeenCalled();
  });

  it("never throws when the capture promise rejects", async () => {
    captureSessionToForge.mockRejectedValue(new Error("boom"));
    const queued = queueSteeringPreemptCapture({ ...baseParams, now: () => 1_000_000 });
    expect(queued).toBe(true);
    // Flush microtasks; the rejection is swallowed by the debug handler.
    await Promise.resolve();
    await Promise.resolve();
    expect(true).toBe(true);
  });
});
