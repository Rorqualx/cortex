import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayMethodHandler } from "../gateway/methods/descriptor.js";
/**
 * Workboard API — bridge from store to core gateway method registry.
 *
 * Called by the core gateway server startup to register workboard RPC methods
 * alongside other core methods. Replaces the plugin's registerGatewayMethod path.
 */
import { resolveResearchReportsDir, runResearchIngest } from "./research-ingest.js";
import { WorkboardStore } from "./store.js";

export { WorkboardStore } from "./store.js";

const REPORT_FILE_NAME = /^[a-zA-Z0-9._-]+\.md$/;
const REPORT_NAME_PARTS = /^([a-z-]+?)-(\d{4}-\d{2}-\d{2})\.md$/;

/** List the markdown reports in the research reports dir for the Reports browser. */
async function listResearchReports(reportsDir: string) {
  let dirents: Dirent[];
  try {
    dirents = await fs.readdir(reportsDir, { withFileTypes: true });
  } catch {
    return { reportsDir, reports: [] as Array<Record<string, unknown>> };
  }
  const reports = await Promise.all(
    dirents
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map(async (e) => {
        const stat = await fs.stat(path.join(reportsDir, e.name)).catch(() => null);
        const parts = e.name.match(REPORT_NAME_PARTS);
        return {
          name: e.name,
          kind: parts?.[1] ?? "other",
          date: parts?.[2] ?? null,
          size: stat?.size ?? 0,
        };
      }),
  );
  // Newest first; the browser groups by date/kind.
  reports.sort((a, b) => b.name.localeCompare(a.name));
  return { reportsDir, reports };
}

/** Read one report's raw markdown, guarding against path traversal. */
async function readResearchReport(reportsDir: string, name: string) {
  if (!REPORT_FILE_NAME.test(name)) {
    throw Object.assign(new Error("invalid report name"), { code: "workboard_error" });
  }
  const content = await fs.readFile(path.join(reportsDir, name), "utf-8").catch(() => null);
  if (content === null) {
    throw Object.assign(new Error("report not found"), { code: "workboard_error" });
  }
  return { name, content };
}

function readId(p: Record<string, unknown>) {
  const v = p.id;
  if (typeof v === "string" && v.trim()) {
    return v.trim();
  }
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

// specify/decompose mutate claimed cards; a caller that holds the claim passes
// its ownerId/token so assertCanMutateClaimedCard authorizes it. Absent both,
// scope is undefined (trusted/unclaimed-card path).
function mutationScope(
  p: Record<string, unknown>,
): { ownerId?: string; token?: string } | undefined {
  const ownerId = typeof p.ownerId === "string" && p.ownerId.trim() ? p.ownerId.trim() : undefined;
  const token =
    typeof p.claimToken === "string" && p.claimToken.trim()
      ? p.claimToken.trim()
      : typeof p.token === "string" && p.token.trim()
        ? p.token.trim()
        : undefined;
  return ownerId || token
    ? { ...(ownerId ? { ownerId } : {}), ...(token ? { token } : {}) }
    : undefined;
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
      if (!card) {
        throw Object.assign(new Error("card not found"), { code: "workboard_error" });
      }
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.update": async (p: Record<string, unknown>) => {
      const card = await s.update(readId(p), p as Parameters<typeof s.update>[1]);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    // Drag/column move: set status + position. Delegates to store.move, which
    // reuses update so reordering serializes through the same mutation queue.
    "workboard.cards.move": async (p: Record<string, unknown>) => {
      const card = await s.move(readId(p), p.status, p.position);
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.delete": async (p: Record<string, unknown>) => {
      await s.delete(readId(p));
      return true;
    },

    "workboard.cards.specify": async (p: Record<string, unknown>) => {
      const card = await s.specify(
        readId(p),
        p as Parameters<typeof s.specify>[1],
        mutationScope(p),
      );
      return { card: redactToken(card as unknown as Record<string, unknown>) };
    },

    "workboard.cards.decompose": async (p: Record<string, unknown>) => {
      const result = await s.decompose(
        readId(p),
        p as Parameters<typeof s.decompose>[1],
        mutationScope(p),
      );
      return {
        parent: redactToken(result.parent as unknown as Record<string, unknown>),
        children: result.children.map((child) =>
          redactToken(child as unknown as Record<string, unknown>),
        ),
      };
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

    // Research lab: ingest the daily-research reports into the dedicated board.
    "workboard.research.sync": async (p: Record<string, unknown>) => {
      const reportsDir =
        typeof p.reportsDir === "string" && p.reportsDir.trim()
          ? p.reportsDir.trim()
          : resolveResearchReportsDir();
      const defaultAssignee =
        typeof p.defaultAssignee === "string" && p.defaultAssignee.trim()
          ? p.defaultAssignee.trim()
          : undefined;
      return runResearchIngest({ store: s, reportsDir, defaultAssignee });
    },

    // Research lab: list + read the raw report markdown for the Reports browser.
    "workboard.research.reports": async (p: Record<string, unknown>) => {
      const reportsDir =
        typeof p.reportsDir === "string" && p.reportsDir.trim()
          ? p.reportsDir.trim()
          : resolveResearchReportsDir();
      const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : undefined;
      return name ? readResearchReport(reportsDir, name) : listResearchReports(reportsDir);
    },
  };
}
