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

import { existsSync, statSync } from "node:fs";
import { readLedger } from "./read-ledger.js";
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

// ── Read-before-edit Guard ─────────────────────────────────────────────

/** Error returned when an edit targets a file the session has not read (or that changed since). */
export interface ReadBeforeEditError {
  /** Human-readable reason for the agent. */
  message: string;
  /** Suggested next action. */
  suggestion: string;
}

/**
 * Tools that mutate existing file content and therefore require the file to have
 * been read this session. New-file creation (`write`, apply-patch `add`) is
 * intentionally excluded — there is nothing to read first.
 */
const READ_BEFORE_EDIT_TOOLS = new Set(["edit", "apply_patch"]);

/**
 * Check that the current session has read a file's current content before editing
 * it. Blocks blind edits — the dominant cause of `oldText` mismatch retry loops —
 * and edits against content that changed on disk since the last read.
 *
 * Returns `{ ok: true }` (allow) when: the tool is not a content-mutating tool,
 * there is no session context (CLI/tests), session-awareness is disabled, the
 * target does not exist yet (creation), or the file was read fresh this session.
 */
export function checkReadBeforeMutation(
  filePath: string,
  toolName: string,
): { ok: true } | { ok: false; error: ReadBeforeEditError } {
  if (!READ_BEFORE_EDIT_TOOLS.has(toolName)) {
    return { ok: true };
  }

  const ctx = getSessionContext();
  // Reuse the session-awareness switch: the read ledger only tracks reads inside
  // a gateway session, and disabling awareness disables this guard with it.
  if (!ctx || !sessionActivityRegistry.enabled) {
    return { ok: true };
  }

  let stat: { size: number; mtimeMs: number };
  try {
    if (!existsSync(filePath)) {
      // File does not exist yet — this is a creation, not a blind edit of existing content.
      return { ok: true };
    }
    const s = statSync(filePath);
    stat = { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    // Cannot stat (permissions, race) — do not block on uncertainty.
    return { ok: true };
  }

  if (readLedger.wasReadFresh(filePath, stat)) {
    return { ok: true };
  }

  const previouslyRead = readLedger.getRead(filePath) !== undefined;
  const reason = previouslyRead
    ? "it changed on disk since your last read"
    : "it was not read in this session";
  return {
    ok: false,
    error: {
      message: `Edit blocked: ${filePath} cannot be edited because ${reason}.`,
      suggestion: `Read ${filePath} first, then retry the edit.`,
    },
  };
}

/** Format a read-before-edit error as a tool result (for returning to the agent). */
export function formatReadBeforeEditError(error: ReadBeforeEditError): string {
  return [`⛔ ${error.message}`, ``, `💡 ${error.suggestion}`].join("\n");
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
