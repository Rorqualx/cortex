import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayMethodHandler } from "../gateway/methods/descriptor.js";
import { DEFAULT_PROBE_PROMOTION_THRESHOLD, evaluateProbeGate } from "./probe-gate.js";
/**
 * Workboard API — bridge from store to core gateway method registry.
 *
 * Called by the core gateway server startup to register workboard RPC methods
 * alongside other core methods. Replaces the plugin's registerGatewayMethod path.
 */
import { resolveResearchReportsDir, runResearchIngest } from "./research-ingest.js";
import { WorkboardStore } from "./store.js";
import { WORKBOARD_RESEARCH_STAGES, type WorkboardResearchStage } from "./types.js";

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

    // Deep pipeline: advance an architecture/long-horizon card one lifecycle stage.
    // Appends to stageLog and, at `implement`, flips the card to `ready` so the
    // 06:00 Implementation cron lands it like a quick-win. Single-writer (the Deep
    // Pipeline cron works one stage per card), so the get→update is not contended.
    "workboard.research.stage": async (p: Record<string, unknown>) => {
      const id = readId(p);
      const stage = p.stage as WorkboardResearchStage;
      if (!WORKBOARD_RESEARCH_STAGES.includes(stage)) {
        throw Object.assign(new Error(`invalid research stage: ${String(p.stage)}`), {
          code: "workboard_error",
        });
      }
      const card = await s.get(id);
      if (!card) {
        throw Object.assign(new Error("card not found"), { code: "workboard_error" });
      }
      const research = card.metadata?.research;
      if (!research) {
        throw Object.assign(new Error("card has no research metadata"), {
          code: "workboard_error",
        });
      }
      // Only architecture/long-horizon cards run the deep pipeline. Guarding here
      // stops a stray call from giving a quick-win/finding a stage — which would
      // make it pipelineActive and freeze its re-sync updates (see research-ingest).
      if (research.category !== "architecture" && research.category !== "long-horizon") {
        throw Object.assign(
          new Error("research stage pipeline is only for architecture/long-horizon cards"),
          { code: "workboard_error" },
        );
      }
      // One step at a time: allow the next stage or a backward step (probe/review
      // can send a card back to design), but never skip forward past the next stage
      // — that would let a card jump straight to implement→ready unvetted.
      const currentIdx = research.stage ? WORKBOARD_RESEARCH_STAGES.indexOf(research.stage) : -1;
      if (WORKBOARD_RESEARCH_STAGES.indexOf(stage) > currentIdx + 1) {
        throw Object.assign(
          new Error(`cannot skip stages: ${research.stage ?? "(none)"} -> ${stage}`),
          { code: "workboard_error" },
        );
      }
      // A done/blocked card is out of the pipeline; a stray/retried call must not
      // rewrite its stage (stale badge) or re-land it. Reject rather than mutate.
      if (card.status === "done" || card.status === "blocked") {
        throw Object.assign(new Error(`card is ${card.status}; deep pipeline is complete`), {
          code: "workboard_error",
        });
      }
      // Same-stage call is an idempotent no-op — return as-is without appending a
      // duplicate transition (the log is a bounded resume aid, not an event stream).
      if (stage === research.stage) {
        return { card: redactToken(card as unknown as Record<string, unknown>) };
      }

      // -----------------------------------------------------------------
      // Checkpoint-preservation gate (RSIBench-Data, arXiv:2607.25886)
      // -----------------------------------------------------------------
      // When advancing from `probe` → `test`, check if the probe result beat
      // the baseline by at least the promotion threshold. If not, automatically
      // walk the card back to `design` instead of advancing. 78% of continued
      // searches after a non-improving checkpoint regress — this gate prevents
      // that waste. Only fires when both probeBaseline and probeResult are set;
      // without them, normal advancement proceeds.
      if (
        research.stage === "probe" &&
        stage === "test" &&
        research.probeBaseline !== undefined &&
        research.probeResult !== undefined
      ) {
        const threshold =
          typeof p.promotionThreshold === "number" && p.promotionThreshold >= 0
            ? p.promotionThreshold
            : DEFAULT_PROBE_PROMOTION_THRESHOLD;
        const gate = evaluateProbeGate(research.probeBaseline, research.probeResult, threshold);
        if (gate && !gate.improved) {
          // Walk back to design instead of advancing to test.
          const walkBackLog = [
            ...(research.stageLog ?? []),
            {
              stage: "design" as const,
              at: Date.now(),
              note: `probe gate: Δ=${gate.delta} < threshold=${threshold}, walked back to design`,
            },
          ];
          const walkedBack = await s.update(id, {
            metadata: {
              research: { ...research, stage: "design" as const, stageLog: walkBackLog },
            },
          });
          return { card: redactToken(walkedBack as unknown as Record<string, unknown>) };
        }
      }
      const note =
        typeof p.note === "string" && p.note.trim() ? p.note.trim().slice(0, 400) : undefined;
      const stageLog = [
        ...(research.stageLog ?? []),
        { stage, at: Date.now(), ...(note ? { note } : {}) },
      ];
      // Status transitions: `implement` queues the card for the 06:00 cron (→ ready).
      // The inverse only fires when the pipeline itself queued it (was at `implement`,
      // status `ready`): walking it back un-queues it. Never demote an operator's
      // manual `ready` (userTouched) on a normal advance.
      const wasImplementQueued = research.stage === "implement" && card.status === "ready";
      const statusPatch =
        stage === "implement"
          ? { status: "ready" as const }
          : wasImplementQueued && research.userTouched !== true
            ? { status: "backlog" as const }
            : {};
      const updated = await s.update(id, {
        ...statusPatch,
        metadata: { research: { ...research, stage, stageLog } },
      });
      return { card: redactToken(updated as unknown as Record<string, unknown>) };
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
