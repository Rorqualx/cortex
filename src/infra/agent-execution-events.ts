/**
 * Graph-based execution visualization layer for agent debugging.
 *
 * Provides structured trace events at phase boundaries for DAG-based
 * debugging and time-trail capability. Supports W3C trace context for
 * distributed tracing correlation.
 *
 * @module infra/agent-execution-events
 */

import { emitAgentEvent, type AgentEventPayload } from "./agent-events.js";

/**
 * Execution phase streams for visualization and debugging.
 *
 * - `attempt`: Attempt lifecycle (start, planning_complete, compaction_start, complete)
 * - `compaction_detailed`: Fine-grained compaction phases (chunking, summarization, hooks)
 * - `policy_check`: Tool policy validation phases (deny-list, allow-list, capability, etc.)
 * - `spawn`: Subagent spawn phases (fast_spawn, full_spawn)
 * - `lifecycle_extended`: Extended lifecycle with phase boundaries
 */
export type ExecutionPhaseStream =
  | "attempt"
  | "compaction_detailed"
  | "policy_check"
  | "spawn"
  | "lifecycle_extended";

/**
 * Attempt phase names for execution visualization.
 */
export type AttemptPhase =
  | "attempt_start"
  | "planning_complete"
  | "compaction_start"
  | "compaction_complete"
  | "attempt_complete"
  | "attempt_failed";

/**
 * Compaction detailed phase names.
 */
export type CompactionDetailedPhase =
  | "start"
  | "preparation_start"
  | "preparation_complete"
  | "before_hooks_start"
  | "before_hooks_complete"
  | "chunking_start"
  | "summarization_start"
  | "summarization_complete"
  | "after_hooks_start"
  | "after_hooks_complete"
  | "side_effects_start"
  | "side_effects_complete"
  | "complete";

/**
 * Policy check phase names for each policy layer.
 */
export type PolicyCheckPhase =
  | "deny_list_start"
  | "deny_list_complete"
  | "allow_list_start"
  | "allow_list_complete"
  | "capability_start"
  | "capability_complete"
  | "permission_start"
  | "permission_complete"
  | "prompt_aware_start"
  | "prompt_aware_complete"
  | "deny_first_start"
  | "deny_first_complete"
  | "sandbox_start"
  | "sandbox_complete"
  | "rate_limit_start"
  | "rate_limit_complete";

/**
 * Spawn phase names.
 */
export type SpawnPhase =
  | "fast_spawn_start"
  | "fast_spawn_complete"
  | "full_spawn_start"
  | "full_spawn_complete"
  | "env_resolution_start"
  | "env_resolution_complete"
  | "pre_fly_checks_start"
  | "pre_fly_checks_complete"
  | "registry_validation_start"
  | "registry_validation_complete"
  | "runtime_plugins_start"
  | "runtime_plugins_complete"
  | "thread_binding_start"
  | "thread_binding_complete"
  | "gateway_spawn_start"
  | "gateway_spawn_complete"
  | "post_spawn_sync_start"
  | "post_spawn_sync_complete";

/**
 * Extended lifecycle phase names.
 */
export type LifecycleExtendedPhase =
  | "context_load_start"
  | "context_load_complete"
  | "runtime_init_start"
  | "runtime_init_complete"
  | "delivery_start"
  | "delivery_complete";

/**
 * Union of all phase types per stream.
 */
export type ExecutionPhaseByStream = {
  attempt: AttemptPhase;
  compaction_detailed: CompactionDetailedPhase;
  policy_check: PolicyCheckPhase;
  spawn: SpawnPhase;
  lifecycle_extended: LifecycleExtendedPhase;
};

/**
 * W3C Trace Context for distributed tracing correlation.
 *
 * Follows W3C Trace Context specification:
 * - traceId: Unique identifier for the entire trace
 * - spanId: Unique identifier for this span
 * - parentSpanId: Identifier for the parent span
 */
export type W3CTraceContext = {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
};

/**
 * Execution phase event payload for visualization and debugging.
 */
export type ExecutionPhaseEvent<TStream extends ExecutionPhaseStream = ExecutionPhaseStream> = {
  /**
   * The execution phase stream this event belongs to.
   */
  stream: TStream;

  /**
   * The specific phase within the stream.
   */
  phase: ExecutionPhaseByStream[TStream];

  /**
   * When this phase started (epoch ms). Set on phase start events.
   */
  startedAt?: number;

  /**
   * When this phase ended (epoch ms). Set on phase complete/failed events.
   */
  endedAt?: number;

  /**
   * Calculated duration in milliseconds. Set on phase complete/failed events.
   */
  durationMs?: number;

  /**
   * Additional phase-specific metadata.
   */
  metadata?: Record<string, unknown>;

  /**
   * W3C trace context for distributed tracing correlation.
   */
  traceContext?: W3CTraceContext;

  /**
   * Human-readable status for the phase.
   */
  status?: "started" | "running" | "completed" | "failed";
};

/**
 * Parameters for emitting an execution phase event.
 */
export type EmitExecutionPhaseEventParams<
  TStream extends ExecutionPhaseStream = ExecutionPhaseStream,
> = {
  /**
   * The run ID this event belongs to.
   */
  runId: string;

  /**
   * The execution phase stream.
   */
  stream: TStream;

  /**
   * The specific phase within the stream.
   */
  phase: ExecutionPhaseByStream[TStream];

  /**
   * Session key for the run.
   */
  sessionKey?: string;

  /**
   * Session ID (for lifecycle events).
   */
  sessionId?: string;

  /**
   * Agent ID.
   */
  agentId?: string;

  /**
   * When this phase started (epoch ms).
   */
  startedAt?: number;

  /**
   * When this phase ended (epoch ms).
   */
  endedAt?: number;

  /**
   * Additional phase-specific metadata.
   */
  metadata?: Record<string, unknown>;

  /**
   * W3C trace context for distributed tracing.
   */
  traceContext?: W3CTraceContext;

  /**
   * Human-readable status.
   */
  status?: "started" | "running" | "completed" | "failed";
};

/**
 * Generate a random span ID for W3C trace context.
 *
 * Uses cryptographically random bytes to ensure uniqueness.
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a random trace ID for W3C trace context.
 *
 * Uses cryptographically random bytes to ensure uniqueness.
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a child trace context from a parent context.
 *
 * The child inherits the parent's traceId and gets a new spanId.
 */
export function createChildTraceContext(parent?: W3CTraceContext): W3CTraceContext {
  const traceId = parent?.traceId ?? generateTraceId();
  const spanId = generateSpanId();
  return {
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
  };
}

/**
 * Calculate duration from start and end timestamps.
 */
export function calculateDuration(startedAt?: number, endedAt?: number): number | undefined {
  if (startedAt !== undefined && endedAt !== undefined) {
    return endedAt - startedAt;
  }
  return undefined;
}

/**
 * Derive status from phase name.
 *
 * Phases ending with "_start" → "started"
 * Phases ending with "_complete" → "completed"
 * Phases ending with "_failed" → "failed"
 */
export function deriveStatusFromPhase(
  phase: string,
): "started" | "completed" | "failed" | undefined {
  if (phase.endsWith("_start")) {
    return "started";
  }
  if (phase.endsWith("_complete")) {
    return "completed";
  }
  if (phase.endsWith("_failed")) {
    return "failed";
  }
  return undefined;
}

/**
 * Emit an execution phase event for visualization and debugging.
 *
 * This helper wraps `emitAgentEvent` with execution phase specific fields.
 * Events are emitted on the stream matching the execution phase stream name.
 *
 * @example
 * ```ts
 * // Emit attempt start event
 * emitAgentExecutionEvent({
 *   runId: "abc123",
 *   stream: "attempt",
 *   phase: "attempt_start",
 *   sessionKey: "session-key",
 *   traceContext: { traceId: "parent-trace", spanId: "parent-span" },
 * });
 * ```
 */
export function emitAgentExecutionEvent<TStream extends ExecutionPhaseStream>(
  params: EmitExecutionPhaseEventParams<TStream>,
): void {
  const {
    runId,
    stream,
    phase,
    sessionKey,
    sessionId,
    agentId,
    startedAt,
    endedAt,
    metadata,
    traceContext,
    status,
  } = params;

  // Derive status from phase if not explicitly provided
  const derivedStatus = status ?? deriveStatusFromPhase(phase);

  // Calculate duration if both timestamps provided
  const durationMs = calculateDuration(startedAt, endedAt);

  // Build event payload
  const executionEvent: ExecutionPhaseEvent<TStream> = {
    stream,
    phase,
    startedAt,
    endedAt,
    durationMs,
    metadata,
    traceContext,
    status: derivedStatus,
  };

  // Emit as agent event
  const eventPayload: Omit<AgentEventPayload, "seq" | "ts"> = {
    runId,
    stream,
    data: executionEvent as unknown as Record<string, unknown>,
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(agentId ? { agentId } : {}),
  };

  emitAgentEvent(eventPayload);
}

/**
 * Phase tracker for measuring execution time.
 *
 * Tracks start timestamps and emits complete/failed events with calculated durations.
 */
export class PhaseTracker<TStream extends ExecutionPhaseStream = ExecutionPhaseStream> {
  private startTimes: Map<ExecutionPhaseByStream[TStream], number> = new Map();

  constructor(
    private readonly params: Pick<
      EmitExecutionPhaseEventParams<TStream>,
      "runId" | "stream" | "sessionKey" | "sessionId" | "agentId" | "traceContext"
    >,
  ) {}

  /**
   * Mark the start of a phase.
   */
  start(phase: ExecutionPhaseByStream[TStream]): void {
    const startedAt = Date.now();
    this.startTimes.set(phase, startedAt);

    emitAgentExecutionEvent({
      ...this.params,
      phase,
      startedAt,
    });
  }

  /**
   * Mark the completion of a phase.
   */
  complete(phase: ExecutionPhaseByStream[TStream], metadata?: Record<string, unknown>): void {
    const startedAt = this.startTimes.get(phase);
    const endedAt = Date.now();

    emitAgentExecutionEvent({
      ...this.params,
      phase,
      startedAt,
      endedAt,
      metadata,
      status: "completed",
    });

    this.startTimes.delete(phase);
  }

  /**
   * Mark the failure of a phase.
   */
  failed(phase: ExecutionPhaseByStream[TStream], metadata?: Record<string, unknown>): void {
    const startedAt = this.startTimes.get(phase);
    const endedAt = Date.now();

    emitAgentExecutionEvent({
      ...this.params,
      phase,
      startedAt,
      endedAt,
      metadata,
      status: "failed",
    });

    this.startTimes.delete(phase);
  }

  /**
   * Get the current start time for a phase (if started).
   */
  getStartTime(phase: ExecutionPhaseByStream[TStream]): number | undefined {
    return this.startTimes.get(phase);
  }

  /**
   * Clear all tracked phases (useful for cleanup).
   */
  clear(): void {
    this.startTimes.clear();
  }
}

/**
 * Create a new phase tracker for a run.
 */
export function createPhaseTracker<TStream extends ExecutionPhaseStream = ExecutionPhaseStream>(
  params: Pick<
    EmitExecutionPhaseEventParams<TStream>,
    "runId" | "stream" | "sessionKey" | "sessionId" | "agentId" | "traceContext"
  >,
): PhaseTracker<TStream> {
  return new PhaseTracker(params);
}
