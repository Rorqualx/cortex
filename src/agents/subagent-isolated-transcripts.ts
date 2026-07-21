/**
 * Subagent isolated transcript storage.
 *
 * When a subagent spawns with `isolateTranscript: true`, its full output
 * is written to a sidechain file instead of being delivered directly to the
 * parent. The parent receives only a reference token `[isolated:<id>]` and
 * can fetch the full content on-demand.
 *
 * Storage pattern: `agents/<agentId>/agent/subagent-isolated/<isolatedTranscriptId>.jsonl`
 *
 * Lifecycle:
 * - Created when subagent completes with isolation enabled
 * - Accessible via `readIsolatedTranscript(id)`
 * - Cleaned up after TTL if never accessed
 * - Preserved if `accessedAt` is set (parent referenced the content)
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { logInfo, logWarn } from "../logger.js";

const ISOLATED_SUBDIR_NAME = "subagent-isolated";
const DEFAULT_TTL_DAYS = 7;
const JSONL_NEWLINE = "\n";

/**
 * Result of reading an isolated transcript.
 */
export type IsolatedTranscript = {
  /** Unique ID for this isolated transcript */
  id: string;
  /** Path to the isolated transcript file */
  path: string;
  /** Full content of the isolated transcript */
  content: string;
  /** When the transcript was created */
  createdAt: number;
  /** When the transcript was last accessed (if ever) */
  accessedAt?: number;
  /** Approximate token count (if available) */
  tokens?: number;
  /** Run ID that created this transcript */
  runId?: string;
  /** Child session key for the subagent */
  childSessionKey?: string;
};

/**
 * Metadata stored alongside isolated transcripts.
 */
export type IsolatedTranscriptMeta = {
  id: string;
  createdAt: number;
  accessedAt?: number;
  tokens?: number;
  runId?: string;
  childSessionKey?: string;
};

/**
 * Options for cleanup operation.
 */
export type CleanupIsolatedTranscriptsOptions = {
  /** TTL in days (default: 7) */
  ttlDays?: number;
  /** Agent directory containing isolated transcripts */
  agentDir: string;
  /** Dry run - don't actually delete files */
  dryRun?: boolean;
  /** Optional filter by runId */
  runId?: string;
};

/**
 * Result of cleanup operation.
 */
export type CleanupResult = {
  /** Number of files deleted */
  deletedCount: number;
  /** Number of files preserved (accessed or within TTL) */
  preservedCount: number;
  /** Number of errors encountered */
  errorCount: number;
  /** Total bytes freed */
  bytesFreed: number;
  /** List of deleted file paths */
  deletedPaths: string[];
};

/**
 * Generate a unique ID for an isolated transcript.
 */
export function generateIsolatedTranscriptId(): string {
  return crypto.randomUUID();
}

/**
 * Resolve the isolated transcript directory for an agent.
 *
 * @param agentDir - The agent's directory (e.g., `agents/<agentId>/agent/`)
 * @returns Full path to the isolated transcripts subdirectory
 */
export function resolveIsolatedTranscriptDir(agentDir: string): string {
  return path.join(agentDir, ISOLATED_SUBDIR_NAME);
}

/**
 * Resolve the path to an isolated transcript file.
 *
 * @param agentDir - The agent's directory
 * @param id - The isolated transcript ID
 * @returns Full path to the isolated transcript file
 */
export function resolveIsolatedTranscriptPath(agentDir: string, id: string): string {
  const dir = resolveIsolatedTranscriptDir(agentDir);
  return path.join(dir, `${id}.jsonl`);
}

/**
 * Write isolated subagent output to a sidechain file.
 *
 * Creates the isolated transcripts directory if it doesn't exist.
 * Writes the content as a single-line JSONL file with metadata header.
 *
 * @param params - Write parameters
 * @returns The isolated transcript ID and path
 */
export async function writeIsolatedTranscript(params: {
  agentDir: string;
  id: string;
  content: string;
  runId?: string;
  childSessionKey?: string;
  tokens?: number;
}): Promise<{ id: string; path: string }> {
  const { agentDir, id, content, runId, childSessionKey, tokens } = params;

  const dir = resolveIsolatedTranscriptDir(agentDir);
  const filePath = resolveIsolatedTranscriptPath(agentDir, id);
  const now = Date.now();

  // Ensure directory exists
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  // Build metadata header
  const meta: IsolatedTranscriptMeta = {
    id,
    createdAt: now,
    tokens,
    runId,
    childSessionKey,
  };

  // Write as JSONL: first line is metadata, second line is content
  // This allows easy parsing and future extensibility
  const jsonlContent =
    JSON.stringify({ meta }) + JSONL_NEWLINE + JSON.stringify({ content }) + JSONL_NEWLINE;

  await fs.writeFile(filePath, jsonlContent, { mode: 0o600 });

  logInfo(`isolated-transcript: wrote ${id} (${content.length} bytes) to ${filePath}`);

  return { id, path: filePath };
}

/**
 * Read an isolated transcript by ID.
 *
 * Parses the JSONL format to extract metadata and content.
 * Updates the `accessedAt` timestamp on first read.
 *
 * @param params - Read parameters
 * @returns The isolated transcript or null if not found
 */
export async function readIsolatedTranscript(params: {
  agentDir: string;
  id: string;
  updateAccessedAt?: boolean;
}): Promise<IsolatedTranscript | null> {
  const { agentDir, id, updateAccessedAt = true } = params;

  const filePath = resolveIsolatedTranscriptPath(agentDir, id);

  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const lines = raw.split(JSONL_NEWLINE).filter((line) => line.trim() !== "");

    const [metaRaw, contentRaw] = lines;
    if (metaRaw === undefined || contentRaw === undefined) {
      logWarn(`isolated-transcript: invalid format for ${id} (${lines.length} lines)`);
      return null;
    }

    // Parse metadata line
    const metaLine = JSON.parse(metaRaw);
    const meta: IsolatedTranscriptMeta = metaLine.meta;

    // Parse content line
    const contentLine = JSON.parse(contentRaw);
    const content: string = contentLine.content;

    const now = Date.now();

    // Update accessedAt on first read
    if (updateAccessedAt && !meta.accessedAt) {
      meta.accessedAt = now;

      // Rewrite file with updated metadata
      const updatedJsonl =
        JSON.stringify({ meta }) + JSONL_NEWLINE + JSON.stringify({ content }) + JSONL_NEWLINE;

      await fs.writeFile(filePath, updatedJsonl, { mode: 0o600 });
    }

    return {
      id,
      path: filePath,
      content,
      createdAt: meta.createdAt,
      accessedAt: meta.accessedAt,
      tokens: meta.tokens,
      runId: meta.runId,
      childSessionKey: meta.childSessionKey,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      logWarn(`isolated-transcript: not found ${id}`);
      return null;
    }
    logWarn(`isolated-transcript: error reading ${id}: ${error}`);
    throw error;
  }
}

/**
 * Cleanup old isolated transcripts.
 *
 * Removes isolated transcript files that:
 * - Have never been accessed (`accessedAt` is unset)
 * - Are older than the TTL
 *
 * Files that have been accessed are preserved regardless of age.
 *
 * @param params - Cleanup parameters
 * @returns Cleanup statistics
 */
export async function cleanupIsolatedTranscripts(
  params: CleanupIsolatedTranscriptsOptions,
): Promise<CleanupResult> {
  const { ttlDays = DEFAULT_TTL_DAYS, agentDir, dryRun = false, runId } = params;

  const dir = resolveIsolatedTranscriptDir(agentDir);
  const result: CleanupResult = {
    deletedCount: 0,
    preservedCount: 0,
    errorCount: 0,
    bytesFreed: 0,
    deletedPaths: [],
  };

  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const filePath = path.join(dir, entry.name);

      try {
        // Read metadata to check age and access status
        const raw = await fs.readFile(filePath, "utf-8");
        const lines = raw.split(JSONL_NEWLINE).filter((line) => line.trim() !== "");

        const metaRaw = lines.length >= 2 ? lines[0] : undefined;
        if (metaRaw === undefined) {
          // Invalid format, safe to delete
          if (!dryRun) {
            const stats = await fs.stat(filePath);
            await fs.unlink(filePath);
            result.deletedCount++;
            result.bytesFreed += stats.size;
            result.deletedPaths.push(filePath);
          }
          continue;
        }

        const metaLine = JSON.parse(metaRaw);
        const meta: IsolatedTranscriptMeta = metaLine.meta;

        // Filter by runId if specified
        if (runId && meta.runId !== runId) {
          result.preservedCount++;
          continue;
        }

        const age = now - meta.createdAt;

        // Skip if accessed (parent referenced the content)
        if (meta.accessedAt) {
          result.preservedCount++;
          continue;
        }

        // Delete if older than TTL
        if (age > ttlMs) {
          if (!dryRun) {
            const stats = await fs.stat(filePath);
            await fs.unlink(filePath);
            result.deletedCount++;
            result.bytesFreed += stats.size;
            result.deletedPaths.push(filePath);
            logInfo(
              `isolated-transcript: cleanup ${meta.id} (${Math.round(age / (24 * 60 * 60 * 1000))}d old)`,
            );
          } else {
            result.deletedCount++;
            result.deletedPaths.push(filePath);
          }
        } else {
          result.preservedCount++;
        }
      } catch (error) {
        result.errorCount++;
        logWarn(`isolated-transcript: error processing ${entry.name}: ${error}`);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Directory doesn't exist yet, nothing to cleanup
      return result;
    }
    throw error;
  }

  logInfo(
    `isolated-transcript: cleanup complete: ${result.deletedCount} deleted, ${result.preservedCount} preserved, ${result.errorCount} errors`,
  );

  return result;
}

/**
 * Check if an isolated transcript exists.
 *
 * @param params - Check parameters
 * @returns True if the transcript file exists
 */
export async function isolatedTranscriptExists(params: {
  agentDir: string;
  id: string;
}): Promise<boolean> {
  const { agentDir, id } = params;
  const filePath = resolveIsolatedTranscriptPath(agentDir, id);

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a specific isolated transcript.
 *
 * @param params - Delete parameters
 */
export async function deleteIsolatedTranscript(params: {
  agentDir: string;
  id: string;
}): Promise<void> {
  const { agentDir, id } = params;
  const filePath = resolveIsolatedTranscriptPath(agentDir, id);

  await fs.unlink(filePath);
  logInfo(`isolated-transcript: deleted ${id}`);
}

/**
 * Generate a reference token for an isolated transcript.
 *
 * @param id - The isolated transcript ID
 * @returns Reference token string
 */
export function isolatedTranscriptReferenceToken(id: string): string {
  return `[isolated:${id}]`;
}

/**
 * Parse an isolated transcript reference token.
 *
 * @param token - The reference token string
 * @returns The isolated transcript ID or null if not a valid token
 */
export function parseIsolatedTranscriptReferenceToken(token: string): string | null {
  const match = token.match(/^\[isolated:([a-f0-9-]+)\]$/);
  return match?.[1] ?? null;
}
