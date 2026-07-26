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
  claimFileForWrite,
  releaseFileClaim,
  formatWriteGuardError,
  checkReadBeforeMutation,
  formatReadBeforeEditError,
} from "../../../session-awareness/file-write-guard.js";
import { KeyedAsyncQueue } from "../../../plugin-sdk/keyed-async-queue.js";

const fileMutationQueues = new Map<string, Promise<void>>();

function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 *
 * When session-awareness is active (AsyncLocalStorage has session context),
 * checks for cross-session write conflicts before queueing. If another session
 * has claimed this file, throws an error with conflict details.
 *
 * @param filePath - Absolute path to the file being mutated
 * @param fn - The mutation operation to execute
 * @param options - Optional configuration
 * @param options.toolName - Name of the tool performing the mutation (e.g. "write", "edit")
 */
export async function withFileMutationQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
  options?: { toolName?: string },
): Promise<T> {
  const key = getMutationQueueKey(filePath);

  // ── Read-before-edit check (no-op for non-edit tools / new files / outside a session) ──
  const readCheck = checkReadBeforeMutation(filePath, options?.toolName ?? "unknown");
  if (!readCheck.ok) {
    throw new Error(formatReadBeforeEditError(readCheck.error));
  }

  // ── Cross-session write conflict check ──
  const claimResult = claimFileForWrite(filePath, options?.toolName ?? "unknown");
  if (!claimResult.ok) {
    throw new Error(formatWriteGuardError(claimResult.error));
  }

  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolveQueue) => {
    releaseNext = resolveQueue;
  });
  const chainedQueue = currentQueue.then(() => nextQueue);
  fileMutationQueues.set(key, chainedQueue);

  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseFileClaim(filePath);
    releaseNext();
    if (fileMutationQueues.get(key) === chainedQueue) {
      fileMutationQueues.delete(key);
    }
  }
}
