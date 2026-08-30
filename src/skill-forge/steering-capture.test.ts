import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STEERING_CAPTURE_MIN_INTERVAL_MS,
  queueSteeringPreemptCapture,
  resetSteeringCaptureThrottleState,
  steeringCaptureDue,
} from "./steering-capture.js";
import type { CaptureResult } from "./types.js";

const captureResult: CaptureResult = { status: "skipped", reason: "test stub" };

describe("steeringCaptureDue", () => {
  afterEach(() => {
    resetSteeringCaptureThrottleState();
  });

  it("is due for a fresh session", () => {
    expect(steeringCaptureDue("s1", () => 1000)).toBe(true);
  });

  it("is not due within the throttle window", async () => {
    queueSteeringPreemptCapture(
      {
        sessionId: "s1",
        sessionFile: "sessions/s1.jsonl",
        workspaceDir: "/w",
        now: () => 1000,
      },
      { capture: async () => captureResult },
    );
    expect(steeringCaptureDue("s1", () => 2000)).toBe(false);
    // Once the capture settles, the throttle window alone governs.
    await vi.waitFor(() =>
      expect(steeringCaptureDue("s1", () => 1000 + STEERING_CAPTURE_MIN_INTERVAL_MS)).toBe(true),
    );
  });
});

describe("queueSteeringPreemptCapture", () => {
  afterEach(() => {
    resetSteeringCaptureThrottleState();
    vi.restoreAllMocks();
  });

  it("queues a steering-preempt capture and passes session identity through", async () => {
    const capture = vi.fn(async () => captureResult);
    const queued = queueSteeringPreemptCapture(
      {
        sessionId: "s1",
        sessionFile: "sessions/s1.jsonl",
        workspaceDir: "/w",
        sessionKey: "telegram:123",
        now: () => 1000,
      },
      { capture },
    );
    expect(queued).toBe(true);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture).toHaveBeenCalledWith({
      sessionFile: "sessions/s1.jsonl",
      sessionId: "s1",
      sessionKey: "telegram:123",
      workspaceDir: "/w",
      trigger: "steering-preempt",
    });
  });

  it("throttles to one capture per session per hour", async () => {
    const capture = vi.fn(async () => captureResult);
    let clock = 0;
    const input = {
      sessionId: "s2",
      sessionFile: "sessions/s2.jsonl",
      workspaceDir: "/w",
      now: () => clock,
    };
    expect(queueSteeringPreemptCapture(input, { capture })).toBe(true);
    clock = 1_000;
    expect(queueSteeringPreemptCapture(input, { capture })).toBe(false);
    // Wait for the first capture to settle out of the in-flight set, then
    // cross the throttle window.
    await vi.waitFor(() =>
      expect(steeringCaptureDue("s2", () => STEERING_CAPTURE_MIN_INTERVAL_MS + 1)).toBe(true),
    );
    clock = STEERING_CAPTURE_MIN_INTERVAL_MS + 1;
    expect(queueSteeringPreemptCapture(input, { capture })).toBe(true);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
  });

  it("dedupes independent sessions", async () => {
    const capture = vi.fn(async () => captureResult);
    expect(
      queueSteeringPreemptCapture(
        { sessionId: "a", sessionFile: "a.jsonl", workspaceDir: "/w", now: () => 5 },
        { capture },
      ),
    ).toBe(true);
    expect(
      queueSteeringPreemptCapture(
        { sessionId: "b", sessionFile: "b.jsonl", workspaceDir: "/w", now: () => 6 },
        { capture },
      ),
    ).toBe(true);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
  });

  it("never throws when the capture rejects", async () => {
    const capture = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(() =>
      queueSteeringPreemptCapture(
        { sessionId: "s3", sessionFile: "s3.jsonl", workspaceDir: "/w", now: () => 1 },
        { capture },
      ),
    ).not.toThrow();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    // The in-flight guard clears after rejection so later captures can queue.
    await vi.waitFor(() =>
      expect(
        queueSteeringPreemptCapture(
          {
            sessionId: "s3",
            sessionFile: "s3.jsonl",
            workspaceDir: "/w",
            now: () => STEERING_CAPTURE_MIN_INTERVAL_MS + 2,
          },
          { capture },
        ),
      ).toBe(true),
    );
  });
});
