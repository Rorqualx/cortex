/**
 * Gateway methods for session branching and rewind navigation.
 *
 * chat.branch  — Rewind the session leaf to an earlier entry so the next
 *                chat.send creates a new branch.
 * chat.branches — Return the session tree structure showing branch points,
 *                 child counts, and labels for UI navigation.
 */

import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
} from "../../../packages/gateway-protocol/src/index.js";
import { uuidv7 } from "../../agents/runtime/index.js";
import {
  loadEntriesFromFile,
  type FileEntry,
  type SessionEntry,
} from "../../agents/sessions/session-manager.js";
import {
  restoreFilesToTimestamp,
  type FileRestoreReport,
} from "../../agents/turn-file-snapshots.js";
import { appendJsonlEntrySync } from "../../config/sessions/transcript-jsonl.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { loadSessionEntry } from "../session-utils.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ChatBranchParams {
  sessionKey: string;
  /** Entry ID (tree node ID) to branch from. */
  entryId?: string;
  /** LLM message ID — gateway resolves this to the entry ID. */
  messageId?: string;
  /**
   * "at" (default) rewinds so the next send follows the target entry.
   * "before" rewinds to the target's parent so the target itself moves to the
   * abandoned branch — used by message editing to replace, not duplicate.
   */
  mode?: "at" | "before";
  /**
   * Also restore journaled file pre-images captured at/after the target
   * message, rolling back code changes made by the abandoned turns.
   */
  restoreFiles?: boolean;
  agentId?: string;
}

export interface ChatBranchesParams {
  sessionKey: string;
  agentId?: string;
}

/** A branch point in the session tree — one entry with multiple children. */
export interface SessionBranchPoint {
  /** The entry that was branched from. */
  entryId: string;
  /** The entry's parent. */
  parentId: string | null;
  /** Number of child branches. */
  childCount: number;
  /** Child entry IDs. */
  childIds: string[];
  /** Whether this entry is on the currently active branch (leaf path). */
  isActive: boolean;
  /** Whether this is the current branch leaf. */
  isLeaf: boolean;
  /** User-assigned label if any. */
  label?: string;
  /** ISO timestamp of the entry. */
  timestamp: string;
  /** The entry type (message, custom, etc.). */
  type: string;
  /** The embedded message.id for matching branch points to displayed messages. */
  messageId?: string;
}

export interface ChatBranchResult {
  ok: true;
  /** Null when mode "before" rewinds past a root entry. */
  branchFromId: string | null;
  branchMarkerId: string;
  /** The new active leaf (the branch marker). */
  newLeafId: string;
  /** Present when restoreFiles was requested. */
  filesRestored?: string[];
  filesSkipped?: Array<{ path: string; reason: string }>;
}

export interface ChatBranchesResult {
  ok: true;
  activeLeafId: string | null;
  branches: SessionBranchPoint[];
  /** The full path from root to active leaf (entry IDs in order). */
  activePath: string[];
}

// ── Parameter validation ───────────────────────────────────────────────────

const MIN_SESSION_KEY_LENGTH = 1;
const MIN_ENTRY_ID_LENGTH = 1;

function validateChatBranchParams(params: unknown): params is ChatBranchParams {
  if (!params || typeof params !== "object") {
    return false;
  }
  const p = params as Record<string, unknown>;
  if (typeof p.sessionKey !== "string" || p.sessionKey.length < MIN_SESSION_KEY_LENGTH) {
    return false;
  }
  if (typeof p.entryId !== "string" && typeof p.messageId !== "string") {
    return false;
  }
  if (p.agentId !== undefined && typeof p.agentId !== "string") {
    return false;
  }
  if (p.mode !== undefined && p.mode !== "at" && p.mode !== "before") {
    return false;
  }
  if (p.restoreFiles !== undefined && typeof p.restoreFiles !== "boolean") {
    return false;
  }
  return true;
}

function validateChatBranchesParams(params: unknown): params is ChatBranchesParams {
  if (!params || typeof params !== "object") {
    return false;
  }
  const p = params as Record<string, unknown>;
  if (typeof p.sessionKey !== "string" || p.sessionKey.length < MIN_SESSION_KEY_LENGTH) {
    return false;
  }
  if (p.agentId !== undefined && typeof p.agentId !== "string") {
    return false;
  }
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Find the active branch path (root → current leaf) by walking parent
 * pointers from the last entry.
 */
function resolveActivePath(entries: SessionEntry[]): string[] {
  const byId = new Map<string, SessionEntry>();
  let leafId: string | null = null;

  for (const entry of entries) {
    byId.set(entry.id, entry);
    leafId = entry.id; // last entry wins
  }

  const path: string[] = [];
  let current = leafId ? byId.get(leafId) : undefined;
  while (current) {
    path.unshift(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return path;
}

/**
 * Walk the session entries and find all branch points (entries with >1 child).
 */
function resolveBranchPoints(entries: SessionEntry[]): {
  branches: SessionBranchPoint[];
  activePath: string[];
  activeLeafId: string | null;
} {
  const byId = new Map<string, SessionEntry>();
  const children = new Map<string, SessionEntry[]>();
  let leafId: string | null = null;

  for (const entry of entries) {
    byId.set(entry.id, entry);
    leafId = entry.id;

    const parentKey = entry.parentId ?? "__root__";
    const siblings = children.get(parentKey) ?? [];
    siblings.push(entry);
    children.set(parentKey, siblings);
  }

  const activePath = new Set(resolveActivePath(entries));

  const branches: SessionBranchPoint[] = [];
  for (const [parentKey, childEntries] of children) {
    if (childEntries.length <= 1) {
      continue;
    }
    // parentKey === "__root__" means root entries (parentId === null)
    const isRoot = parentKey === "__root__";
    const branchFromId = isRoot ? childEntries[0]!.id : parentKey;
    const branchEntry = isRoot ? null : byId.get(parentKey);

    // Extract messageId from the entry identified by branchFromId
    let messageId: string | undefined;
    const branchFromEntry = byId.get(branchFromId);
    if (branchFromEntry?.type === "message") {
      const msg = (branchFromEntry as { message?: { id?: string } }).message;
      messageId = msg?.id;
    }

    branches.push({
      entryId: branchFromId,
      parentId: branchEntry?.parentId ?? null,
      childCount: childEntries.length,
      childIds: childEntries.map((c) => c.id),
      isActive: activePath.has(branchFromId),
      isLeaf: branchFromId === leafId,
      label: undefined, // labels are loaded separately via SessionManager
      timestamp: branchEntry?.timestamp ?? childEntries[0]!.timestamp,
      type: branchEntry?.type ?? "message",
      messageId,
    });
  }

  // Sort by timestamp so oldest branch points come first
  branches.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    branches,
    activePath: [...activePath],
    activeLeafId: leafId,
  };
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleChatBranchRequest(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond, context } = opts;

  if (!validateChatBranchParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid chat.branch params: { sessionKey: string, entryId: string, agentId?: string }`,
      ),
    );
    return;
  }

  const {
    sessionKey,
    entryId: rawEntryId,
    messageId,
    mode,
    restoreFiles,
    agentId,
  } = params as ChatBranchParams;
  const agentIdOverride = typeof agentId === "string" ? agentId : undefined;

  const { entry } = loadSessionEntry(sessionKey, { agentId: agentIdOverride });
  const sessionFile = entry?.sessionFile;
  if (!sessionFile) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found"));
    return;
  }

  // Read existing entries
  let entries: SessionEntry[];
  try {
    entries = loadEntriesFromFile(sessionFile).filter(
      (e): e is SessionEntry => (e as FileEntry).type !== "session",
    );
  } catch {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Failed to read session file"),
    );
    return;
  }

  // Resolve entryId — either directly or from messageId
  let resolvedEntryId: string | undefined = typeof rawEntryId === "string" ? rawEntryId : undefined;
  if (!resolvedEntryId && typeof messageId === "string") {
    // Search entries for a message entry whose embedded message.id matches
    for (const e of entries) {
      if (e.type === "message") {
        const msg = (e as { message?: { id?: string } }).message;
        if (msg?.id === messageId) {
          resolvedEntryId = e.id;
          break;
        }
      }
    }
    if (!resolvedEntryId) {
      // Fallback: find the last entry and branch from there
      const lastMsg = entries.filter((e) => e.type === "message").pop();
      if (lastMsg) {
        resolvedEntryId = lastMsg.id;
      }
    }
  }

  if (!resolvedEntryId) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Could not resolve entry to branch from"),
    );
    return;
  }

  const targetEntry = entries.find((e) => e.id === resolvedEntryId);
  if (!targetEntry) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Entry ${resolvedEntryId} not found in session`),
    );
    return;
  }

  // "before" parents the marker on the target's parent, so the target entry
  // (and everything after it) moves to the abandoned branch.
  const branchBaseId = mode === "before" ? (targetEntry.parentId ?? null) : resolvedEntryId;

  // Create a branch marker entry that becomes the new leaf.
  // When the next chat.send runs, the SessionManager will load from the file,
  // see this marker as the last entry (leaf), and the replay history will
  // resolve from this branch point.
  const markerId = uuidv7();
  const branchMarker = {
    type: "custom" as const,
    customType: "branch_marker",
    id: markerId,
    parentId: branchBaseId,
    timestamp: new Date().toISOString(),
    branchFromId: branchBaseId,
  };

  try {
    appendJsonlEntrySync(sessionFile, branchMarker);
  } catch (err) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `Failed to write branch marker: ${String(err)}`),
    );
    return;
  }

  // Roll back journaled file pre-images captured at/after the target message
  // so the abandoned turns' code changes are undone with the conversation.
  let restoreReport: FileRestoreReport | undefined;
  if (restoreFiles && entry?.sessionId) {
    const cutoffMs = Date.parse(targetEntry.timestamp);
    if (Number.isFinite(cutoffMs)) {
      restoreReport = restoreFilesToTimestamp({
        agentId: agentIdOverride ?? resolveAgentIdFromSessionKey(sessionKey),
        sessionId: entry.sessionId,
        cutoffMs,
      });
    }
  }

  respond(true, {
    ok: true,
    branchFromId: branchBaseId,
    branchMarkerId: markerId,
    newLeafId: markerId,
    ...(restoreReport
      ? { filesRestored: restoreReport.restored, filesSkipped: restoreReport.skipped }
      : {}),
  } satisfies ChatBranchResult);
}

async function handleChatBranchesRequest(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond } = opts;

  if (!validateChatBranchesParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid chat.branches params: { sessionKey: string, agentId?: string }`,
      ),
    );
    return;
  }

  const { sessionKey, agentId } = params as ChatBranchesParams;
  const agentIdOverride = typeof agentId === "string" ? agentId : undefined;

  const { entry } = loadSessionEntry(sessionKey, { agentId: agentIdOverride });
  const sessionFile = entry?.sessionFile;
  if (!sessionFile) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Session not found"));
    return;
  }

  let entries: SessionEntry[];
  try {
    entries = loadEntriesFromFile(sessionFile).filter(
      (e): e is SessionEntry => (e as FileEntry).type !== "session",
    );
  } catch {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "Failed to read session file"),
    );
    return;
  }

  const { branches, activePath, activeLeafId } = resolveBranchPoints(entries);

  respond(true, {
    ok: true,
    activeLeafId,
    branches,
    activePath,
  } satisfies ChatBranchesResult);
}

// ── Exports ────────────────────────────────────────────────────────────────

export const chatBranchHandlers: GatewayRequestHandlers = {
  "chat.branch": async (opts) => {
    await handleChatBranchRequest(opts);
  },
  "chat.branches": async (opts) => {
    await handleChatBranchesRequest(opts);
  },
};
