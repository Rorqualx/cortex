import { describe, expect, it, vi } from "vitest";
import { createDoomLoopGuard, DoomLoopDetectedError } from "./doom-loop-guard.js";

describe("createDoomLoopGuard", () => {
  it("starts unarmed and does not count failures", () => {
    const guard = createDoomLoopGuard();
    const result = guard.recordFailure("tool_error", Date.now());
    expect(result.shouldAbort).toBe(false);
    expect(result.consecutiveFailures).toBe(0);
  });

  it("counts failures after arming", () => {
    const guard = createDoomLoopGuard({ maxConsecutiveFailures: 3 });
    guard.arm();
    guard.recordFailure("tool_error", Date.now());
    guard.recordFailure("tool_error", Date.now());
    const result = guard.recordFailure("tool_error", Date.now());
    expect(result.shouldAbort).toBe(true);
    expect(result.consecutiveFailures).toBe(3);
  });

  it("reset clears failures and records lastSuccessAt", () => {
    const guard = createDoomLoopGuard({ maxConsecutiveFailures: 3 });
    guard.arm();
    guard.recordFailure("tool_error", Date.now());
    guard.reset();
    const snapshot = guard.snapshot();
    expect(snapshot.consecutiveFailures).toBe(0);
    expect(snapshot.lastSuccessAt).toBeTypeOf("number");
    expect(snapshot.lastFailureAt).toBeUndefined();
  });

  it("getFailureBoundary returns lastSuccessAt after reset", () => {
    const guard = createDoomLoopGuard();
    expect(guard.getFailureBoundary()).toBeUndefined();
    guard.reset();
    const boundary = guard.getFailureBoundary();
    expect(boundary).toBeTypeOf("number");
    expect(boundary).toBeGreaterThan(0);
  });

  it("snapshot includes lastSuccessAt", () => {
    const guard = createDoomLoopGuard();
    guard.reset();
    const snap = guard.snapshot();
    expect(snap.lastSuccessAt).toBeTypeOf("number");
  });

  it("createRevisePrompt includes checkpoint when boundary exists", () => {
    const guard = createDoomLoopGuard();
    guard.arm();
    guard.reset();
    const prompt = guard.createRevisePrompt();
    expect(prompt).toContain("Doom-loop recovery triggered");
    expect(prompt).toContain("last successful checkpoint:");
    expect(prompt).toContain("Do NOT retry the same strategy");
    expect(prompt).toContain("try a different strategy");
  });

  it("createRevisePrompt works without boundary", () => {
    const guard = createDoomLoopGuard();
    guard.arm();
    const prompt = guard.createRevisePrompt();
    expect(prompt).toContain("Doom-loop recovery triggered");
    expect(prompt).not.toContain("last successful checkpoint:");
  });

  it("DoomLoopDetectedError.fromVerdict captures details", () => {
    const verdict = {
      shouldAbort: true as const,
      consecutiveFailures: 5,
      reason: "test doom",
      detector: "doom_loop" as const,
    };
    const err = DoomLoopDetectedError.fromVerdict(verdict);
    expect(err.name).toBe("DoomLoopDetectedError");
    expect(err.consecutiveFailures).toBe(5);
    expect(err.detector).toBe("doom_loop");
  });

  it("failure window expiration resets counter", () => {
    const now = 1_000_000;
    const guard = createDoomLoopGuard({
      maxConsecutiveFailures: 3,
      failureWindowMs: 100,
    });
    guard.arm();
    guard.recordFailure("tool_error", now);
    guard.recordFailure("tool_error", now + 50);
    // Third failure is outside the window
    const result = guard.recordFailure("tool_error", now + 200);
    expect(result.shouldAbort).toBe(false);
    expect(result.consecutiveFailures).toBe(1);
  });
});
