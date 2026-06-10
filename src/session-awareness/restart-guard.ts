/**
 * Restart Guard — prevents gateway restarts while sessions are active.
 *
 * Provides:
 * 1. A query function to check for active sessions
 * 2. A CLI-friendly summary of active sessions
 * 3. Integration point for prod-restart.sh
 *
 * Usage from scripts:
 *   node -e "const { checkRestartSafety } = require('./dist/session-awareness/restart-guard.js'); console.log(JSON.stringify(checkRestartSafety()));"
 */

import {
  sessionActivityRegistry,
  type SessionActivity,
  type ScopedClaim,
} from "./session-activity-registry.js";

export interface RestartSafetyCheck {
  /** Whether it's safe to restart (no active sessions). */
  safe: boolean;
  /** Number of active sessions with claims. */
  activeSessionCount: number;
  /** Total number of active file claims. */
  activeClaimCount: number;
  /** Total number of active scoped claims (repo, restart). */
  activeScopedClaimCount: number;
  /** Details about active sessions. */
  sessions: RestartSafetySession[];
  /** Human-readable summary. */
  summary: string;
}

export interface RestartSafetySession {
  sessionKey: string;
  agentId?: string;
  label?: string;
  claimedFileCount: number;
  claimedFiles: string[];
}

/**
 * Check whether it's safe to restart the gateway.
 *
 * Returns a detailed report of active sessions and their file claims.
 */
export function checkRestartSafety(): RestartSafetyCheck {
  // Expire any stale claims first
  sessionActivityRegistry.expireStaleClaims();

  const activeSessions = sessionActivityRegistry.getActiveSessions();
  const allClaims = sessionActivityRegistry.getAllClaims();
  const allScopedClaims = sessionActivityRegistry.getAllScopedClaims();

  const sessions: RestartSafetySession[] = [];
  const sessionMap = new Map<string, RestartSafetySession>();

  // Build session summaries from file claims
  for (const claim of allClaims) {
    let session = sessionMap.get(claim.sessionKey);
    if (!session) {
      const activity = activeSessions.find((s) => s.sessionKey === claim.sessionKey);
      session = {
        sessionKey: claim.sessionKey,
        agentId: claim.agentId ?? activity?.agentId,
        claimedFileCount: 0,
        claimedFiles: [],
      };
      sessionMap.set(claim.sessionKey, session);
      sessions.push(session);
    }
    session.claimedFileCount++;
    session.claimedFiles.push(
      claim.resolvedPath.length > 60 ? "..." + claim.resolvedPath.slice(-57) : claim.resolvedPath,
    );
  }

  // Add sessions that have scoped claims but no file claims
  for (const scoped of allScopedClaims) {
    if (sessionMap.has(scoped.sessionKey)) continue;
    const session: RestartSafetySession = {
      sessionKey: scoped.sessionKey,
      agentId: scoped.agentId,
      claimedFileCount: 0,
      claimedFiles: [],
    };
    sessionMap.set(scoped.sessionKey, session);
    sessions.push(session);
  }

  // Block if there are ANY active claims (file or scoped)
  const hasActiveOps = allClaims.length > 0 || allScopedClaims.length > 0;
  const safe = !hasActiveOps;
  const summary = safe
    ? "No active claims. Safe to restart."
    : formatRestartBlockSummary(sessions, allScopedClaims);

  return {
    safe,
    activeSessionCount: sessions.length,
    activeClaimCount: allClaims.length,
    activeScopedClaimCount: allScopedClaims.length,
    sessions,
    summary,
  };
}

/**
 * Format a human-readable summary for the restart guard.
 */
function formatRestartBlockSummary(
  sessions: RestartSafetySession[],
  scopedClaims: ScopedClaim[],
): string {
  const lines: string[] = [
    `⚠️  Cannot restart: ${sessions.length} active session(s) with claims:`,
    "",
  ];

  // Show scoped claims first (repo ops, restarts)
  if (scopedClaims.length > 0) {
    lines.push("Active operations:");
    for (const claim of scopedClaims) {
      const sessionLabel = claim.agentId
        ? `${claim.sessionKey} (agent: ${claim.agentId})`
        : claim.sessionKey;
      lines.push(`  • [${claim.scope}] ${claim.description} — ${sessionLabel}`);
    }
    lines.push("");
  }

  for (const session of sessions) {
    const agentLabel = session.agentId ? ` (agent: ${session.agentId})` : "";
    lines.push(
      `  • Session "${session.sessionKey}"${agentLabel}: ${session.claimedFileCount} file(s)`,
    );
    for (const file of session.claimedFiles.slice(0, 5)) {
      lines.push(`    - ${file}`);
    }
    if (session.claimedFiles.length > 5) {
      lines.push(`    ... and ${session.claimedFiles.length - 5} more`);
    }
  }

  lines.push("");
  lines.push("Wait for active sessions to finish, or use --force to override.");
  return lines.join("\n");
}
