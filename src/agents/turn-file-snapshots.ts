/**
 * Per-turn file pre-image snapshots.
 *
 * Before a file-mutating tool (write/edit) runs, the target file's current
 * content is journaled into the per-agent SQLite cache. chat.branch can then
 * restore files to their state before a given transcript timestamp, letting a
 * message edit roll back code changes alongside the conversation.
 *
 * Exec-driven mutations (shell commands) are not captured — only direct
 * write/edit tool calls.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  listSqliteAgentCacheEntries,
  writeSqliteAgentCacheEntry,
} from "./cache/agent-cache-store.sqlite.js";

const log = createSubsystemLogger("agents/file-snapshots");

const SNAPSHOT_SCOPE_PREFIX = "turn-file-snapshots";
// Pre-images above this size are recorded without content and skipped on
// restore; journaling huge artifacts into the agent DB is not worth it.
const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024;
// Snapshots are rollback material for recent turns, not long-term history;
// the cache TTL keeps the agent DB from accumulating stale pre-images.
const SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FILE_MUTATION_TOOLS = new Set(["write", "edit"]);

// Same-millisecond captures need a tiebreaker so restore order is stable.
let snapshotSeq = 0;

type SnapshotMeta = {
  path: string;
  existed: boolean;
  capturedAtMs: number;
  runId?: string;
  /** True when the pre-image was too large to journal; restore skips it. */
  oversized?: boolean;
};

function snapshotScope(sessionId: string): string {
  return `${SNAPSHOT_SCOPE_PREFIX}:${sessionId}`;
}

function resolveToolFileMutationPath(params: unknown, cwd?: string): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  for (const candidate of [record.path, record.file_path, record.filePath]) {
    if (typeof candidate === "string" && candidate.trim()) {
      const trimmed = candidate.trim();
      return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd ?? process.cwd(), trimmed);
    }
  }
  return undefined;
}

/**
 * Journal the pre-image of a file a mutating tool is about to touch.
 * Synchronous and best-effort: it must finish before the tool runs (an async
 * read could race the write), and it must never block the tool on failure.
 */
export function captureToolFilePreImage(args: {
  toolName: string;
  params: unknown;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  if (!FILE_MUTATION_TOOLS.has(args.toolName) || !args.sessionId) {
    return;
  }
  const filePath = resolveToolFileMutationPath(args.params, args.cwd);
  if (!filePath) {
    return;
  }
  try {
    const capturedAtMs = Date.now();
    let existed = false;
    let oversized = false;
    let blob: Buffer | undefined;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return;
      }
      existed = true;
      if (stat.size > MAX_SNAPSHOT_FILE_BYTES) {
        oversized = true;
      } else {
        blob = fs.readFileSync(filePath);
      }
    } catch {
      // Missing file: journal "did not exist" so restore can delete it.
    }
    const meta: SnapshotMeta = {
      path: filePath,
      existed,
      capturedAtMs,
      ...(args.runId ? { runId: args.runId } : {}),
      ...(oversized ? { oversized: true } : {}),
    };
    const pathHash = crypto.createHash("sha256").update(filePath).digest("hex").slice(0, 12);
    snapshotSeq = (snapshotSeq + 1) % 1_000_000;
    const key = `${String(capturedAtMs).padStart(15, "0")}:${String(snapshotSeq).padStart(6, "0")}:${pathHash}`;
    writeSqliteAgentCacheEntry({
      ...(args.env ? { env: args.env } : {}),
      agentId: normalizeAgentId(args.agentId),
      scope: snapshotScope(args.sessionId),
      key,
      value: meta,
      ...(blob ? { blob } : {}),
      ttlMs: SNAPSHOT_TTL_MS,
    });
  } catch (err) {
    log.warn(`file pre-image capture failed for ${filePath}: ${String(err)}`);
  }
}

export type FileRestoreReport = {
  restored: string[];
  skipped: Array<{ path: string; reason: string }>;
};

/**
 * Restore every journaled file to its pre-image from just before cutoffMs.
 * For each path the earliest snapshot at/after the cutoff wins — that is the
 * state the file had before the rolled-back turns started mutating it.
 */
export function restoreFilesToTimestamp(args: {
  agentId?: string;
  sessionId: string;
  cutoffMs: number;
  env?: NodeJS.ProcessEnv;
}): FileRestoreReport {
  const report: FileRestoreReport = { restored: [], skipped: [] };
  const entries = listSqliteAgentCacheEntries({
    ...(args.env ? { env: args.env } : {}),
    agentId: normalizeAgentId(args.agentId),
    scope: snapshotScope(args.sessionId),
  });
  const earliestByPath = new Map<string, { meta: SnapshotMeta; blob?: Buffer }>();
  for (const entry of entries) {
    const meta = entry.value as SnapshotMeta | null;
    if (!meta || typeof meta.path !== "string" || meta.capturedAtMs < args.cutoffMs) {
      continue;
    }
    // Entries list in key order (capture order); keep the first per path.
    if (!earliestByPath.has(meta.path)) {
      earliestByPath.set(meta.path, { meta, blob: entry.blob ?? undefined });
    }
  }
  for (const { meta, blob } of earliestByPath.values()) {
    try {
      if (!meta.existed) {
        fs.rmSync(meta.path, { force: true });
        report.restored.push(meta.path);
        continue;
      }
      if (meta.oversized || !blob) {
        report.skipped.push({
          path: meta.path,
          reason: meta.oversized ? "pre-image too large" : "pre-image missing",
        });
        continue;
      }
      fs.mkdirSync(path.dirname(meta.path), { recursive: true });
      fs.writeFileSync(meta.path, blob);
      report.restored.push(meta.path);
    } catch (err) {
      report.skipped.push({ path: meta.path, reason: String(err) });
    }
  }
  return report;
}
