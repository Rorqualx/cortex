/**
 * QW-C (2026-08-30): steering-delta → skill-forge capture.
 *
 * When a visible turn preempts an in-flight heartbeat/background run
 * (`preemptAndDrainEmbeddedHeartbeatRun` → "drained"), the abandoned
 * trajectory contains the highest-signal training data the forge gets: what
 * the agent was doing versus what the user actually wanted. This module
 * guarantees that moment is queued into the forge capture pipeline (no
 * mid-run distillation — capture only) with flood protection: at most one
 * steering capture per session per hour, plus in-flight dedupe. Fire-and-
 * forget by design: capture failures must never block the reply path.
 */
import { captureSessionToForge } from "./capture.js";

/** Flood protection: minimum spacing between steering captures per session. */
export const STEERING_CAPTURE_MIN_INTERVAL_MS = 60 * 60 * 1000;

const lastQueuedAtBySession = new Map<string, number>();
const inFlightSessions = new Set<string>();

export type SteeringPreemptCaptureInput = {
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
  sessionKey?: string;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type QueueSteeringCaptureDeps = {
  /** Injectable capture for tests; defaults to the real pipeline. */
  capture?: typeof captureSessionToForge;
};

/**
 * Returns true when a steering capture is due for the session (outside the
 * throttle window and not already in flight). Pure aside from the injected
 * clock.
 */
export function steeringCaptureDue(sessionId: string, now: () => number = Date.now): boolean {
  if (inFlightSessions.has(sessionId)) {
    return false;
  }
  const lastQueuedAt = lastQueuedAtBySession.get(sessionId);
  if (lastQueuedAt !== undefined && now() - lastQueuedAt < STEERING_CAPTURE_MIN_INTERVAL_MS) {
    return false;
  }
  return true;
}

/**
 * Queue a forge capture tagged `steering-preempt` for the preempted run.
 * Returns false when throttled/deduped; true when queued. Never throws —
 * callers run this on the hot reply-admission path.
 */
export function queueSteeringPreemptCapture(
  input: SteeringPreemptCaptureInput,
  deps: QueueSteeringCaptureDeps = {},
): boolean {
  try {
    const now = input.now ?? Date.now;
    if (!steeringCaptureDue(input.sessionId, now)) {
      return false;
    }
    lastQueuedAtBySession.set(input.sessionId, now());
    inFlightSessions.add(input.sessionId);
    const capture = deps.capture ?? captureSessionToForge;
    void capture({
      sessionFile: input.sessionFile,
      sessionId: input.sessionId,
      ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      workspaceDir: input.workspaceDir,
      trigger: "steering-preempt",
    })
      .catch(() => undefined)
      .finally(() => {
        inFlightSessions.delete(input.sessionId);
      });
    return true;
  } catch {
    // Fire-and-forget guarantee: any unexpected failure here must not
    // propagate into the reply admission path.
    return false;
  }
}

/** Test hook: clears throttle/in-flight state. */
export function resetSteeringCaptureThrottleState(): void {
  lastQueuedAtBySession.clear();
  inFlightSessions.clear();
}
