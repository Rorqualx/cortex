/**
 * Session Awareness — cross-session coordination for the OpenClaw gateway.
 *
 * Provides:
 * 1. Session identity propagation via AsyncLocalStorage
 * 2. Cross-session file write conflict detection
 * 3. Session activity metadata for restart guards and awareness
 * 4. Restart protection (active session checking)
 *
 * Architecture:
 * - SessionActivityRegistry (module singleton) tracks file claims and session metadata
 * - AsyncLocalStorage propagates session identity from gateway dispatch → tool execution
 * - FileWriteGuard wraps file mutations with cross-session conflict checking
 * - The guard integrates into the existing file-mutation-queue.ts
 */

// ── Public API ─────────────────────────────────────────────────────────

export {
  getSessionContext,
  getSessionKey,
  runWithSessionContext,
  updateSessionContextMetadata,
  type SessionContextInfo,
} from "./session-context.js";

export {
  SessionActivityRegistry,
  sessionActivityRegistry,
  type FileClaim,
  type FileConflict,
  type SessionActivity,
  type SessionActivityRegistryOptions,
  type ScopedClaim,
  type ScopedConflict,
  type ClaimScope,
} from "./session-activity-registry.js";

export {
  checkFileWrite,
  claimFileForWrite,
  releaseFileClaim,
  formatWriteGuardError,
  type WriteGuardResult,
  type WriteGuardError,
} from "./file-write-guard.js";

export {
  checkRestartSafety,
  type RestartSafetyCheck,
  type RestartSafetySession,
} from "./restart-guard.js";

export {
  checkExecGuard,
  releaseExecGuard,
  formatExecGuardError,
  type ExecGuardResult,
  type ExecGuardError,
} from "./exec-guard.js";
