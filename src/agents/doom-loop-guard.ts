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

/** Default buffer size for semantic convergence detection. */
const DEFAULT_CONVERGENCE_BUFFER_SIZE = 5;
/** Default cosine similarity threshold above which responses are considered "same". */
const DEFAULT_CONVERGENCE_SIMILARITY_THRESHOLD = 0.92;
/** Default number of consecutive rounds above threshold before convergence fires. */
const DEFAULT_CONVERGENCE_CONSECUTIVE_ROUNDS = 3;

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
  /**
   * Semantic convergence detection config. When enabled, the guard tracks
   * assistant response embeddings and fires recovery when outputs become
   * nearly identical across consecutive turns (semantic stuck loop).
   */
  semanticConvergence?: {
    /** Number of response embeddings to keep in the rolling buffer (default: 5). */
    bufferSize?: number;
    /** Cosine similarity threshold above which responses are considered convergent (default: 0.92). */
    similarityThreshold?: number;
    /** Number of consecutive turns above threshold before recovery fires (default: 3). */
    consecutiveRounds?: number;
  };
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
      detector: "doom_loop" | "semantic_convergence";
    };

/**
 * Cosine similarity between two equal-length embedding vectors.
 * Returns 0 if either vector is empty or lengths mismatch.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Compute mean pairwise cosine similarity of an embedding buffer.
 * For N embeddings, computes all N*(N-1)/2 pairs and returns the mean.
 */
export function meanPairwiseCosineSimilarity(buffer: number[][]): number {
  if (buffer.length < 2) return 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < buffer.length; i++) {
    for (let j = i + 1; j < buffer.length; j++) {
      sum += cosineSimilarity(buffer[i], buffer[j]);
      count++;
    }
  }
  return count === 0 ? 0 : sum / count;
}

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
  // Semantic convergence detection state
  embeddingBuffer: number[][];
  convergenceBufferSize: number;
  convergenceSimilarityThreshold: number;
  convergenceConsecutiveRounds: number;
  convergenceConsecutiveCount: number;
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
  /**
   * Record an assistant response embedding for semantic convergence detection.
   * The guard maintains a rolling buffer and fires when mean pairwise cosine
   * similarity exceeds the threshold for enough consecutive turns — detecting
   * "semantic stuck" loops that produce no counted failures.
   * Returns undefined when convergence detection is not configured.
   */
  recordResponseEmbedding: (embedding: number[]) => DoomLoopVerdict | undefined;
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
  const sc = config?.semanticConvergence;
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
    embeddingBuffer: [],
    convergenceBufferSize: sc?.bufferSize ?? DEFAULT_CONVERGENCE_BUFFER_SIZE,
    convergenceSimilarityThreshold:
      sc?.similarityThreshold ?? DEFAULT_CONVERGENCE_SIMILARITY_THRESHOLD,
    convergenceConsecutiveRounds: sc?.consecutiveRounds ?? DEFAULT_CONVERGENCE_CONSECUTIVE_ROUNDS,
    convergenceConsecutiveCount: 0,
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
    state.embeddingBuffer = [];
    state.convergenceConsecutiveCount = 0;
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

  const recordResponseEmbedding = (embedding: number[]): DoomLoopVerdict | undefined => {
    // No-op when convergence detection is not configured (bufferSize 0 or no config)
    if (!config?.semanticConvergence || state.convergenceBufferSize <= 0) {
      return undefined;
    }

    if (!state.enabled || !state.isArmed) {
      return undefined;
    }

    // Append to rolling buffer
    state.embeddingBuffer.push(embedding);

    // Trim to buffer size
    while (state.embeddingBuffer.length > state.convergenceBufferSize) {
      state.embeddingBuffer.shift();
    }

    // Need at least 2 embeddings to compute similarity
    if (state.embeddingBuffer.length < 2) {
      return undefined;
    }

    // Compute mean pairwise cosine similarity
    const sim = meanPairwiseCosineSimilarity(state.embeddingBuffer);

    if (sim >= state.convergenceSimilarityThreshold) {
      state.convergenceConsecutiveCount++;
    } else {
      state.convergenceConsecutiveCount = 0;
    }

    if (state.convergenceConsecutiveCount >= state.convergenceConsecutiveRounds) {
      const reason = `Semantic convergence detected: mean pairwise cosine similarity ${sim.toFixed(4)} >= ${state.convergenceSimilarityThreshold} for ${state.convergenceConsecutiveCount} consecutive rounds`;
      log.error(reason);
      return {
        shouldAbort: true,
        consecutiveFailures: state.consecutiveFailures,
        reason,
        detector: "semantic_convergence",
      };
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
    recordResponseEmbedding,
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
