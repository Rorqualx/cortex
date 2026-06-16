/**
 * Session Activity Registry — in-memory registry tracking active file write
 * claims across sessions.
 *
 * This is a module-level singleton (like file-mutation-queue.ts), shared by
 * all sessions in the same gateway process.
 *
 * Responsibilities:
 * 1. Track which session has claimed which file for writing
 * 2. Detect cross-session write conflicts
 * 3. Provide session activity metadata for restart guards and awareness tools
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

/** Types of scoped operations that can be claimed. */
export type ClaimScope = "file" | "repo" | "restart";

/** A claim on a file by a specific session. */
export interface FileClaim {
  /** The session that holds the claim. */
  sessionKey: string;
  /** Agent ID if available. */
  agentId?: string;
  /** Tool that created the claim (e.g. "write", "edit"). */
  toolName: string;
  /** When the claim was established (epoch ms). */
  claimedAt: number;
  /** Resolved absolute path (realpath). */
  resolvedPath: string;
}

/** Summary of a conflict detected between two sessions. */
export interface FileConflict {
  /** The file path that is in conflict. */
  filePath: string;
  /** The session that currently holds the claim. */
  claimedBy: FileClaim;
}

/** A scoped (non-file) claim — repo operations, restarts, etc. */
export interface ScopedClaim {
  /** The session that holds the claim. */
  sessionKey: string;
  /** Agent ID if available. */
  agentId?: string;
  /** What kind of operation is claimed. */
  scope: ClaimScope;
  /** Human-readable description of what's happening. */
  description: string;
  /** When the claim was established (epoch ms). */
  claimedAt: number;
  /** Unique key for this scope (e.g. "repo:/path/to/cwd" or "restart:gateway"). */
  scopeKey: string;
}

/** Conflict on a scoped operation. */
export interface ScopedConflict {
  /** The scope that is in conflict. */
  scope: ClaimScope;
  /** The session that holds the claim. */
  claimedBy: ScopedClaim;
}

/** Metadata about an active session. */
export interface SessionActivity {
  sessionKey: string;
  agentId?: string;
  label?: string;
  /** Files currently claimed by this session. */
  claimedFiles: string[];
  /** When the session first registered activity (epoch ms). */
  firstSeenAt: number;
  /** When the session was last active (epoch ms). */
  lastActiveAt: number;
}

/** Options for the registry. */
export interface SessionActivityRegistryOptions {
  /**
   * Maximum duration a claim can be held before it's auto-expired (ms).
   * Default: 5 minutes. Prevents stale claims from dead sessions.
   */
  claimExpiryMs?: number;
  /**
   * Whether the cross-session write guard is enabled.
   * Default: true. Set to false to disable conflict checking.
   */
  enabled?: boolean;
}

// ── Registry ───────────────────────────────────────────────────────────

const DEFAULT_CLAIM_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve a file path to its canonical form for consistent keying.
 * Follows symlinks and normalizes the path.
 */
function resolveFilePath(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

export class SessionActivityRegistry {
  private readonly claims = new Map<string, FileClaim>(); // resolvedPath → claim
  private readonly sessions = new Map<string, SessionActivity>(); // sessionKey → metadata
  private readonly scopedClaims = new Map<string, ScopedClaim>(); // scopeKey → claim
  private readonly claimExpiryMs: number;
  private enabledFlag: boolean;

  constructor(options?: SessionActivityRegistryOptions) {
    this.claimExpiryMs = options?.claimExpiryMs ?? DEFAULT_CLAIM_EXPIRY_MS;
    this.enabledFlag = options?.enabled ?? true;
  }

  // ── Configuration ──────────────────────────────────────────────────

  get enabled(): boolean {
    return this.enabledFlag;
  }

  setEnabled(value: boolean): void {
    this.enabledFlag = value;
  }

  // ── Claim Management ───────────────────────────────────────────────

  /**
   * Try to claim a file for a session. Returns the claim on success,
   * or a conflict description if another session already holds the claim.
   *
   * A session can always re-claim a file it already holds (no self-conflict).
   */
  claimFile(
    sessionKey: string,
    filePath: string,
    toolName: string,
    options?: { agentId?: string },
  ): { ok: true; claim: FileClaim } | { ok: false; conflict: FileConflict } {
    if (!this.enabledFlag) {
      const resolvedPath = resolveFilePath(filePath);
      const claim: FileClaim = {
        sessionKey,
        agentId: options?.agentId,
        toolName,
        claimedAt: Date.now(),
        resolvedPath,
      };
      return { ok: true, claim };
    }

    const now = Date.now();
    const resolvedPath = resolveFilePath(filePath);

    // Check for existing claim
    const existing = this.claims.get(resolvedPath);
    if (existing) {
      // Auto-expire stale claims
      if (now - existing.claimedAt > this.claimExpiryMs) {
        this.claims.delete(resolvedPath);
      } else if (existing.sessionKey !== sessionKey) {
        // Conflict: another session holds this file
        return {
          ok: false,
          conflict: {
            filePath,
            claimedBy: existing,
          },
        };
      }
      // Same session re-claiming — update timestamp
    }

    const claim: FileClaim = {
      sessionKey,
      agentId: options?.agentId,
      toolName,
      claimedAt: now,
      resolvedPath,
    };
    this.claims.set(resolvedPath, claim);
    this.touchSession(sessionKey, options?.agentId);
    return { ok: true, claim };
  }

  /**
   * Release a file claim. Only the owning session can release it.
   */
  releaseFile(sessionKey: string, filePath: string): boolean {
    const resolvedPath = resolveFilePath(filePath);
    const existing = this.claims.get(resolvedPath);
    if (!existing || existing.sessionKey !== sessionKey) {
      return false;
    }
    this.claims.delete(resolvedPath);
    this.touchSession(sessionKey);
    return true;
  }

  /**
   * Release all claims held by a session.
   * Called when a session ends or becomes idle.
   */
  releaseAllForSession(sessionKey: string): number {
    let released = 0;
    for (const [path, claim] of this.claims) {
      if (claim.sessionKey === sessionKey) {
        this.claims.delete(path);
        released++;
      }
    }
    for (const [key, claim] of this.scopedClaims) {
      if (claim.sessionKey === sessionKey) {
        this.scopedClaims.delete(key);
        released++;
      }
    }
    // Remove session metadata
    this.sessions.delete(sessionKey);
    return released;
  }

  // ── Query Methods ──────────────────────────────────────────────────

  /**
   * Check if a file is currently claimed by any session.
   */
  isFileClaimed(filePath: string): boolean {
    const resolvedPath = resolveFilePath(filePath);
    const claim = this.claims.get(resolvedPath);
    if (!claim) {
      return false;
    }
    // Check for expiry
    if (Date.now() - claim.claimedAt > this.claimExpiryMs) {
      this.claims.delete(resolvedPath);
      return false;
    }
    return true;
  }

  /**
   * Get the claim on a file, if any.
   */
  getFileClaim(filePath: string): FileClaim | undefined {
    const resolvedPath = resolveFilePath(filePath);
    const claim = this.claims.get(resolvedPath);
    if (!claim) {
      return undefined;
    }
    if (Date.now() - claim.claimedAt > this.claimExpiryMs) {
      this.claims.delete(resolvedPath);
      return undefined;
    }
    return claim;
  }

  /**
   * Check if claiming a file would cause a conflict for a given session.
   */
  checkConflict(sessionKey: string, filePath: string): FileConflict | undefined {
    const resolvedPath = resolveFilePath(filePath);
    const existing = this.claims.get(resolvedPath);
    if (!existing) {
      return undefined;
    }
    if (Date.now() - existing.claimedAt > this.claimExpiryMs) {
      this.claims.delete(resolvedPath);
      return undefined;
    }
    if (existing.sessionKey === sessionKey) {
      return undefined;
    }
    return { filePath, claimedBy: existing };
  }

  /**
   * Get all files currently claimed by a session.
   */
  getSessionClaims(sessionKey: string): FileClaim[] {
    const result: FileClaim[] = [];
    for (const claim of this.claims.values()) {
      if (claim.sessionKey === sessionKey) {
        result.push(claim);
      }
    }
    return result;
  }

  /**
   * Get metadata about all active sessions.
   */
  getActiveSessions(): SessionActivity[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get a summary of all current claims.
   */
  getAllClaims(): FileClaim[] {
    return Array.from(this.claims.values());
  }

  /**
   * Get the number of active claims.
   */
  get claimCount(): number {
    return this.claims.size;
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  /**
   * Expire all stale claims (older than claimExpiryMs).
   * Returns the number of expired claims.
   */
  expireStaleClaims(): number {
    const now = Date.now();
    let expired = 0;
    for (const [path, claim] of this.claims) {
      if (now - claim.claimedAt > this.claimExpiryMs) {
        this.claims.delete(path);
        expired++;
      }
    }
    return expired;
  }

  /**
   * Clear all claims and session metadata.
   */
  clear(): void {
    this.claims.clear();
    this.sessions.clear();
    this.scopedClaims.clear();
  }

  // ── Scoped Claims (repo, restart, etc.) ───────────────────────────

  /**
   * Claim a scoped operation (e.g. repo commit/push, gateway restart).
   * Returns the claim on success, or a conflict if another session holds it.
   */
  claimScoped(
    sessionKey: string,
    scope: ClaimScope,
    scopeKey: string,
    description: string,
    options?: { agentId?: string },
  ): { ok: true; claim: ScopedClaim } | { ok: false; conflict: ScopedConflict } {
    if (!this.enabledFlag) {
      return {
        ok: true,
        claim: {
          sessionKey,
          agentId: options?.agentId,
          scope,
          description,
          claimedAt: Date.now(),
          scopeKey,
        },
      };
    }

    const now = Date.now();
    const existing = this.scopedClaims.get(scopeKey);
    if (existing) {
      if (now - existing.claimedAt > this.claimExpiryMs) {
        this.scopedClaims.delete(scopeKey);
      } else if (existing.sessionKey !== sessionKey) {
        return {
          ok: false,
          conflict: { scope, claimedBy: existing },
        };
      }
    }

    const claim: ScopedClaim = {
      sessionKey,
      agentId: options?.agentId,
      scope,
      description,
      claimedAt: now,
      scopeKey,
    };
    this.scopedClaims.set(scopeKey, claim);
    this.touchSession(sessionKey, options?.agentId);
    return { ok: true, claim };
  }

  /**
   * Release a scoped claim.
   */
  releaseScoped(sessionKey: string, scopeKey: string): boolean {
    const existing = this.scopedClaims.get(scopeKey);
    if (!existing || existing.sessionKey !== sessionKey) {
      return false;
    }
    this.scopedClaims.delete(scopeKey);
    return true;
  }

  /**
   * Get all scoped claims for a session.
   */
  getScopedClaims(sessionKey: string): ScopedClaim[] {
    const result: ScopedClaim[] = [];
    for (const claim of this.scopedClaims.values()) {
      if (claim.sessionKey === sessionKey) {
        result.push(claim);
      }
    }
    return result;
  }

  /**
   * Get all active scoped claims.
   */
  getAllScopedClaims(): ScopedClaim[] {
    return Array.from(this.scopedClaims.values());
  }

  /**
   * Check if a scoped operation would cause a conflict.
   */
  checkScopedConflict(sessionKey: string, scopeKey: string): ScopedConflict | undefined {
    const existing = this.scopedClaims.get(scopeKey);
    if (!existing) {
      return undefined;
    }
    if (Date.now() - existing.claimedAt > this.claimExpiryMs) {
      this.scopedClaims.delete(scopeKey);
      return undefined;
    }
    if (existing.sessionKey === sessionKey) {
      return undefined;
    }
    return { scope: existing.scope, claimedBy: existing };
  }

  /**
   * Get the number of active scoped claims.
   */
  get scopedClaimCount(): number {
    return this.scopedClaims.size;
  }

  // ── Internal ───────────────────────────────────────────────────────

  private touchSession(sessionKey: string, agentId?: string): void {
    const now = Date.now();
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      existing.lastActiveAt = now;
      if (agentId) {
        existing.agentId = agentId;
      }
    } else {
      this.sessions.set(sessionKey, {
        sessionKey,
        agentId,
        claimedFiles: [],
        firstSeenAt: now,
        lastActiveAt: now,
      });
    }
  }
}

// ── Module Singleton ───────────────────────────────────────────────────

/**
 * The default global registry instance, shared across all sessions in the
 * gateway process. Tools and guards should use this instance.
 */
export const sessionActivityRegistry = new SessionActivityRegistry();
