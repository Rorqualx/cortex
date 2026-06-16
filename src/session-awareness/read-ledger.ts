/**
 * Session Read Ledger — in-memory record of which files each session has read.
 *
 * Powers read-before-edit enforcement (file-write-guard.checkReadBeforeMutation)
 * and lets the read tool annotate unchanged repeat reads. Like the
 * SessionActivityRegistry, this is a module-level singleton shared by all
 * sessions in the same gateway process.
 *
 * Recording is scoped to the active session via getSessionContext(); outside the
 * gateway (CLI, tests) there is no session context, so every method no-ops and
 * those paths keep working unchanged. Records are dropped on session teardown
 * (see chat.ts, beside releaseAllForSession).
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { getSessionContext } from "./session-context.js";

/** Identity of a file's content at read time. */
export interface ReadStat {
  /** Byte length of the file content. */
  size: number;
  /** File mtime in epoch ms, when a local stat was available (absent for remote backends). */
  mtimeMs?: number;
}

export interface ReadRecord extends ReadStat {
  resolvedPath: string;
  firstReadAt: number;
  lastReadAt: number;
}

/** Resolve to canonical realpath for consistent keying (mirrors the activity registry). */
function resolveFilePath(filePath: string): string {
  const resolved = resolve(filePath);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

class ReadLedger {
  // sessionKey → (resolvedPath → record)
  private readonly reads = new Map<string, Map<string, ReadRecord>>();

  /** Record (or refresh) a read of a file by the current session. No-op without session context. */
  recordRead(filePath: string, stat: ReadStat): void {
    const ctx = getSessionContext();
    if (!ctx) {
      return;
    }
    const resolvedPath = resolveFilePath(filePath);
    let perSession = this.reads.get(ctx.sessionKey);
    if (!perSession) {
      perSession = new Map();
      this.reads.set(ctx.sessionKey, perSession);
    }
    const now = Date.now();
    const existing = perSession.get(resolvedPath);
    perSession.set(resolvedPath, {
      resolvedPath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      firstReadAt: existing?.firstReadAt ?? now,
      lastReadAt: now,
    });
  }

  /** The current session's read record for a file, if any. */
  getRead(filePath: string): ReadRecord | undefined {
    const ctx = getSessionContext();
    if (!ctx) {
      return undefined;
    }
    const resolvedPath = resolveFilePath(filePath);
    return this.reads.get(ctx.sessionKey)?.get(resolvedPath);
  }

  /**
   * True iff the current session has read this file and `stat` matches that read.
   * Staleness compares size and (when both sides have it) mtime; remote backends
   * that lack mtime fall back to size-only, accepting weaker staleness detection
   * rather than blocking on uncertainty.
   */
  wasReadFresh(filePath: string, stat: ReadStat): boolean {
    const record = this.getRead(filePath);
    if (!record) {
      return false;
    }
    if (record.size !== stat.size) {
      return false;
    }
    if (record.mtimeMs !== undefined && stat.mtimeMs !== undefined) {
      return record.mtimeMs === stat.mtimeMs;
    }
    return true;
  }

  /** Drop all reads tracked for a session (called on session teardown). */
  clearSession(sessionKey: string): void {
    this.reads.delete(sessionKey);
  }

  /** Test-only reset. */
  clear(): void {
    this.reads.clear();
  }
}

/**
 * The default global read ledger, shared across all sessions in the gateway
 * process. Tools and guards should use this instance.
 */
export const readLedger = new ReadLedger();
