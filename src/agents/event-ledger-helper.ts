/**
 * Event Ledger Helper
 *
 * Provides convenient functions for emitting events to the audit ledger.
 * Handles disabled ledgers gracefully and provides type-safe event builders.
 */

import type {
  AuditEvent,
  EventLedger,
  ToolCallEvent,
  PolicyDecisionEvent,
  SessionLifecycleEvent,
  SecurityEvent,
  AgentActionEvent,
  EventQuery,
} from "./event-ledger.js";
import type { EventLedgerConfig } from "./event-ledger.js";
import { isStreamEnabled } from "./event-ledger.js";

/**
 * Event ledger singleton (initialized on first use)
 */
let ledgerInstance: EventLedger | null = null;
let ledgerConfig: EventLedgerConfig | null = null;

/**
 * Initialize the event ledger with configuration
 *
 * Call this during agent startup to set up the ledger.
 * Safe to call multiple times (will reinitialize if config changes).
 */
export async function initializeEventLedger(config: EventLedgerConfig): Promise<void> {
  if (!config.enabled) {
    ledgerInstance = null;
    ledgerConfig = config;
    return;
  }

  const { createFileEventLedger } = await import("./event-ledger.file.js");
  ledgerInstance = createFileEventLedger(config);
  ledgerConfig = config;
  await ledgerInstance.initialize?.();
}

/**
 * Get the current event ledger instance
 *
 * Returns null if ledger is not initialized or disabled.
 */
export function getEventLedger(): EventLedger | null {
  return ledgerInstance;
}

/**
 * Check if a stream is enabled
 */
export function isEventStreamEnabled(stream: AuditEvent["stream"]): boolean {
  if (!ledgerConfig || !ledgerConfig.enabled) {
    return false;
  }
  return isStreamEnabled(ledgerConfig, stream);
}

/**
 * Append an event to the ledger
 *
 * Safe no-op if ledger is disabled or stream not enabled.
 * Returns event ID for correlation, or null if not appended.
 */
export async function appendEvent(event: AuditEvent): Promise<string | null> {
  if (!ledgerInstance || !isEventStreamEnabled(event.stream)) {
    return null;
  }

  try {
    return await ledgerInstance.append(event);
  } catch (error) {
    // Log but don't throw - audit failures shouldn't break agent runtime
    console.error(`[event-ledger] Failed to append event: ${error}`);
    return null;
  }
}

/**
 * Query events from the ledger
 */
export async function queryEvents(params: EventQuery): Promise<AuditEvent[]> {
  if (!ledgerInstance) {
    return [];
  }

  try {
    return await ledgerInstance.query(params);
  } catch (error) {
    console.error(`[event-ledger] Failed to query events: ${error}`);
    return [];
  }
}

/**
 * Replay all events for a session
 */
export async function replaySessionEvents(sessionId: string): Promise<AuditEvent[]> {
  if (!ledgerInstance) {
    return [];
  }

  try {
    return await ledgerInstance.replay(sessionId);
  } catch (error) {
    console.error(`[event-ledger] Failed to replay session: ${error}`);
    return [];
  }
}

/**
 * Close the event ledger
 *
 * Call during shutdown to ensure all events are persisted.
 */
export async function closeEventLedger(): Promise<void> {
  if (ledgerInstance) {
    try {
      await ledgerInstance.close?.();
    } catch (error) {
      console.error(`[event-ledger] Failed to close ledger: ${error}`);
    }
    ledgerInstance = null;
  }
}

/**
 * Build a tool call event
 */
export function buildToolCallEvent(params: {
  type: "tool_invocation" | "tool_success" | "tool_error" | "tool_denied";
  toolName: string;
  timestamp?: number;
  sessionId?: string;
  agentId?: string;
  parameters?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  allowed: boolean;
  denyReason?: string;
}): ToolCallEvent {
  const { randomUUID } = require("node:crypto");
  return {
    id: randomUUID(),
    stream: "tool_calls",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionId,
    agentId: params.agentId,
    data: {
      toolName: params.toolName,
      parameters: params.parameters,
      result: params.result,
      error: params.error,
      durationMs: params.durationMs,
      allowed: params.allowed,
      denyReason: params.denyReason,
    },
  };
}

/**
 * Build a tool call event (async version for ESM compatibility)
 */
export async function buildToolCallEventAsync(params: {
  type: "tool_invocation" | "tool_success" | "tool_error" | "tool_denied";
  toolName: string;
  timestamp?: number;
  sessionId?: string;
  agentId?: string;
  parameters?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  allowed: boolean;
  denyReason?: string;
}): Promise<ToolCallEvent> {
  const { randomUUID } = await import("node:crypto");
  return {
    id: randomUUID(),
    stream: "tool_calls",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionId,
    agentId: params.agentId,
    data: {
      toolName: params.toolName,
      parameters: params.parameters,
      result: params.result,
      error: params.error,
      durationMs: params.durationMs,
      allowed: params.allowed,
      denyReason: params.denyReason,
    },
  };
}

/**
 * Build a policy decision event
 */
export function buildPolicyDecisionEvent(params: {
  type: "tool_policy_evaluated" | "file_access_check" | "permission_denied" | "permission_allowed";
  requestType: string;
  decision: "allow" | "deny";
  timestamp?: number;
  sessionId?: string;
  agentId?: string;
  reason?: string;
  policyRule?: string;
  context?: Record<string, unknown>;
}): PolicyDecisionEvent {
  const { randomUUID } = require("node:crypto");
  return {
    id: randomUUID(),
    stream: "policy_decisions",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionId,
    agentId: params.agentId,
    data: {
      requestType: params.requestType,
      decision: params.decision,
      reason: params.reason,
      policyRule: params.policyRule,
      context: params.context,
    },
  };
}

/**
 * Build a policy decision event (async version)
 */
export async function buildPolicyDecisionEventAsync(params: {
  type: "tool_policy_evaluated" | "file_access_check" | "permission_denied" | "permission_allowed";
  requestType: string;
  decision: "allow" | "deny";
  timestamp?: number;
  sessionId?: string;
  agentId?: string;
  reason?: string;
  policyRule?: string;
  context?: Record<string, unknown>;
}): Promise<PolicyDecisionEvent> {
  const { randomUUID } = await import("node:crypto");
  return {
    id: randomUUID(),
    stream: "policy_decisions",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionId,
    agentId: params.agentId,
    data: {
      requestType: params.requestType,
      decision: params.decision,
      reason: params.reason,
      policyRule: params.policyRule,
      context: params.context,
    },
  };
}

/**
 * Build a session lifecycle event
 */
export function buildSessionLifecycleEvent(params: {
  type: "created" | "started" | "stopped" | "compacted" | "archived" | "deleted";
  sessionKey: string;
  timestamp?: number;
  agentId?: string;
  previousState?: string;
  newState?: string;
  reason?: string;
  messageCount?: number;
  tokenCount?: number;
}): SessionLifecycleEvent {
  const { randomUUID } = require("node:crypto");
  return {
    id: randomUUID(),
    stream: "session_lifecycle",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionKey,
    agentId: params.agentId,
    data: {
      sessionKey: params.sessionKey,
      previousState: params.previousState,
      newState: params.newState,
      reason: params.reason,
      messageCount: params.messageCount,
      tokenCount: params.tokenCount,
    },
  };
}

/**
 * Build a session lifecycle event (async version)
 */
export async function buildSessionLifecycleEventAsync(params: {
  type: "created" | "started" | "stopped" | "compacted" | "archived" | "deleted";
  sessionKey: string;
  timestamp?: number;
  agentId?: string;
  previousState?: string;
  newState?: string;
  reason?: string;
  messageCount?: number;
  tokenCount?: number;
}): Promise<SessionLifecycleEvent> {
  const { randomUUID } = await import("node:crypto");
  return {
    id: randomUUID(),
    stream: "session_lifecycle",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionKey,
    agentId: params.agentId,
    data: {
      sessionKey: params.sessionKey,
      previousState: params.previousState,
      newState: params.newState,
      reason: params.reason,
      messageCount: params.messageCount,
      tokenCount: params.tokenCount,
    },
  };
}

/**
 * Build a security event
 */
export function buildSecurityEvent(params: {
  type:
    | "permission_denied"
    | "config_mutation"
    | "file_access_violation"
    | "auth_event"
    | "suspicious_activity";
  severity: "info" | "warn" | "critical";
  source: string;
  timestamp?: number;
  sessionId?: string;
  agentId?: string;
  details: unknown;
}): SecurityEvent {
  const { randomUUID } = require("node:crypto");
  return {
    id: randomUUID(),
    stream: "security_events",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionId,
    agentId: params.agentId,
    data: {
      severity: params.severity,
      source: params.source,
      details: params.details,
    },
  };
}

/**
 * Build a security event (async version)
 */
export async function buildSecurityEventAsync(params: {
  type:
    | "permission_denied"
    | "config_mutation"
    | "file_access_violation"
    | "auth_event"
    | "suspicious_activity";
  severity: "info" | "warn" | "critical";
  source: string;
  timestamp?: number;
  sessionId?: string;
  agentId?: string;
  details: unknown;
}): Promise<SecurityEvent> {
  const { randomUUID } = await import("node:crypto");
  return {
    id: randomUUID(),
    stream: "security_events",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionId,
    agentId: params.agentId,
    data: {
      severity: params.severity,
      source: params.source,
      details: params.details,
    },
  };
}

/**
 * Build an agent action event
 */
export function buildAgentActionEvent(params: {
  type: "consult_initiated" | "internal_tool" | "state_change" | "subagent_spawned";
  action: string;
  timestamp?: number;
  sessionId?: string;
  agentId?: string;
  target?: string;
  result?: unknown;
}): AgentActionEvent {
  const { randomUUID } = require("node:crypto");
  return {
    id: randomUUID(),
    stream: "agent_actions",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionId,
    agentId: params.agentId,
    data: {
      action: params.action,
      target: params.target,
      result: params.result,
    },
  };
}

/**
 * Build an agent action event (async version)
 */
export async function buildAgentActionEventAsync(params: {
  type: "consult_initiated" | "internal_tool" | "state_change" | "subagent_spawned";
  action: string;
  timestamp?: number;
  sessionId?: string;
  agentId?: string;
  target?: string;
  result?: unknown;
}): Promise<AgentActionEvent> {
  const { randomUUID } = await import("node:crypto");
  return {
    id: randomUUID(),
    stream: "agent_actions",
    type: params.type,
    timestamp: params.timestamp ?? Date.now(),
    sessionId: params.sessionId,
    agentId: params.agentId,
    data: {
      action: params.action,
      target: params.target,
      result: params.result,
    },
  };
}

/**
 * Emit a tool invocation event
 *
 * Call when a tool is about to be invoked (after policy check).
 */
export async function emitToolInvocation(params: {
  toolName: string;
  parameters: unknown;
  sessionId?: string;
  agentId?: string;
}): Promise<void> {
  const event = buildToolCallEvent({
    type: "tool_invocation",
    toolName: params.toolName,
    parameters: params.parameters,
    sessionId: params.sessionId,
    agentId: params.agentId,
    allowed: true,
  });
  await appendEvent(event);
}

/**
 * Emit a tool success event
 *
 * Call when a tool completes successfully.
 */
export async function emitToolSuccess(params: {
  toolName: string;
  result: unknown;
  durationMs: number;
  sessionId?: string;
  agentId?: string;
}): Promise<void> {
  const event = buildToolCallEvent({
    type: "tool_success",
    toolName: params.toolName,
    result: params.result,
    durationMs: params.durationMs,
    sessionId: params.sessionId,
    agentId: params.agentId,
    allowed: true,
  });
  await appendEvent(event);
}

/**
 * Emit a tool error event
 *
 * Call when a tool fails or times out.
 */
export async function emitToolError(params: {
  toolName: string;
  error: string;
  durationMs?: number;
  sessionId?: string;
  agentId?: string;
}): Promise<void> {
  const event = buildToolCallEvent({
    type: "tool_error",
    toolName: params.toolName,
    error: params.error,
    durationMs: params.durationMs,
    sessionId: params.sessionId,
    agentId: params.agentId,
    allowed: true,
  });
  await appendEvent(event);
}

/**
 * Emit a tool denied event
 *
 * Call when a tool call is blocked by policy.
 */
export async function emitToolDenied(params: {
  toolName: string;
  parameters?: unknown;
  denyReason: string;
  sessionId?: string;
  agentId?: string;
}): Promise<void> {
  const event = buildToolCallEvent({
    type: "tool_denied",
    toolName: params.toolName,
    parameters: params.parameters,
    denyReason: params.denyReason,
    sessionId: params.sessionId,
    agentId: params.agentId,
    allowed: false,
  });
  await appendEvent(event);
}

/**
 * Emit a policy decision event
 *
 * Call when a policy decision is made.
 */
export async function emitPolicyDecision(params: {
  requestType: string;
  decision: "allow" | "deny";
  reason?: string;
  policyRule?: string;
  context?: Record<string, unknown>;
  sessionId?: string;
  agentId?: string;
}): Promise<void> {
  const event = buildPolicyDecisionEvent({
    type: params.decision === "allow" ? "permission_allowed" : "permission_denied",
    requestType: params.requestType,
    decision: params.decision,
    reason: params.reason,
    policyRule: params.policyRule,
    context: params.context,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  await appendEvent(event);
}

/**
 * Emit a session lifecycle event
 *
 * Call when a session state changes.
 */
export async function emitSessionLifecycle(params: {
  type: "created" | "started" | "stopped" | "compacted" | "archived" | "deleted";
  sessionKey: string;
  agentId?: string;
  previousState?: string;
  newState?: string;
  reason?: string;
  messageCount?: number;
  tokenCount?: number;
}): Promise<void> {
  const event = buildSessionLifecycleEvent(params);
  await appendEvent(event);
}

/**
 * Register event ledger as a session lifecycle listener
 *
 * Automatically converts session lifecycle events to audit ledger events.
 * Returns an unsubscribe function.
 */
export function registerSessionLifecycleListener(): () => void {
  let unsubscribe: (() => void) | null = null;

  // Lazy import to avoid circular dependency
  import("../sessions/session-lifecycle-events.js")
    .then((mod) => {
      unsubscribe = mod.onSessionLifecycleEvent((event) => {
        // Infer type from reason or default to created
        let eventType: "created" | "started" | "stopped" | "deleted" = "created";
        const reason = event.reason?.toLowerCase() ?? "";
        if (reason.includes("start") || reason.includes("begin")) {
          eventType = "started";
        } else if (
          reason.includes("stop") ||
          reason.includes("end") ||
          reason.includes("complete")
        ) {
          eventType = "stopped";
        } else if (reason.includes("delete") || reason.includes("remove")) {
          eventType = "deleted";
        }

        void emitSessionLifecycle({
          type: eventType,
          sessionKey: event.sessionKey,
          reason: event.reason,
        });
      });
    })
    .catch(() => {
      // Module not available, ignore
    });

  return () => {
    unsubscribe?.();
  };
}
