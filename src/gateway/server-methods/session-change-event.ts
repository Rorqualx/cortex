// Shared sessions.changed broadcaster for gateway RPC and chat-command mutations.
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { hasSessionChangeReceivers } from "../session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import {
  resolvePrivateSessionEventBroadcastScope,
  resolveSessionEventAgentScope,
  type SessionEventAgentScope,
} from "../session-request-agent.js";
import type { SessionsChangedEvent } from "../../../packages/gateway-protocol/src/index.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import type { GatewayRequestContext } from "./types.js";

export type SessionChangedPayload = {
  sessionKey?: string;
  agentId?: string;
  reason: string;
  compacted?: boolean;
};

type SessionChangeContext = Pick<
  GatewayRequestContext,
  | "broadcastToConnIds"
  | "chatAbortControllers"
  | "getRuntimeConfig"
  | "getSessionEventSubscriberConnIds"
>;

type PendingSessionChange = {
  context: SessionChangeContext;
  dirty: boolean;
  key: string;
  payload: SessionChangedPayload;
  scope: SessionEventAgentScope | null;
  timer: ReturnType<typeof setTimeout> | null;
};

const SESSIONS_CHANGED_DEBOUNCE_MS = 100;
const sessionsMutationVersions = new WeakMap<object, number>();
const pendingChangesByContext = new WeakMap<object, Map<string, PendingSessionChange>>();
const pendingSessionChanges = new Set<PendingSessionChange>();

export function readSessionsMutationVersion(context: object): number {
  return sessionsMutationVersions.get(context) ?? 0;
}

function sessionChangeKey(payload: SessionChangedPayload, scope: SessionEventAgentScope | null) {
  return `${scope?.[1] ?? payload.agentId ?? ""}\0${payload.sessionKey ?? ""}`;
}

function broadcastSessionsChanged(
  context: SessionChangeContext,
  payload: SessionChangedPayload,
  scope: SessionEventAgentScope | null,
): void {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  if (scope === null) {
    return;
  }
  const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = scope;
  const privateBroadcastScope = resolvePrivateSessionEventBroadcastScope(payload.sessionKey, scope);
  const broadcastAgentId = routingAgentId;
  const broadcastOptions = {
    ...(broadcastAgentId ? { agentId: broadcastAgentId } : {}),
    ...privateBroadcastScope,
    dropIfSlow: true,
  };
  const eventPayload = {
    ...payload,
    ...(eventAgentId ? { agentId: eventAgentId } : {}),
    ts: Date.now(),
  };
  if (
    !payload.sessionKey ||
    !routingAgentId ||
    (!eventAgentId && !compatibilityOwnerAgentId && !parseAgentSessionKey(payload.sessionKey))
  ) {
    context.broadcastToConnIds("sessions.changed", eventPayload, connIds, broadcastOptions);
    return;
  }
  const sessionRow = loadGatewaySessionRow(payload.sessionKey, { agentId: routingAgentId });
  const activeRunState =
    sessionRow && (sessionRow.key !== "global" || routingAgentId !== undefined)
      ? resolveVisibleActiveSessionRunState({
          context,
          requestedKey: payload.sessionKey ?? sessionRow.key,
          canonicalKey: sessionRow.key,
          sessionId: sessionRow.sessionId,
          agentId: routingAgentId,
          defaultAgentId: compatibilityOwnerAgentId,
        })
      : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...eventPayload,
      ...(sessionRow
        ? {
            ...buildGatewaySessionSnapshot({
              sessionRow,
              agentId: eventAgentId,
              activeRunState,
              status: activeRunState?.active ? (activeRunState.status ?? "running") : undefined,
            }),
          }
        : {}),
      // satisfies pins this emit to the wire-contract SessionsChangedEventSchema
      // so payload drift fails the build instead of silently diverging from UI.
    } satisfies SessionsChangedEvent,
    connIds,
    {
      ...broadcastOptions,
      ...(sessionRow?.key ? { sessionKeys: [sessionRow.key] } : {}),
    },
  );
}

function finishPendingSessionChange(pending: PendingSessionChange): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  pendingSessionChanges.delete(pending);
  const byKey = pendingChangesByContext.get(pending.context);
  if (byKey?.get(pending.key) === pending) {
    byKey.delete(pending.key);
  }
  if (pending.dirty) {
    broadcastSessionsChanged(pending.context, pending.payload, pending.scope);
  }
}

/** Flush trailing notifications and release every debounce timer before gateway shutdown. */
export function flushPendingSessionsChangedEvents(context?: object): void {
  for (const pending of pendingSessionChanges) {
    if (!context || pending.context === context) {
      finishPendingSessionChange(pending);
    }
  }
}

// Upstream sessions.recover consumer needs this; grafted back after merge=ours kept the
// fork's divergent session-change-event.ts and dropped upstream's emitSessionArchived.
export function emitSessionArchived(
  context: SessionChangeContext,
  sessionKey: string | undefined,
  agentId?: string,
): void {
  if (!sessionKey) {
    return;
  }
  emitSessionsChanged(context, {
    sessionKey,
    ...(agentId ? { agentId } : {}),
    reason: "archive",
  });
}

export function emitSessionsChanged(context: SessionChangeContext, payload: SessionChangedPayload) {
  // This counter is the sessions.list projection fence: every mutation advances it
  // synchronously, before event coalescing, so work started on an older value is never
  // joined or cached by a request that begins after the mutation.
  sessionsMutationVersions.set(context, readSessionsMutationVersion(context) + 1);
  invalidateSessionSharingSnapshot(payload.sessionKey);
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  const scope: SessionEventAgentScope | null = payload.sessionKey
    ? resolveSessionEventAgentScope(context.getRuntimeConfig(), payload.sessionKey, payload.agentId)
    : [payload.agentId, payload.agentId, undefined];
  const key = sessionChangeKey(payload, scope);
  const byKey = pendingChangesByContext.get(context) ?? new Map<string, PendingSessionChange>();
  pendingChangesByContext.set(context, byKey);
  const pending = byKey.get(key);
  if (pending) {
    pending.payload = payload;
    pending.scope = scope;
    pending.dirty = true;
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.timer = setTimeout(
      () => finishPendingSessionChange(pending),
      SESSIONS_CHANGED_DEBOUNCE_MS,
    );
    pending.timer.unref?.();
    return;
  }

  // Lead after a quiet period for responsive UI, then coalesce a burst into one trailing
  // rebuild. The trailing row is loaded only when emitted, so it reflects the newest state.
  const next: PendingSessionChange = {
    context,
    dirty: false,
    key,
    payload,
    scope,
    timer: null,
  };
  next.timer = setTimeout(() => finishPendingSessionChange(next), SESSIONS_CHANGED_DEBOUNCE_MS);
  next.timer.unref?.();
  byKey.set(key, next);
  pendingSessionChanges.add(next);
  broadcastSessionsChanged(context, payload, scope);
}
