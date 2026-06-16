/**
 * Layer 3 — Chain-of-custody tracking for agent delegation.
 *
 * Tracks the full delegation chain when agents spawn sub-agents or call
 * external models. Each link records the receipt, parent, tools invoked,
 * model overrides, and duration.
 *
 * The chain is maintained per-session and can be exported for audit.
 */
import type { CustodyChain, CustodyChainLink } from "./types.js";

/**
 * Create a new empty custody chain for a session.
 */
export function createChain(sessionId: string): CustodyChain {
  return { sessionId, links: [] };
}

/**
 * Append a link to a custody chain.
 *
 * @param chain - The chain to append to.
 * @param link - The link to add.
 * @returns The updated chain (mutated in place for efficiency).
 */
export function appendLink(chain: CustodyChain, link: CustodyChainLink): CustodyChain {
  chain.links.push(link);
  return chain;
}

/**
 * Create a new custody chain link.
 *
 * @param params - Link fields.
 * @returns A CustodyChainLink.
 */
export function createLink(params: {
  receiptId: string;
  parentReceiptId: string | null;
  agentId: string;
  toolCalls?: string[];
  modelOverrides?: string[];
  durationMs: number;
}): CustodyChainLink {
  return {
    receiptId: params.receiptId,
    parentReceiptId: params.parentReceiptId,
    agentId: params.agentId,
    toolCalls: params.toolCalls ?? [],
    modelOverrides: params.modelOverrides ?? [],
    durationMs: params.durationMs,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Find the root link (parentReceiptId === null) of a chain.
 */
export function findRoot(chain: CustodyChain): CustodyChainLink | undefined {
  return chain.links.find((link) => link.parentReceiptId === null);
}

/**
 * Get all links for a given receipt ID (usually 1, but defensive).
 */
export function findLinksByReceipt(chain: CustodyChain, receiptId: string): CustodyChainLink[] {
  return chain.links.filter((link) => link.receiptId === receiptId);
}

/**
 * Get the immediate children of a given receipt.
 */
export function findChildren(chain: CustodyChain, receiptId: string): CustodyChainLink[] {
  return chain.links.filter((link) => link.parentReceiptId === receiptId);
}

/**
 * Verify the chain integrity — every non-root link's parentReceiptId
 * must reference an existing receiptId in the chain.
 *
 * Returns `{ valid: true }` or `{ valid: false, brokenAt: link }`.
 */
export function verifyChain(
  chain: CustodyChain,
): { valid: true } | { valid: false; brokenAt: CustodyChainLink } {
  const receiptIds = new Set(chain.links.map((l) => l.receiptId));
  for (const link of chain.links) {
    if (link.parentReceiptId !== null && !receiptIds.has(link.parentReceiptId)) {
      return { valid: false, brokenAt: link };
    }
  }
  return { valid: true };
}

/**
 * Serialize a custody chain to JSON.
 */
export function serializeChain(chain: CustodyChain): string {
  return JSON.stringify(chain, null, 2);
}

/**
 * Parse a custody chain from JSON.
 * Throws on invalid JSON or missing required fields.
 */
export function parseChain(json: string): CustodyChain {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (typeof parsed.sessionId !== "string") {
    throw new Error("Invalid chain: missing sessionId");
  }
  if (!Array.isArray(parsed.links)) {
    throw new Error("Invalid chain: missing links array");
  }
  for (const link of parsed.links as Record<string, unknown>[]) {
    if (typeof link.receiptId !== "string") {
      throw new Error("Invalid chain link: missing receiptId");
    }
    if (link.parentReceiptId !== null && typeof link.parentReceiptId !== "string") {
      throw new Error("Invalid chain link: parentReceiptId must be string or null");
    }
    if (typeof link.agentId !== "string") {
      throw new Error("Invalid chain link: missing agentId");
    }
  }
  return parsed as unknown as CustodyChain;
}

/**
 * Compute the total wall-clock duration of a chain (sum of all link durations).
 */
export function totalChainDuration(chain: CustodyChain): number {
  return chain.links.reduce((sum, link) => sum + link.durationMs, 0);
}

/**
 * Get the depth of the chain (length of longest parent → child path).
 */
export function chainDepth(chain: CustodyChain): number {
  if (chain.links.length === 0) {
    return 0;
  }
  const childMap = new Map<string, CustodyChainLink[]>();
  for (const link of chain.links) {
    if (link.parentReceiptId !== null) {
      const children = childMap.get(link.parentReceiptId) ?? [];
      children.push(link);
      childMap.set(link.parentReceiptId, children);
    }
  }
  function depthFrom(receiptId: string): number {
    const children = childMap.get(receiptId) ?? [];
    if (children.length === 0) {
      return 1;
    }
    return 1 + Math.max(...children.map((c) => depthFrom(c.receiptId)));
  }
  const roots = chain.links.filter((l) => l.parentReceiptId === null);
  if (roots.length === 0) {
    return chain.links.length;
  } // No root — return link count as fallback.
  return Math.max(...roots.map((r) => depthFrom(r.receiptId)));
}
