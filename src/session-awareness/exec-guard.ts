/**
 * Exec Guard — protects git commit/push and gateway restart from cross-session conflicts.
 *
 * Intercepts exec commands before they run and checks for scoped operation conflicts:
 * - `git commit` / `git push` → claims "repo:<cwd>" scope
 * - `prod-restart.sh` / `openclaw gateway restart` → claims "restart:gateway" scope
 *
 * Usage:
 *   const guard = checkExecGuard(command, cwd);
 *   if (!guard.allowed) {
 *     throw new Error(formatExecGuardError(guard.error));
 *   }
 *   // ... run command ...
 *   releaseExecGuard(guard.scopeKey);
 */

import { resolve } from "node:path";
import { sessionActivityRegistry, type ScopedConflict } from "./session-activity-registry.js";
import { getSessionContext } from "./session-context.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface ExecGuardResult {
  /** Whether the command is allowed. */
  allowed: boolean;
  /** The scope key if a claim was made. */
  scopeKey?: string;
  /** Error details if blocked. */
  error?: ExecGuardError;
}

export interface ExecGuardError {
  /** Human-readable message. */
  message: string;
  /** The conflict details. */
  conflict: ScopedConflict;
  /** Suggested action. */
  suggestion: string;
}

// ── Command Detection ──────────────────────────────────────────────────

interface DetectedOperation {
  scope: "repo" | "restart";
  scopeKey: string;
  description: string;
}

/**
 * Detect if a command is a protected operation.
 * Returns the operation details, or undefined if the command is unprotected.
 */
function detectProtectedCommand(command: string, cwd: string): DetectedOperation | undefined {
  const trimmed = command.trim();

  // Normalize common patterns
  const isGitCommand =
    trimmed.startsWith("git ") ||
    trimmed.includes(" git ") ||
    trimmed.includes("&& git ") ||
    trimmed.includes("; git ") ||
    trimmed.includes("| git ") ||
    /^\s*git\s/.test(trimmed);

  if (isGitCommand) {
    // Check for commit or push specifically
    const isCommit = /\bgit\s+(commit|-c)\b/.test(trimmed);
    const isPush = /\bgit\s+push\b/.test(trimmed);
    const isTag = /\bgit\s+tag\b/.test(trimmed);

    if (isCommit || isPush || isTag) {
      const resolvedCwd = resolve(cwd);
      const opType = isPush ? "push" : isCommit ? "commit" : "tag";
      return {
        scope: "repo",
        scopeKey: `repo:${resolvedCwd}`,
        description: `git ${opType} in ${resolvedCwd}`,
      };
    }
  }

  // Restart detection
  const isRestart =
    trimmed.includes("prod-restart.sh") ||
    trimmed.includes("dev-restart.sh") ||
    /\bopenclaw\s+(gateway\s+)?restart\b/.test(trimmed) ||
    /\bgateway\s+restart\b/.test(trimmed) ||
    /\blaunchctl\s+kickstart.*openclaw\b/.test(trimmed) ||
    trimmed.includes("daemon-restart.py");

  if (isRestart) {
    return {
      scope: "restart",
      scopeKey: "restart:gateway",
      description: "gateway restart",
    };
  }

  return undefined;
}

// ── Guard Logic ────────────────────────────────────────────────────────

/**
 * Check if an exec command is allowed to run.
 * If it's a protected operation (git commit/push, restart), claims the scope.
 *
 * Returns:
 * - { allowed: true, scopeKey? } if the command is allowed
 * - { allowed: false, error } if blocked by another session's claim
 */
export function checkExecGuard(command: string, cwd: string): ExecGuardResult {
  const ctx = getSessionContext();

  if (!ctx || !sessionActivityRegistry.enabled) {
    return { allowed: true };
  }

  const op = detectProtectedCommand(command, cwd);
  if (!op) {
    return { allowed: true };
  }

  const result = sessionActivityRegistry.claimScoped(
    ctx.sessionKey,
    op.scope,
    op.scopeKey,
    op.description,
    { agentId: ctx.agentId },
  );

  if (result.ok) {
    return { allowed: true, scopeKey: op.scopeKey };
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

  const scopeLabel = op.scope === "restart" ? "Gateway restart" : "Git operation";

  return {
    allowed: false,
    error: {
      message: `${scopeLabel} blocked: ${op.description} is locked by ${sessionLabel} (${claimedBy.description}, claimed ${timeStr}).`,
      conflict,
      suggestion:
        op.scope === "restart"
          ? "Wait for the other session's operation to complete before restarting."
          : "Wait for the other session to finish its git operation, or coordinate pushes.",
    },
  };
}

/**
 * Release an exec guard claim after the command completes.
 */
export function releaseExecGuard(scopeKey: string | undefined): void {
  if (!scopeKey) {
    return;
  }
  const ctx = getSessionContext();
  if (!ctx || !sessionActivityRegistry.enabled) {
    return;
  }
  sessionActivityRegistry.releaseScoped(ctx.sessionKey, scopeKey);
}

/**
 * Format an exec guard error for display to the agent.
 */
export function formatExecGuardError(error: ExecGuardError): string {
  return [
    `⛔ Cross-session operation conflict:`,
    ``,
    error.message,
    ``,
    `💡 ${error.suggestion}`,
    ``,
    `Conflict details:`,
    `  • Scope: ${error.conflict.scope}`,
    `  • Claimed by: ${error.conflict.claimedBy.sessionKey}`,
    `  • Operation: ${error.conflict.claimedBy.description}`,
    error.conflict.claimedBy.agentId ? `  • Agent: ${error.conflict.claimedBy.agentId}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
