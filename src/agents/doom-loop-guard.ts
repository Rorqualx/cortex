/**
 * Doom Loop Guard
 *
 * Detects consecutive failures (LLM errors, tool errors, network issues)
 * to prevent runaway retry loops. Complements existing tool loop detection.
 *
 * A "doom loop" occurs when an agent fails repeatedly without making progress,
 * wasting API credits and providing poor UX. This guard tracks consecutive
 * failures within a time window and aborts when the threshold is reached.
 *
 * Unlike post-compaction loop guard which detects identical tool calls,
 * this guard detects ANY consecutive failure pattern regardless of the
 * specific tool or error type.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("agents/doom-loop-guard");

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_FAILURE_WINDOW_MS = 300_000; // 5 minutes

/**
 * Doom loop guard configuration
 */
export type DoomLoopGuardConfig = {
  /** Maximum consecutive failures before aborting (default: 5) */
  maxConsecutiveFailures?: number;
  /** Time window for failure counting in milliseconds (default: 300000 / 5 minutes) */
  failureWindowMs?: number;
  /** Failure types to count toward doom loop (default: all types) */
  countableFailures?: Array<"llm_error" | "tool_error" | "network_error" | "timeout">;
};

/**
 * Doom loop guard snapshot for diagnostics
 */
export type DoomLoopGuardSnapshot = {
  consecutiveFailures: number;
  lastFailureAt?: number;
  lastFailureType?: string;
  isArmed: boolean;
  /** Timestamp of the last successful turn (last `reset()`). Used for Revise boundary. */
  lastSuccessAt?: number;
};

/**
 * Doom loop guard verdict
 */
export type DoomLoopVerdict =
  | { shouldAbort: false; consecutiveFailures: number }
  | {
      shouldAbort: true;
      consecutiveFailures: number;
      reason: string;
      detector: "doom_loop";
    };

/**
 * Internal guard state
 */
type GuardState = {
  enabled: boolean;
  maxConsecutiveFailures: number;
  failureWindowMs: number;
  countableFailures: Set<string>;
  consecutiveFailures: number;
  lastFailureAt?: number;
  lastFailureType?: string;
  isArmed: boolean;
  lastSuccessAt?: number;
};

/**
 * Doom loop guard interface
 */
export type DoomLoopGuard = {
  /** Activate monitoring after successful turns */
  arm: () => void;
  /** Record a failure and check if doom loop threshold reached */
  recordFailure: (errorType: string, timestamp: number) => DoomLoopVerdict;
  /** Reset counter on successful turn */
  reset: () => void;
  /** Current state for diagnostics */
  snapshot: () => DoomLoopGuardSnapshot;
  /**
   * Returns the timestamp of the last successful checkpoint (the last time
   * `reset()` was called), or undefined if no success has been recorded.
   * Used by the agent runner to implement a "Revise" operation: restore
   * context to the pre-failure boundary and inject a strategy-switch prompt.
   */
  getFailureBoundary: () => number | undefined;
  /**
   * Generate a Revise steering prompt for injection into the agent turn
   * when doom-loop recovery is triggered. The prompt advises the agent to
   * try a different strategy rather than repeating the failed approach.
   */
  createRevisePrompt: () => string;
  /**
   * Record a grounding confidence signal. If confidence is below threshold,
   * it is treated as a countable failure that accelerates doom-loop detection.
   * Default threshold is 0.5.
   */
  recordConfidenceSignal: (confidence: number, threshold?: number) => DoomLoopVerdict;
};

function asPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/**
 * Create a doom loop guard instance
 *
 * The guard starts unarmed and must be explicitly armed after successful
 * agent turns. This prevents false positives during startup or transient
 * failures.
 */
export function createDoomLoopGuard(
  config?: DoomLoopGuardConfig,
  options?: { enabled?: boolean },
): DoomLoopGuard {
  const state: GuardState = {
    enabled: options?.enabled ?? true,
    maxConsecutiveFailures: asPositiveInt(
      config?.maxConsecutiveFailures,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
    ),
    failureWindowMs: asPositiveInt(config?.failureWindowMs, DEFAULT_FAILURE_WINDOW_MS),
    countableFailures: new Set(
      config?.countableFailures ?? [
        "llm_error",
        "tool_error",
        "network_error",
        "timeout",
        "grounding_low_confidence",
      ],
    ),
    consecutiveFailures: 0,
    isArmed: false,
    lastSuccessAt: undefined,
  };

  const arm = (): void => {
    state.isArmed = true;
    if (state.enabled) {
      log.info("doom loop guard armed");
    }
  };

  const reset = (): void => {
    state.consecutiveFailures = 0;
    state.lastFailureAt = undefined;
    state.lastFailureType = undefined;
    state.lastSuccessAt = Date.now();
  };

  const recordFailure = (errorType: string, timestamp: number): DoomLoopVerdict => {
    if (!state.enabled) {
      return { shouldAbort: false, consecutiveFailures: 0 };
    }

    if (!state.isArmed) {
      return { shouldAbort: false, consecutiveFailures: 0 };
    }

    // Check if this error type is countable
    if (!state.countableFailures.has(errorType)) {
      return { shouldAbort: false, consecutiveFailures: state.consecutiveFailures };
    }

    // Check if within failure window - reset if window expired
    if (state.lastFailureAt) {
      const timeSinceLastFailure = timestamp - state.lastFailureAt;
      if (timeSinceLastFailure > state.failureWindowMs) {
        log.debug(
          `failure window expired (${timeSinceLastFailure}ms > ${state.failureWindowMs}ms), resetting counter`,
        );
        state.consecutiveFailures = 0;
      }
    }

    // Increment failure counter
    state.consecutiveFailures++;
    state.lastFailureAt = timestamp;
    state.lastFailureType = errorType;

    log.warn(
      `recorded failure: ${errorType} (${state.consecutiveFailures}/${state.maxConsecutiveFailures} consecutive)`,
    );

    // Check threshold
    if (state.consecutiveFailures >= state.maxConsecutiveFailures) {
      const reason = `Doom loop detected: ${state.consecutiveFailures} consecutive failures of type '${errorType}'`;
      log.error(reason);
      return {
        shouldAbort: true,
        consecutiveFailures: state.consecutiveFailures,
        reason,
        detector: "doom_loop",
      };
    }

    return { shouldAbort: false, consecutiveFailures: state.consecutiveFailures };
  };

  const snapshot = (): DoomLoopGuardSnapshot => ({
    consecutiveFailures: state.consecutiveFailures,
    lastFailureAt: state.lastFailureAt,
    lastFailureType: state.lastFailureType,
    isArmed: state.isArmed,
    lastSuccessAt: state.lastSuccessAt,
  });

  const getFailureBoundary = (): number | undefined => state.lastSuccessAt;

  const createRevisePrompt = (): string => {
    const boundary = state.lastSuccessAt;
    const boundaryText = boundary
      ? ` (last successful checkpoint: ${new Date(boundary).toISOString()})`
      : "";
    return [
      `[OpenClaw runtime] Doom-loop recovery triggered.${boundaryText}`,
      "The previous approach failed repeatedly. Do NOT retry the same strategy.",
      "Instead: try a different strategy, use a different tool, or ask the user for clarification.",
      "If you were using a particular method (e.g., a specific script, API call, or reasoning path), switch to an alternative.",
    ].join("\n");
  };

  const recordConfidenceSignal = (confidence: number, threshold?: number): DoomLoopVerdict => {
    const effectiveThreshold = threshold ?? 0.5;
    if (confidence < effectiveThreshold) {
      return recordFailure("grounding_low_confidence", Date.now());
    }
    return { shouldAbort: false, consecutiveFailures: state.consecutiveFailures };
  };

  return {
    arm,
    recordFailure,
    reset,
    snapshot,
    getFailureBoundary,
    createRevisePrompt,
    recordConfidenceSignal,
  };
}

/**
 * Error thrown when doom loop is detected
 */
export class DoomLoopDetectedError extends Error {
  readonly detector = "doom_loop" as const;
  readonly consecutiveFailures: number;
  readonly lastFailureType?: string;

  constructor(
    message: string,
    details: {
      consecutiveFailures: number;
      lastFailureType?: string;
    },
  ) {
    super(message);
    this.name = "DoomLoopDetectedError";
    this.consecutiveFailures = details.consecutiveFailures;
    this.lastFailureType = details.lastFailureType;
  }

  /**
   * Create error from a doom loop verdict
   */
  static fromVerdict(
    verdict: Extract<DoomLoopVerdict, { shouldAbort: true }>,
  ): DoomLoopDetectedError {
    return new DoomLoopDetectedError(verdict.reason, {
      consecutiveFailures: verdict.consecutiveFailures,
    });
  }
}
