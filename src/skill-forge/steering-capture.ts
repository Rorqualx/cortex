import { captureSessionToForge } from "./capture.js";

/**
 * Steering-delta capture (daily-research 2026-08-30 QW-C).
 *
 * When a visible turn preempts an in-flight embedded heartbeat run, the
 * intended-vs-actual trajectory divergence is one of the highest-signal
 * moments for skill distillation: the model was doing X, the human wanted Y.
 * This module guarantees those moments reach the skill-forge capture pipeline
 * without running any distillation mid-flight — just a fire-and-forget
 * `captureSessionToForge` tagged `steering-preempt`.
 *
 * Flood guard: at most one queued capture per session per hour. Preemption
 * storms (noisy channels, retry loops) would otherwise flood the capture dir
 * with near-identical bundles.
 */

export type SteeringPreemptCaptureParams = {
  /** The embedded run's session id (the run that was preempted). */
  sessionId: string;
  /** Session store file for the preempted run, when known. */
  sessionFile?: string;
  sessionKey?: string;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Optional debug sink — capture is best-effort and must never throw. */
  debug?: (message: string) => void;
};

/** One capture per session per hour. */
export const STEERING_CAPTURE_THROTTLE_MS = 60 * 60 * 1000;

/** Bound the throttle map so long-lived gateways don't accumulate sessions. */
const THROTTLE_MAP_MAX_ENTRIES = 512;

const lastQueuedAtBySessionId = new Map<string, number>();

/** Test hook: clear throttle state between tests. */
export function resetSteeringCaptureThrottleForTests(): void {
  lastQueuedAtBySessionId.clear();
}

function pruneThrottleMap(now: number): void {
  if (lastQueuedAtBySessionId.size < THROTTLE_MAP_MAX_ENTRIES) {
    return;
  }
  for (const [sessionId, at] of lastQueuedAtBySessionId) {
    if (now - at >= STEERING_CAPTURE_THROTTLE_MS) {
      lastQueuedAtBySessionId.delete(sessionId);
    }
  }
  // Still at capacity (all recent): drop the oldest entry.
  while (lastQueuedAtBySessionId.size >= THROTTLE_MAP_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, at] of lastQueuedAtBySessionId) {
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = sessionId;
      }
    }
    if (oldestKey === undefined) {
      break;
    }
    lastQueuedAtBySessionId.delete(oldestKey);
  }
}

/**
 * Queue a best-effort forge capture of a preempted heartbeat run.
 * Returns true when a capture was queued, false when throttled (or when
 * no session file is known, in which case capture would only skip).
 * Never throws; never blocks the caller — the capture runs detached.
 */
export function queueSteeringPreemptCapture(params: SteeringPreemptCaptureParams): boolean {
  try {
    if (!params.sessionFile) {
      // Without a session file the bundle export has no transcript source
      // and would skip; don't burn the throttle window on a guaranteed skip.
      params.debug?.(`steering-capture: no sessionFile for ${params.sessionId}, skipping`);
      return false;
    }
    const now = params.now?.() ?? Date.now();
    const last = lastQueuedAtBySessionId.get(params.sessionId);
    if (last !== undefined && now - last < STEERING_CAPTURE_THROTTLE_MS) {
      return false;
    }
    pruneThrottleMap(now);
    lastQueuedAtBySessionId.set(params.sessionId, now);
    void captureSessionToForge({
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      trigger: "steering-preempt",
      env: params.env,
      now: params.now ? new Date(params.now()) : undefined,
    }).then(
      (result) => {
        if (result.status === "skipped") {
          params.debug?.(
            `steering-capture: skipped sessionId=${params.sessionId} reason=${result.reason}`,
          );
        }
      },
      (error) => {
        params.debug?.(
          `steering-capture: failed sessionId=${params.sessionId} err=${String(error)}`,
        );
      },
    );
    return true;
  } catch (error) {
    params.debug?.(`steering-capture: error sessionId=${params.sessionId} err=${String(error)}`);
    return false;
  }
}
