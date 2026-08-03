/** Stable session ownership errors shared by runtime and public harness adapters. */
const TIMEOUT_CODE = "OPENCLAW_SESSION_WRITE_LOCK_TIMEOUT";
const STALE_CODE = "OPENCLAW_SESSION_WRITE_LOCK_STALE";

export class SessionWriteLockTimeoutError extends Error {
  readonly code = TIMEOUT_CODE;
  readonly timeoutMs: number;
  readonly owner: string;
  readonly lockPath: string;
  /** PID recorded in the contended lease, when the owner was identifiable. */
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

export class SessionWriteLockStaleError extends Error {
  readonly code = STALE_CODE;
  declare readonly owner: string;
  declare readonly lockPath: string;
  declare readonly staleReasons: string[];

  constructor(params: { owner: string; lockPath: string; staleReasons?: string[] }) {
    const staleReasons = params.staleReasons?.length ? params.staleReasons : ["unknown"];
    super(
      `session file lock stale (${staleReasons.join(", ")}): ${params.owner} ${params.lockPath}`,
    );
    this.name = "SessionWriteLockStaleError";
    Object.assign(this, params, { staleReasons });
  }
}

export function isSessionWriteLockAcquireError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    error instanceof SessionWriteLockTimeoutError ||
    error instanceof SessionWriteLockStaleError ||
    code === TIMEOUT_CODE ||
    code === STALE_CODE
  );
}

/**
 * Returns whether a timeout error means a still-live run in THIS process holds
 * the session write lease (e.g. a prior turn mid tool-call). Such contention is
 * not a real failure — the holder is making legitimate progress and will
 * release — so callers can surface a "still working" notice instead of the raw
 * lock-timeout diagnostic. A dead/stale or different-process owner is excluded
 * so genuine lock failures still propagate.
 */
export function isSessionWriteLockBusyWithActiveRun(err: unknown): boolean {
  const { code, ownerPid, ownerPidAlive } = (err ?? {}) as {
    code?: unknown;
    ownerPid?: unknown;
    ownerPidAlive?: unknown;
  };
  if (!(err instanceof SessionWriteLockTimeoutError) && code !== TIMEOUT_CODE) {
    return false;
  }
  return typeof ownerPid === "number" && ownerPid === process.pid && ownerPidAlive === true;
}
