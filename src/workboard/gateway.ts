// Workboard plugin module implements gateway behavior.
import { formatErrorMessage } from "../infra/errors.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { WorkboardStore } from "./store.js";
import { WORKBOARD_STATUSES, type WorkboardCard } from "./types.js";

const READ_SCOPE = "operator.read" as const;
const WRITE_SCOPE = "operator.write" as const;

// Gateway method types (compatible with core RPC) */
type GatewayMethodParams = Record<string, unknown>;
type GatewayMethodHandler = (params: GatewayMethodParams, ctx?: unknown) => unknown;
type RegisterGatewayMethod = (method: string, handler: GatewayMethodHandler) => void;

function respondError(error: unknown): never {
  throw Object.assign(new Error(formatErrorMessage(error)), {
    code: "workboard_error",
  });
}

function readId(params: Record<string, unknown>): string {
  const value = params.id;
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error("id is required.");
}

function readPatch(params: Record<string, unknown>): Record<string, unknown> {
  const patch = params.patch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return patch as Record<string, unknown>;
  }
  return params;
}

function assertNoCursorAdvance(params: Record<string, unknown>) {
  if (params.advance === true) {
    throw new Error("notification cursor advancement requires workboard.notifications.advance.");
  }
}

function redactClaimToken(card: WorkboardCard): WorkboardCard {
  const claim = card.metadata?.claim;
  if (!claim) {
    return card;
  }
  return {
    ...card,
    metadata: {
      ...card.metadata,
      claim: { ...claim, token: "[redacted]" },
    },
  };
}

function redactDiagnosticsRows(result: Awaited<ReturnType<WorkboardStore["diagnostics"]>>) {
  return {
    ...result,
    diagnostics: result.diagnostics.map((row) => ({
      ...row,
      card: redactClaimToken(row.card),
    })),
  };
}

export function registerWorkboardGatewayMethods(
  store: WorkboardStore,
  register: RegisterGatewayMethod,
): void {
  const s = store ?? WorkboardStore.openSqlite();

  register(
    "workboard.cards.list",
    async (params) => {
      try {
        return {
          cards: (await s.list({ boardId: params.boardId })).map(redactClaimToken),
          statuses: WORKBOARD_STATUSES,
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.cards.create",
    async (params) => {
      try {
        return { card: redactClaimToken(await s.create(params)) };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.update",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.update(readId(params), readPatch(params))),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.move",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.move(readId(params), params.status, params.position)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.delete",
    async (params) => {
      try {
        respond(true, await s.delete(readId(params)));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.comment",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.addComment(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.link",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.addLink(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.linkDependency",
    async (params) => {
      try {
        const parentId = params.parentId;
        const childId = params.childId;
        if (typeof parentId !== "string" || typeof childId !== "string") {
          throw new Error("parentId and childId are required.");
        }
        return {
          card: redactClaimToken(await s.linkCards(parentId, childId)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.proof",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.addProof(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.artifact",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.addArtifact(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.claim",
    async (params) => {
      try {
        const claimed = await s.claim(readId(params), params);
        return { ...claimed, card: redactClaimToken(claimed.card) };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.heartbeat",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.heartbeat(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.release",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.releaseClaim(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.promote",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.promote(readId(params), params, null)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.reassign",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.reassign(readId(params), params, null)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.reclaim",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.reclaim(readId(params), params, null)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.complete",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.complete(readId(params), params, null)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.block",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.block(readId(params), params, null)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.unblock",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.unblock(readId(params))),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.bulk",
    async (params) => {
      try {
        const result = await s.bulkUpdate(params);
        return { cards: result.cards.map(redactClaimToken) };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.diagnostics",
    async ({ respond }) => {
      try {
        respond(true, redactDiagnosticsRows(await s.diagnostics()));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.cards.diagnostics.refresh",
    async ({ respond }) => {
      try {
        respond(true, redactDiagnosticsRows(await s.refreshDiagnostics()));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.dispatch",
    async ({ respond }) => {
      try {
        const result = await dispatchAndStartWorkboardCards({
          store,
          subagent: api.runtime.subagent,
        });
        return {
          ...result,
          promoted: result.promoted.map(redactClaimToken),
          reclaimed: result.reclaimed.map(redactClaimToken),
          blocked: result.blocked.map(redactClaimToken),
          orchestrated: result.orchestrated.map(redactClaimToken),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.boards.list",
    async ({ respond }) => {
      try {
        respond(true, await s.listBoards());
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.boards.upsert",
    async (params) => {
      try {
        return { board: await s.upsertBoard(params) };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.boards.archive",
    async (params) => {
      try {
        return {
          board: await s.archiveBoard(params.id, params.archived),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.boards.delete",
    async (params) => {
      try {
        respond(true, await s.deleteBoard(params.id));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.stats",
    async (params) => {
      try {
        respond(true, await s.stats({ boardId: params.boardId }));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.cards.runs",
    async (params) => {
      try {
        const result = await s.runs(readId(params));
        return { ...result, card: redactClaimToken(result.card) };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.cards.specify",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.specify(readId(params), params, null)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.decompose",
    async (params) => {
      try {
        const result = await s.decompose(readId(params), params, null);
        return {
          parent: redactClaimToken(result.parent),
          children: result.children.map(redactClaimToken),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.notifications.subscribe",
    async (params) => {
      try {
        return { subscription: await s.subscribeNotifications(params) };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.notifications.list",
    async (params) => {
      try {
        respond(true, await s.listNotificationSubscriptions(params));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.notifications.delete",
    async (params) => {
      try {
        respond(true, await s.deleteNotificationSubscription(readId(params)));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.notifications.events",
    async (params) => {
      try {
        assertNoCursorAdvance(params);
        respond(true, await s.notificationEvents(params));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.notifications.advance",
    async (params) => {
      try {
        respond(true, await s.advanceNotificationEvents(params));
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.attachments.list",
    async (params) => {
      try {
        const result = await s.listAttachments(readId(params));
        return { ...result, card: redactClaimToken(result.card) };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.cards.attachments.get",
    async (params) => {
      try {
        const attachment = await s.getAttachment(readId(params));
        if (!attachment) {
          throw new Error(`attachment not found: ${readId(params)}`);
        }
        respond(true, attachment);
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );

  register(
    "workboard.cards.attachments.add",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.addAttachment(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.attachments.delete",
    async (params) => {
      try {
        const attachmentId = params.attachmentId;
        if (typeof attachmentId !== "string" || !attachmentId.trim()) {
          throw new Error("attachmentId is required.");
        }
        return {
          card: redactClaimToken(await s.deleteAttachment(readId(params), attachmentId.trim())),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.workerLog",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.addWorkerLog(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.protocolViolation",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.recordProtocolViolation(readId(params), params)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.archive",
    async (params) => {
      try {
        return {
          card: redactClaimToken(await s.archive(readId(params), params.archived)),
        };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: WRITE_SCOPE },
  );

  register(
    "workboard.cards.export",
    async ({ respond }) => {
      try {
        const exported = await s.exportCards();
        return { ...exported, cards: exported.cards.map(redactClaimToken) };
      } catch (error) {
        respondError(error);
      }
    },
    { scope: READ_SCOPE },
  );
}
