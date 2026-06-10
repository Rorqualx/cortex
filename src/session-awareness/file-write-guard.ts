/**
 * File Write Guard — cross-session write conflict detection.
 *
 * Wraps file mutation operations with conflict checking against the
 * SessionActivityRegistry. When another session has claimed a file,
 * the guard returns a descriptive error instead of allowing the write.
 *
 * This integrates with the existing file-mutation-queue.ts to add
 * cross-session awareness on top of the existing per-file serialization.
 */

import { sessionActivityRegistry, type FileConflict } from "./session-activity-registry.js";
import { getSessionContext } from "./session-context.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface WriteGuardResult {
  /** Whether the write is allowed. */
  allowed: boolean;
  /** The conflict if the write is blocked. */
  conflict?: FileConflict;
  /** The session key of the writer. */
  sessionKey?: string;
}

export interface WriteGuardError {
  /** Human-readable error message for the agent. */
  message: string;
  /** The conflict details. */
  conflict: FileConflict;
  /** Suggested action. */
  suggestion: string;
}

// ── Guard Logic ────────────────────────────────────────────────────────

/**
 * Check whether a file write should be allowed for the current session.
 *
 * Returns:
 * - { allowed: true } if no conflict or guard is disabled
 * - { allowed: false, conflict } if another session has claimed the file
 */
export function checkFileWrite(filePath: string, toolName: string): WriteGuardResult {
  const ctx = getSessionContext();

  if (!ctx) {
    // No session context — running outside the gateway (tests, CLI).
    // Allow writes without conflict checking.
    return { allowed: true };
  }

  if (!sessionActivityRegistry.enabled) {
    return { allowed: true, sessionKey: ctx.sessionKey };
  }

  const conflict = sessionActivityRegistry.checkConflict(ctx.sessionKey, filePath);
  if (conflict) {
    return { allowed: false, conflict, sessionKey: ctx.sessionKey };
  }

  return { allowed: true, sessionKey: ctx.sessionKey };
}

/**
 * Claim a file for writing by the current session.
 * Should be called before the actual write operation.
 */
export function claimFileForWrite(
  filePath: string,
  toolName: string,
): { ok: true } | { ok: false; error: WriteGuardError } {
  const ctx = getSessionContext();

  if (!ctx || !sessionActivityRegistry.enabled) {
    return { ok: true };
  }

  const result = sessionActivityRegistry.claimFile(ctx.sessionKey, filePath, toolName, {
    agentId: ctx.agentId,
  });

  if (result.ok) {
    return { ok: true };
  }

  const conflict = result.conflict;
  const claimedBy = conflict.claimedBy;
  const timeSince = Date.now() - claimedBy.claimedAt;
  const timeStr =
    timeSince < 60_000
      ? `${Math.round(timeSince / 1000)}s ago`
      : `${Math.round(timeSince / 60_000)}m ago`;

  const sessionLabel = claimedBy.agentId
    ? `session "${claimedBy.sessionKey}" (agent: ${claimedBy.agentId})`
    : `session "${claimedBy.sessionKey}"`;

  return {
    ok: false,
    error: {
      message: `File write conflict: ${filePath} is currently being written by ${sessionLabel} via ${claimedBy.toolName} (claimed ${timeStr}).`,
      conflict,
      suggestion:
        "Wait for the other session to finish and retry, or coordinate with the other agent before writing to this file.",
    },
  };
}

/**
 * Release a file claim after writing is complete.
 */
export function releaseFileClaim(filePath: string): void {
  const ctx = getSessionContext();
  if (!ctx || !sessionActivityRegistry.enabled) {
    return;
  }
  sessionActivityRegistry.releaseFile(ctx.sessionKey, filePath);
}

/**
 * Format a write guard error as a tool result (for returning to the agent).
 */
export function formatWriteGuardError(error: WriteGuardError): string {
  return [
    `⛔ Cross-session write conflict:`,
    ``,
    `${error.message}`,
    ``,
    `💡 ${error.suggestion}`,
    ``,
    `Conflict details:`,
    `  • File: ${error.conflict.filePath}`,
    `  • Claimed by: ${error.conflict.claimedBy.sessionKey}`,
    `  • Tool: ${error.conflict.claimedBy.toolName}`,
    error.conflict.claimedBy.agentId ? `  • Agent: ${error.conflict.claimedBy.agentId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
