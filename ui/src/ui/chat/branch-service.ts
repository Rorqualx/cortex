/**
 * Branch service: manages session branching state, API calls,
 * and navigation between conversation branches.
 *
 * This couples the branch UI with the chat.branch / chat.branches
 * gateway RPC methods.
 */

import type { ChatItem } from "../types/chat-types.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface SessionBranchPoint {
  entryId: string;
  parentId: string | null;
  childCount: number;
  childIds: string[];
  isActive: boolean;
  isLeaf: boolean;
  label?: string;
  timestamp: string;
  type: string;
  /** The embedded message.id for matching branch points to displayed messages. */
  messageId?: string;
}

export interface BranchState {
  /** Branch points map: entryId → metadata */
  branches: Map<string, SessionBranchPoint>;
  /** Full branch tree from chat.branches */
  rawBranches: SessionBranchPoint[];
  /** The active leaf entry ID */
  activeLeafId: string | null;
  /** The active path (root → leaf entry IDs) */
  activePath: string[];
  /** Entry IDs that have branch children (for visual indicators) */
  branchPointIds: Set<string>;
  /** Whether we're currently branching (waiting for user to send) */
  isBranching: boolean;
  /** The entry ID we branched from */
  branchFromId: string | null;
  /** Loading / error state */
  loadError: string | null;
  /** Last fetch timestamp */
  lastFetchedAt: number;
}

export interface ChatBranchResult {
  ok: boolean;
  error?: string;
  branchFromId?: string;
  branchMarkerId?: string;
  newLeafId?: string;
}

export interface ChatBranchesResult {
  ok: boolean;
  error?: string;
  branches?: SessionBranchPoint[];
  activeLeafId?: string | null;
  activePath?: string[];
}

// ── Service ────────────────────────────────────────────────────────────

export function createBranchState(): BranchState {
  return {
    branches: new Map(),
    rawBranches: [],
    activeLeafId: null,
    activePath: [],
    branchPointIds: new Set(),
    isBranching: false,
    branchFromId: null,
    loadError: null,
    lastFetchedAt: 0,
  };
}

/**
 * Call chat.branches to get the session branch tree.
 */
export async function fetchBranches(
  sessionKey: string,
  gatewayRequest: (
    method: string,
    params: unknown,
  ) => Promise<{ ok?: boolean; error?: string } & Record<string, unknown>>,
  state: BranchState,
): Promise<void> {
  try {
    const result = (await gatewayRequest("chat.branches", { sessionKey })) as ChatBranchesResult;
    if (!result.ok || !result.branches) {
      state.loadError = result.error ?? "Failed to load branches";
      return;
    }

    state.rawBranches = result.branches;
    state.activeLeafId = result.activeLeafId ?? null;
    state.activePath = result.activePath ?? [];
    state.branches.clear();
    state.branchPointIds.clear();

    for (const branch of result.branches) {
      state.branches.set(branch.entryId, branch);
      if (branch.childCount > 1) {
        state.branchPointIds.add(branch.entryId);
      }
    }

    state.loadError = null;
    state.lastFetchedAt = Date.now();
  } catch (err) {
    state.loadError = String(err);
  }
}

/**
 * Call chat.branch to rewind the session to an entry.
 * Returns the branch marker ID on success.
 */
export async function branchFrom(
  sessionKey: string,
  entryId: string,
  gatewayRequest: (
    method: string,
    params: unknown,
  ) => Promise<{ ok?: boolean; error?: string } & Record<string, unknown>>,
  state: BranchState,
): Promise<ChatBranchResult> {
  try {
    const result = (await gatewayRequest("chat.branch", {
      sessionKey,
      entryId,
    })) as ChatBranchResult;

    if (!result.ok) {
      return { ok: false, error: result.error ?? "Failed to branch" };
    }

    state.isBranching = true;
    state.branchFromId = entryId;
    return {
      ok: true,
      branchFromId: entryId,
      branchMarkerId: result.branchMarkerId,
      newLeafId: result.newLeafId,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Reset branch state (called when user sends a message in branch mode).
 */
export function resetBranchState(state: BranchState): void {
  state.isBranching = false;
  state.branchFromId = null;
}

/**
 * Navigate to a different branch child.
 * Returns the target entry ID to branch from.
 */
export function navigateBranch(state: BranchState, direction: "prev" | "next"): string | null {
  const currentLeaf = state.activeLeafId;
  if (!currentLeaf) {
    return null;
  }

  // Find the branch point that contains the current leaf
  for (const [entryId, branch] of state.branches) {
    if (!branch.childIds.includes(currentLeaf) && !state.activePath.includes(entryId)) {
      continue;
    }
    const idx = branch.childIds.indexOf(currentLeaf);
    if (idx === -1) {
      // Check if any child is in the active path
      const activeChildIdx = branch.childIds.findIndex((id) => state.activePath.includes(id));
      if (activeChildIdx === -1) {
        continue;
      }
      const newIdx =
        direction === "next"
          ? (activeChildIdx + 1) % branch.childIds.length
          : (activeChildIdx - 1 + branch.childIds.length) % branch.childIds.length;
      return branch.childIds[newIdx]!;
    } else {
      const newIdx =
        direction === "next"
          ? (idx + 1) % branch.childIds.length
          : (idx - 1 + branch.childIds.length) % branch.childIds.length;
      return branch.childIds[newIdx]!;
    }
  }

  return null;
}

/**
 * Get the branch point metadata for a given entry ID.
 */
export function getBranchPoint(
  state: BranchState,
  entryId: string,
): SessionBranchPoint | undefined {
  return state.branches.get(entryId);
}

/**
 * Check if a message (by entry ID) is a branch point.
 */
export function isBranchPoint(state: BranchState, entryId: string): boolean {
  return state.branchPointIds.has(entryId);
}
