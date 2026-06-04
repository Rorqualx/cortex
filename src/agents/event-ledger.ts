/**
 * Unified Event Ledger for OpenClaw
 *
 * Provides event sourcing for critical operations with:
 * - Immutable append-only event storage
 * - Event ordering guarantees
 * - Replay capability
 * - Query by stream/type
 *
 * Event streams provide complete audit trails for debugging,
 * compliance, and analytics.
 */

/**
 * Event stream identifiers
 *
 * Each stream represents a category of related events:
 * - tool_calls: Tool invocations, results, errors
 * - policy_decisions: Allow/deny decisions with reasoning
 * - session_lifecycle: Session state transitions
 * - security_events: Security-relevant incidents
 * - agent_actions: Internal agent operations
 */
export type EventStream =
  | "tool_calls"
  | "policy_decisions"
  | "session_lifecycle"
  | "security_events"
  | "agent_actions";

/**
 * Base audit event structure
 *
 * All events share common metadata for correlation and querying.
 */
export type BaseAuditEvent = {
  /** Unique event identifier (UUID v4) */
  id: string;
  /** Event stream category */
  stream: EventStream;
  /** Event type within stream */
  type: string;
  /** Unix timestamp (milliseconds) */
  timestamp: number;
  /** Optional session correlation */
  sessionId?: string;
  /** Optional agent correlation */
  agentId?: string;
  /** Event-specific data */
  data: unknown;
};

/**
 * Tool call event
 *
 * Emitted for each tool invocation with policy decision,
 * parameters, result, and duration.
 */
export type ToolCallEvent = BaseAuditEvent & {
  stream: "tool_calls";
  type: "tool_invocation" | "tool_success" | "tool_error" | "tool_denied";
  data: {
    /** Tool name */
    toolName: string;
    /** Tool invocation parameters (if allowed) */
    parameters?: unknown;
    /** Tool result (on success) */
    result?: unknown;
    /** Error message (on failure) */
    error?: string;
    /** Execution duration in milliseconds */
    durationMs?: number;
    /** Policy decision */
    allowed: boolean;
    /** Deny reason (if denied) */
    denyReason?: string;
  };
};

/**
 * Policy decision event
 *
 * Emitted for each policy evaluation with decision,
 * reasoning, and context.
 */
export type PolicyDecisionEvent = BaseAuditEvent & {
  stream: "policy_decisions";
  type: "tool_policy_evaluated" | "file_access_check" | "permission_denied" | "permission_allowed";
  data: {
    /** Request type being evaluated */
    requestType: string;
    /** Final decision */
    decision: "allow" | "deny";
    /** Human-readable reason */
    reason?: string;
    /** Policy rule that triggered */
    policyRule?: string;
    /** Additional context */
    context?: Record<string, unknown>;
  };
};

/**
 * Session lifecycle event
 *
 * Emitted for session state transitions.
 */
export type SessionLifecycleEvent = BaseAuditEvent & {
  stream: "session_lifecycle";
  type: "created" | "started" | "stopped" | "compacted" | "archived" | "deleted";
  data: {
    /** Session key */
    sessionKey: string;
    /** Previous state (for transitions) */
    previousState?: string;
    /** New state (for transitions) */
    newState?: string;
    /** Reason for transition */
    reason?: string;
    /** Message count (for compaction) */
    messageCount?: number;
    /** Token count (for compaction) */
    tokenCount?: number;
  };
};

/**
 * Security event
 *
 * Emitted for security-relevant incidents.
 */
export type SecurityEvent = BaseAuditEvent & {
  stream: "security_events";
  type:
    | "permission_denied"
    | "config_mutation"
    | "file_access_violation"
    | "auth_event"
    | "suspicious_activity";
  data: {
    /** Severity level */
    severity: "info" | "warn" | "critical";
    /** Source of event */
    source: string;
    /** Event details */
    details: unknown;
  };
};

/**
 * Agent action event
 *
 * Emitted for internal agent operations.
 */
export type AgentActionEvent = BaseAuditEvent & {
  stream: "agent_actions";
  type: "consult_initiated" | "internal_tool" | "state_change" | "subagent_spawned";
  data: {
    /** Action description */
    action: string;
    /** Action target */
    target?: string;
    /** Action result */
    result?: unknown;
  };
};

/**
 * Union type of all audit events
 */
export type AuditEvent =
  | ToolCallEvent
  | PolicyDecisionEvent
  | SessionLifecycleEvent
  | SecurityEvent
  | AgentActionEvent;

/**
 * Event query parameters
 *
 * Used for filtering and retrieving events from the ledger.
 */
export type EventQuery = {
  /** Filter by stream */
  stream?: EventStream;
  /** Filter by event type */
  type?: string;
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by agent ID */
  agentId?: string;
  /** Start of time range (inclusive) */
  fromTime?: number;
  /** End of time range (inclusive) */
  toTime?: number;
  /** Maximum number of events to return */
  limit?: number;
};

/**
 * Event ledger interface
 *
 * Implementations provide storage and retrieval for event streams.
 *
 * The ledger provides:
 * - Atomic append operations
 * - Efficient time-based queries
 * - Session replay capability
 * - Event lookup by ID
 */
export interface EventLedger {
  /**
   * Append an event to the ledger
   *
   * Returns event ID for correlation. Operations must be atomic
   * to prevent event loss or corruption.
   */
  append(event: AuditEvent): Promise<string>;

  /**
   * Query events by criteria
   *
   * Returns matched events in chronological order (oldest first).
   * All filters are ANDed together.
   */
  query(params: EventQuery): Promise<AuditEvent[]>;

  /**
   * Replay all events for a session
   *
   * Returns all events for the given session in chronological order.
   * Useful for debugging and session reconstruction.
   */
  replay(sessionId: string): Promise<AuditEvent[]>;

  /**
   * Get event by ID
   *
   * Returns null if event not found.
   */
  get(id: string): Promise<AuditEvent | null>;

  /**
   * Close the ledger and release resources
   *
   * Called during shutdown to ensure all events are persisted.
   */
  close?(): Promise<void>;

  /**
   * Initialize the ledger
   *
   * Called during setup to prepare storage and indices.
   */
  initialize?(): Promise<void>;
}

/**
 * Event ledger configuration
 */
export type EventLedgerConfig = {
  /** Whether event ledger is enabled */
  enabled: boolean;
  /** Base path for event storage */
  storagePath: string;
  /** Number of days to retain events */
  retentionDays: number;
  /** Which streams to capture */
  streams: Partial<Record<EventStream, boolean>>;
};

/**
 * Default event ledger configuration
 */
export const DEFAULT_EVENT_LEDGER_CONFIG: EventLedgerConfig = {
  enabled: false,
  storagePath: "~/.openclaw/events",
  retentionDays: 90,
  streams: {
    tool_calls: true,
    policy_decisions: true,
    session_lifecycle: true,
    security_events: true,
    agent_actions: false,
  },
} as const;

/**
 * Check if a stream is enabled in config
 */
export function isStreamEnabled(config: EventLedgerConfig, stream: EventStream): boolean {
  return config.streams[stream] !== false;
}
