import { getAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
/**
 * Per-file mutation queue with cross-session write conflict detection.
 *
 * Serializes reads and mutations targeting the same real file while allowing
 * independent files to run in parallel. When session-awareness is enabled,
 * also checks for cross-session write conflicts before allowing mutations.
 */
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/boundary-path.js";
import {
  checkReadBeforeMutation,
  claimFileForWrite,
  formatReadBeforeEditError,
  formatWriteGuardError,
  releaseFileClaim,
} from "../../../session-awareness/file-write-guard.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../../../shared/global-singleton.js";

const fileMutationTails = resolveGlobalMap<string, Promise<void>>(
  Symbol.for("openclaw.fileMutationTails"),
  "close-only",
);
const keyAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.fileMutationKeyAdmissions"),
  () => ({ fallbackScope: {}, tails: new WeakMap<object, Promise<void>>() }),
);

function resolveLocalFileMutationQueueKey(filePath: string): string {
  return resolveIdentityPathViaExistingAncestorSync(filePath);
}

export async function resolveFileMutationQueueKey(
  filePath: string,
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  return await (resolveQueueKey?.(filePath, signal) ?? resolveLocalFileMutationQueueKey(filePath));
}

type FileMutationQueueGuardOptions = {
  /** Tool performing the mutation (e.g. "write", "edit"); used in guard errors. */
  toolName?: string;
  /**
   * Original (pre-identity-resolution) target paths for the session-awareness
   * write guard: read-before-edit + cross-session claim checks. May be a
   * promise when callers only have pending path resolutions (apply_patch).
   */
  filePaths?: readonly string[] | Promise<readonly string[]>;
};

type FileMutationQueueOptions = FileMutationQueueGuardOptions & {
  /** Backend-specific physical identity resolver (for example SSH remote paths). */
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>;
  signal?: AbortSignal;
};

/**
 * Claim the guard paths for this session before admission: a multi-path
 * mutation is all-or-nothing, so a rejection on a later path must release the
 * claims already taken or the run leaks write locks onto files it never
 * touched. Claims stay held across the queue wait, mirroring the pre-admission
 * claim semantics the session-awareness write guard relies on.
 */
async function claimGuardPaths(
  filePaths: readonly string[],
  toolName: string,
): Promise<() => void> {
  const claimed: string[] = [];
  const releaseClaimed = () => {
    for (const claimedPath of claimed) {
      releaseFileClaim(claimedPath);
    }
    claimed.length = 0;
  };
  try {
    for (const filePath of filePaths) {
      // Read-before-edit check (no-op for non-edit tools / new files / outside a session).
      const readCheck = checkReadBeforeMutation(filePath, toolName);
      if (!readCheck.ok) {
        throw new Error(formatReadBeforeEditError(readCheck.error));
      }
      // Cross-session write conflict check.
      const claimResult = claimFileForWrite(filePath, toolName);
      if (!claimResult.ok) {
        throw new Error(formatWriteGuardError(claimResult.error));
      }
      claimed.push(filePath);
    }
  } catch (error) {
    releaseClaimed();
    throw error;
  }
  return releaseClaimed;
}

/**
 * Preserve source-call admission while backend-owned physical identities resolve concurrently.
 * Registration is ordered per assistant message; file operations still use only fileMutationTails.
 */
export async function withFileMutationQueueKeyResolution<T>(
  keyResolution: Promise<string>,
  fn: () => Promise<T>,
  options?: FileMutationQueueGuardOptions,
): Promise<T> {
  return await withFileMutationQueueKeysResolution(
    keyResolution.then((key) => [key]),
    fn,
    options,
  );
}

export async function withFileMutationQueueKeysResolution<T>(
  keysResolution: Promise<readonly string[]>,
  fn: () => Promise<T>,
  options?: FileMutationQueueGuardOptions,
): Promise<T> {
  const releaseClaims = options?.filePaths
    ? await claimGuardPaths(await options.filePaths, options.toolName ?? "unknown")
    : undefined;
  try {
    const scope = getAgentToolExecutionContext()?.assistantMessage ?? keyAdmissions.fallbackScope;
    const previousAdmission = keyAdmissions.tails.get(scope) ?? Promise.resolve();
    void keysResolution.catch(() => undefined);
    let operation!: Promise<T>;
    const admission = previousAdmission.then(async () => {
      const keys = await keysResolution;
      operation = enqueueFileMutationQueueKeys(keys, fn);
    });
    const tail = admission.then(
      () => undefined,
      () => undefined,
    );
    keyAdmissions.tails.set(scope, tail);
    const cleanup = () => {
      if (keyAdmissions.tails.get(scope) === tail) {
        keyAdmissions.tails.delete(scope);
      }
    };
    tail.then(cleanup, cleanup);
    await admission;
    return await operation;
  } finally {
    releaseClaims?.();
  }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 *
 * When session-awareness is active (AsyncLocalStorage has session context),
 * checks for cross-session write conflicts before queueing. If another session
 * has claimed this file, throws an error with conflict details.
 */
export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
  options?: FileMutationQueueOptions,
): Promise<T> {
  const keyResolution = resolveFileMutationQueueKey(
    filePath,
    options?.resolveQueueKey,
    options?.signal,
  );
  return await withFileMutationQueueKeysResolution(
    keyResolution.then((key) => [key]),
    fn,
    { toolName: options?.toolName, filePaths: [filePath] },
  );
}

function enqueueFileMutationQueueKeys<T>(
  queueKeys: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(queueKeys)].toSorted();
  const current = Promise.all(
    keys.map((key) => (fileMutationTails.get(key) ?? Promise.resolve()).catch(() => undefined)),
  ).then(fn);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  const cleanup = () => {
    for (const key of keys) {
      if (fileMutationTails.get(key) === tail) {
        fileMutationTails.delete(key);
      }
    }
  };
  tail.then(cleanup, cleanup);
  return current;
}
