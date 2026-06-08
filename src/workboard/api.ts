import type { GatewayMethodHandler } from "../../gateway/methods/descriptor.js";
/**
 * Workboard API — bridge from store to core gateway method registry.
 *
 * Called by the core gateway server startup to register workboard RPC methods
 * alongside other core methods. Replaces the plugin's registerGatewayMethod path.
 */
import { WorkboardStore } from "./store.js";

export { WorkboardStore } from "./store.js";

function readId(p: Record<string, unknown>) {
  const v = p.id;
  if (typeof v === "string" && v.trim()) return v.trim();
  throw Object.assign(new Error("missing parameter: id"), { code: "workboard_error" });
}

function redactToken<T extends Record<string, unknown>>(obj: T): T {
  const meta = obj.metadata as Record<string, unknown> | undefined;
  const claim = meta?.claim as Record<string, unknown> | undefined;
  if (claim?.token) {
    return { ...obj, metadata: { ...meta, claim: { ...claim, token: undefined } } };
  }
  return obj;
}

export function createWorkboardGatewayHandlers(
  store: WorkboardStore,
): Record<string, GatewayMethodHandler> {
  const s = store;

  return {
    "workboard.cards.list": async (p: Record<string, unknown>) => {
      const cards = await s.list({ boardId: p.boardId as string | undefined });
      return { cards: cards.map(redactToken), statuses: [...new Set(cards.map((c) => c.status))] };
    },

    "workboard.cards.create": async (p: Record<string, unknown>) => {
      const card = await s.create(p);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.read": async (p: Record<string, unknown>) => {
      const card = await s.get(readId(p));
      if (!card) throw Object.assign(new Error("card not found"), { code: "workboard_error" });
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.update": async (p: Record<string, unknown>) => {
      const card = await s.update(readId(p), p as Parameters<typeof s.update>[1]);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.delete": async (p: Record<string, unknown>) => {
      await s.delete(readId(p));
      return true;
    },

    "workboard.cards.claim": async (p: Record<string, unknown>) => {
      const result = await s.claim(readId(p), p as Parameters<typeof s.claim>[1]);
      return {
        card: redactToken(result.card as unknown as Record<string, unknown>),
        token: result.token,
      };
    },

    "workboard.cards.release": async (p: Record<string, unknown>) => {
      const card = await s.releaseClaim(readId(p), p as Parameters<typeof s.releaseClaim>[1]);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.heartbeat": async (p: Record<string, unknown>) => {
      const card = await s.heartbeat(readId(p), p as Parameters<typeof s.heartbeat>[1]);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.complete": async (p: Record<string, unknown>) => {
      const card = await s.complete(readId(p), p as Parameters<typeof s.complete>[1]);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.block": async (p: Record<string, unknown>) => {
      const card = await s.block(readId(p), p as Parameters<typeof s.block>[1]);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.unblock": async (p: Record<string, unknown>) => {
      const card = await s.unblock(readId(p));
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.promote": async (p: Record<string, unknown>) => {
      const card = await s.promote(readId(p));
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.reassign": async (p: Record<string, unknown>) => {
      const card = await s.reassign(readId(p), p as Parameters<typeof s.reassign>[1]);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.reclaim": async (p: Record<string, unknown>) => {
      const card = await s.reclaim(readId(p));
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.dispatch": async () => {
      return s.dispatch(Date.now());
    },

    "workboard.cards.stats": async () => {
      return s.stats();
    },

    "workboard.cards.runs": async (p: Record<string, unknown>) => {
      return s.runs(readId(p));
    },

    "workboard.boards.list": async () => {
      return s.listBoards();
    },

    "workboard.boards.create": async (p: Record<string, unknown>) => {
      return s.upsertBoard(p as Parameters<typeof s.upsertBoard>[0]);
    },

    "workboard.boards.archive": async (p: Record<string, unknown>) => {
      return s.archiveBoard(readId(p));
    },

    "workboard.boards.delete": async (p: Record<string, unknown>) => {
      return s.deleteBoard(readId(p));
    },
  };
}
