import { describe, expect, it } from "vitest";
import {
  isSessionWriteLockBusyWithActiveRun,
  SessionWriteLockStaleError,
  SessionWriteLockTimeoutError,
} from "./session-write-lock-error.js";

function timeoutError(overrides: {
  ownerPid?: number | undefined;
  ownerPidAlive?: boolean;
}): SessionWriteLockTimeoutError {
  return new SessionWriteLockTimeoutError({
    timeoutMs: 60_000,
    owner: "pid=1 alive=true",
    lockPath: "/tmp/session.jsonl.lock",
    ...overrides,
  });
}

describe("isSessionWriteLockBusyWithActiveRun", () => {
  it("is true when a live owner in this process holds the lock", () => {
    expect(
      isSessionWriteLockBusyWithActiveRun(
        timeoutError({ ownerPid: process.pid, ownerPidAlive: true }),
      ),
    ).toBe(true);
  });

  it("is false when the live owner is a different process", () => {
    expect(
      isSessionWriteLockBusyWithActiveRun(
        timeoutError({ ownerPid: process.pid + 1, ownerPidAlive: true }),
      ),
    ).toBe(false);
  });

  it("is false when the same-pid owner is no longer alive (stale/crashed)", () => {
    expect(
      isSessionWriteLockBusyWithActiveRun(
        timeoutError({ ownerPid: process.pid, ownerPidAlive: false }),
      ),
    ).toBe(false);
  });

  it("is false when no owner pid was recorded", () => {
    expect(isSessionWriteLockBusyWithActiveRun(timeoutError({ ownerPidAlive: true }))).toBe(false);
  });

  it("is false for non-timeout lock errors and unrelated errors", () => {
    expect(
      isSessionWriteLockBusyWithActiveRun(
        new SessionWriteLockStaleError({ owner: "pid=1", lockPath: "/tmp/x.lock" }),
      ),
    ).toBe(false);
    expect(isSessionWriteLockBusyWithActiveRun(new Error("boom"))).toBe(false);
    expect(isSessionWriteLockBusyWithActiveRun(undefined)).toBe(false);
  });
});
