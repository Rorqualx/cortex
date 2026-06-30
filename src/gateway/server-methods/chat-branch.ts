/**
 * Gateway methods for session branching and rewind navigation.
 *
 * chat.branch  — Rewind the session leaf to an earlier entry so the next
 *                chat.send creates a new branch.
 * chat.branches — Return the session tree structure showing branch points,
 *                 child counts, and labels for UI navigation.
 */

import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { uuidv7 } from "../../agents/runtime/index.js";
import { loadEntriesFromFile, type SessionEntry } from "../../agents/sessions/session-manager.js";
import {
  restoreFilesToTimestamp,
  type FileRestoreReport,
} from "../../agents/turn-file-snapshots.js";
import { appendJsonlEntrySync } from "../../config/sessions/transcript-jsonl.js";
import {
  isSessionTranscriptLeafControl,
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
  type SessionTranscriptTree,
  type SessionTranscriptTreeNode,
} from "../../config/sessions/transcript-tree.js";
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
   * "select" resumes an existing sibling branch: it rewinds to that subtree's
   * deepest (most recent) leaf so the whole branch becomes visible again —
   * used by the branch navigator's prev/next arrows.
   */
  mode?: "at" | "before" | "select";
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
  /** Child entry IDs, in transcript (file) order — the order the navigator cycles. */
  childIds: string[];
  /**
   * The child entry on the currently active branch path, or null when this
   * branch point sits entirely inside an abandoned branch. The UI anchors the
   * divider before this child's first visible message and derives the counter
   * position from its index in childIds.
   */
  activeChildId: string | null;
  /** Whether this branch point is on the currently active branch (leaf path). */
  isActive: boolean;
  /** Whether this is the current branch leaf. */
  isLeaf: boolean;
  /** User-assigned label if any. */
  label?: string;
  /** ISO timestamp of the entry. */
  timestamp: string;
  /** The entry type (message, custom, etc.). */
  type: string;
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
  if (p.mode !== undefined && p.mode !== "at" && p.mode !== "before" && p.mode !== "select") {
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

const ROOT_PARENT_KEY = "__root__";

type BranchTreeNode = SessionTranscriptTreeNode<SessionEntry>;

function entryFieldString(node: BranchTreeNode | undefined, field: string): string | undefined {
  const value = (node?.entry as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * Group canonical entries by their normalized parent id, the same ancestry
 * chat.history renders. Leaf controls are navigation markers, not real branch
 * children, so they never count toward a branch point's fan-out.
 */
function groupCanonicalChildren(
  tree: SessionTranscriptTree<SessionEntry>,
): Map<string, BranchTreeNode[]> {
  const children = new Map<string, BranchTreeNode[]>();
  for (const node of tree.nodes) {
    if (isSessionTranscriptLeafControl(node.entry)) {
      continue;
    }
    const key = node.parentId ?? ROOT_PARENT_KEY;
    const siblings = children.get(key);
    if (siblings) {
      siblings.push(node);
    } else {
      children.set(key, [node]);
    }
  }
  return children;
}

/**
 * Resolve the most recently appended entry in a subtree — the tip to resume
 * when re-selecting an existing sibling branch. Falls back to the entry itself
 * when it has no descendants. Marker-based navigation/edit appends are linear,
 * so the highest-index descendant is that sibling's live tip; a leaf control
 * nested inside the subtree (rare) is not honored here, only on the file-level
 * active path in resolveBranchPoints.
 */
function resolveDeepestLeafId(entries: SessionEntry[], entryId: string): string {
  const tree = scanSessionTranscriptTree<SessionEntry>(entries);
  const children = groupCanonicalChildren(tree);
  let bestId = entryId;
  let bestIndex = tree.byId.get(entryId)?.index ?? -1;
  const stack: string[] = [entryId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const node = tree.byId.get(current);
    if (node && node.index > bestIndex) {
      bestIndex = node.index;
      bestId = current;
    }
    for (const child of children.get(current) ?? []) {
      stack.push(child.id);
    }
  }
  return bestId;
}

/**
 * Find every branch point (a node with >1 canonical child) using the same
 * leaf-controlled tree chat.history renders, so branch metadata and displayed
 * messages always agree on which entries are active.
 */
function resolveBranchPoints(entries: SessionEntry[]): {
  branches: SessionBranchPoint[];
  activePath: string[];
  activeLeafId: string | null;
} {
  const tree = scanSessionTranscriptTree<SessionEntry>(entries);
  const activePath = selectSessionTranscriptTreePathNodes(tree, tree.leafId).map((node) => node.id);
  const activePathSet = new Set(activePath);
  const children = groupCanonicalChildren(tree);

  const branches: SessionBranchPoint[] = [];
  for (const [parentKey, childNodes] of children) {
    if (childNodes.length <= 1) {
      continue;
    }
    const isRoot = parentKey === ROOT_PARENT_KEY;
    const parentNode = isRoot ? undefined : tree.byId.get(parentKey);
    const ordered = [...childNodes].sort((a, b) => a.index - b.index);
    const childIds = ordered.map((node) => node.id);
    const activeChildId = childIds.find((id) => activePathSet.has(id)) ?? null;

    branches.push({
      entryId: isRoot ? ROOT_PARENT_KEY : parentKey,
      parentId: parentNode?.parentId ?? null,
      childCount: childIds.length,
      childIds,
      activeChildId,
      isActive: activeChildId !== null,
      isLeaf: !isRoot && parentKey === tree.leafId,
      label: undefined, // labels are loaded separately via SessionManager
      timestamp:
        entryFieldString(parentNode, "timestamp") ??
        entryFieldString(ordered[0], "timestamp") ??
        new Date(0).toISOString(),
      type: entryFieldString(parentNode, "type") ?? "message",
    });
  }

  // Sort by timestamp so oldest branch points come first
  branches.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    branches,
    activePath,
    activeLeafId: tree.leafId,
  };
}

// ── Handlers ───────────────────────────────────────────────────────────────

async function handleChatBranchRequest(opts: GatewayRequestHandlerOptions): Promise<void> {
  const { params, respond } = opts;

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
      (e): e is SessionEntry => e.type !== "session",
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
  // (and everything after it) moves to the abandoned branch. "select" resumes
  // an existing sibling by parenting onto that subtree's deepest leaf, so the
  // navigator surfaces the whole branch instead of starting an empty one.
  const branchBaseId =
    mode === "before"
      ? (targetEntry.parentId ?? null)
      : mode === "select"
        ? resolveDeepestLeafId(entries, resolvedEntryId)
        : resolvedEntryId;

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
      (e): e is SessionEntry => e.type !== "session",
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
