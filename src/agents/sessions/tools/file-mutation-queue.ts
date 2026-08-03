/**
 * Per-file mutation queue with cross-session write conflict detection.
 *
 * Serializes edits/writes targeting the same real file while allowing
 * independent files to mutate in parallel. When session-awareness is enabled,
 * also checks for cross-session write conflicts before allowing mutations.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkReadBeforeMutation,
  claimFileForWrite,
  formatReadBeforeEditError,
  formatWriteGuardError,
  releaseFileClaim,
} from "../../../session-awareness/file-write-guard.js";

const fileMutationTails = new Map<string, Promise<void>>();

function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

type FileMutationQueueOptions = {
  /** Tool performing the mutation (e.g. "write", "edit"); used in guard errors. */
  toolName?: string;
};

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
  return await withFileMutationQueues([filePath], fn, options);
}

/**
 * Multi-path variant: takes every queue slot before running, so a mutation
 * spanning several files (apply_patch) cannot interleave with a single-file
 * write to any of them.
 */
export async function withFileMutationQueues<T>(
  filePaths: readonly string[],
  fn: () => Promise<T>,
  options?: FileMutationQueueOptions,
): Promise<T> {
  const toolName = options?.toolName ?? "unknown";
  // Guard every target before running: a multi-path mutation is all-or-nothing,
  // so a rejection on a later path must release the claims already taken or the
  // run leaks write locks onto files it never touched.
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

  const keys = [...new Set(filePaths.map(getMutationQueueKey))].toSorted();
  const current = Promise.all(
    keys.map((key) => (fileMutationTails.get(key) ?? Promise.resolve()).catch(() => undefined)),
  )
    .then(fn)
    .finally(releaseClaimed);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) {
    fileMutationTails.set(key, tail);
  }
  const cleanup = () => {
    for (const key of keys) {
      if (fileMutationTails.get(key) === tail) {
        fileMutationTails.delete(key);
      }
    }
  };
  tail.then(cleanup, cleanup);
  return await current;
}
