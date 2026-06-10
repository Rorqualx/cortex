/**
 * Session context propagation via AsyncLocalStorage.
 *
 * Allows the session identity (sessionKey) to flow from the gateway's chat
 * dispatch through to tool execution without modifying every function
 * signature in between.
 *
 * Usage:
 *   // At the gateway dispatch boundary:
 *   runWithSessionContext(sessionKey, () => { ... agent run ... });
 *
 *   // Inside any tool handler:
 *   const key = getSessionKey(); // returns the current session key or undefined
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Metadata about the current session, propagated through the call chain.
 */
export interface SessionContextInfo {
  /** Gateway-level session key (e.g. "main", "session:abc123") */
  sessionKey: string;
  /** Agent ID if available (e.g. "main", "codex") */
  agentId?: string;
  /** Human-readable label or task description */
  label?: string;
}

const sessionContextStore = new AsyncLocalStorage<SessionContextInfo>();

/**
 * Get the current session context info, or undefined if not running inside
 * a session context (e.g. tests, CLI commands outside the gateway).
 */
export function getSessionContext(): SessionContextInfo | undefined {
  return sessionContextStore.getStore();
}

/**
 * Get the current session key, or undefined.
 */
export function getSessionKey(): string | undefined {
  return sessionContextStore.getStore()?.sessionKey;
}

/**
 * Run a function with the given session context.
 * Nested calls inherit/override the context.
 */
export function runWithSessionContext<T>(info: SessionContextInfo, fn: () => T): T {
  return sessionContextStore.run(info, fn);
}

/**
 * Update the current session context metadata (e.g. set label after task starts).
 * Returns true if the context was updated, false if no session context exists.
 */
export function updateSessionContextMetadata(
  update: Partial<Pick<SessionContextInfo, "agentId" | "label">>,
): boolean {
  const store = sessionContextStore.getStore();
  if (!store) {
    return false;
  }
  if (update.agentId !== undefined) {
    store.agentId = update.agentId;
  }
  if (update.label !== undefined) {
    store.label = update.label;
  }
  return true;
}
