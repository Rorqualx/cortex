/**
 * Session write-lock error types and guards.
 *
 * Session persistence uses stable error codes so callers can distinguish lock
 * contention or stale lock cleanup from ordinary write failures.
 */
const SESSION_WRITE_LOCK_TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
const SESSION_WRITE_LOCK_STALE_CODE = "OPENCLAW_SESSION_WRITE_LOCK_STALE";

/** Error thrown when a session write lock cannot be acquired before timeout. */
export class SessionWriteLockTimeoutError extends Error {
  readonly code = SESSION_WRITE_LOCK_TIMEOUT_CODE;
  readonly timeoutMs: number;
  readonly owner: string;
  readonly lockPath: string;
  /** PID recorded in the contended lock, when one was readable. */
  readonly ownerPid: number | undefined;
  /** Whether that owner PID was alive when the acquire gave up. */
  readonly ownerPidAlive: boolean;

  constructor(params: {
    timeoutMs: number;
    owner: string;
    lockPath: string;
    ownerPid?: number | undefined;
    ownerPidAlive?: boolean;
  }) {
    super(
      `session file locked (timeout ${params.timeoutMs}ms): ${params.owner} ${params.lockPath}`,
    );
    this.name = "SessionWriteLockTimeoutError";
    this.timeoutMs = params.timeoutMs;
    this.owner = params.owner;
    this.lockPath = params.lockPath;
    this.ownerPid = params.ownerPid;
    this.ownerPidAlive = params.ownerPidAlive ?? false;
  }
}

/** Error thrown when an existing session write lock is stale and needs cleanup. */
export class SessionWriteLockStaleError extends Error {
  readonly code = SESSION_WRITE_LOCK_STALE_CODE;
  readonly owner: string;
  readonly lockPath: string;
  readonly staleReasons: string[];

  constructor(params: { owner: string; lockPath: string; staleReasons?: string[] }) {
    const staleReasons = params.staleReasons?.length ? params.staleReasons : ["unknown"];
    super(
      `session file lock stale (${staleReasons.join(", ")}): ${params.owner} ${params.lockPath}`,
    );
    this.name = "SessionWriteLockStaleError";
    this.owner = params.owner;
    this.lockPath = params.lockPath;
    this.staleReasons = staleReasons;
  }
}

/** Returns whether an error is a session write-lock timeout. */
export function isSessionWriteLockTimeoutError(err: unknown): boolean {
  return (
    err instanceof SessionWriteLockTimeoutError ||
    Boolean(
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === SESSION_WRITE_LOCK_TIMEOUT_CODE,
    )
  );
}

/** Returns whether an error is a stale session write-lock failure. */
export function isSessionWriteLockStaleError(err: unknown): boolean {
  return (
    err instanceof SessionWriteLockStaleError ||
    Boolean(
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === SESSION_WRITE_LOCK_STALE_CODE,
    )
  );
}

/** Returns whether an error is any session write-lock acquisition failure. */
export function isSessionWriteLockAcquireError(err: unknown): boolean {
  return isSessionWriteLockTimeoutError(err) || isSessionWriteLockStaleError(err);
}

/**
 * Returns whether a timeout error means a still-live run in THIS process holds
 * the session write lock (e.g. a prior turn mid tool-call). Such contention is
 * not a real failure — the holder is making legitimate progress and will
 * release — so callers can surface a "still working" notice instead of the raw
 * lock-timeout diagnostic. A dead/stale or different-process owner is excluded
 * so genuine lock failures still propagate.
 */
export function isSessionWriteLockBusyWithActiveRun(err: unknown): boolean {
  if (!isSessionWriteLockTimeoutError(err)) {
    return false;
  }
  const { ownerPid, ownerPidAlive } = err as {
    ownerPid?: unknown;
    ownerPidAlive?: unknown;
  };
  return typeof ownerPid === "number" && ownerPid === process.pid && ownerPidAlive === true;
}
