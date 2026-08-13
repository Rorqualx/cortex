// Shared sessions.changed broadcaster for gateway RPC and chat-command mutations.
import type { SessionsChangedEvent } from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { hasSessionChangeReceivers } from "../session-change-receivers.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import { hasTrackedActiveSessionRun } from "./session-active-runs.js";
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
  timer: ReturnType<typeof setTimeout> | null;
};

const SESSIONS_CHANGED_DEBOUNCE_MS = 100;
const sessionsMutationVersions = new WeakMap<object, number>();
const pendingChangesByContext = new WeakMap<object, Map<string, PendingSessionChange>>();
const pendingSessionChanges = new Set<PendingSessionChange>();

export function readSessionsMutationVersion(context: object): number {
  return sessionsMutationVersions.get(context) ?? 0;
}

function sessionChangeKey(payload: SessionChangedPayload): string {
  return `${payload.agentId ?? ""}\0${payload.sessionKey ?? ""}`;
}

function broadcastSessionsChanged(
  context: SessionChangeContext,
  payload: SessionChangedPayload,
): void {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  const sessionRow = payload.sessionKey
    ? loadGatewaySessionRow(
        payload.sessionKey,
        payload.sessionKey === "global" && payload.agentId
          ? { agentId: payload.agentId }
          : undefined,
      )
    : null;
  const omitUnscopedGlobalGoal = payload.sessionKey === "global" && !payload.agentId;
  const defaultAgentId = resolveDefaultAgentId(context.getRuntimeConfig());
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            updatedAt: sessionRow.updatedAt ?? undefined,
            sessionId: sessionRow.sessionId,
            kind: sessionRow.kind,
            channel: sessionRow.channel,
            subject: sessionRow.subject,
            groupChannel: sessionRow.groupChannel,
            space: sessionRow.space,
            chatType: sessionRow.chatType,
            origin: sessionRow.origin,
            spawnedBy: sessionRow.spawnedBy,
            spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
            spawnedCwd: sessionRow.spawnedCwd,
            forkedFromParent: sessionRow.forkedFromParent,
            spawnDepth: sessionRow.spawnDepth,
            subagentRole: sessionRow.subagentRole,
            subagentControlScope: sessionRow.subagentControlScope,
            label: sessionRow.label,
            displayName: sessionRow.displayName,
            llmTitle: sessionRow.llmTitle,
            derivedTitle: sessionRow.derivedTitle,
            deliveryContext: sessionRow.deliveryContext,
            parentSessionKey: sessionRow.parentSessionKey,
            childSessions: sessionRow.childSessions,
            thinkingLevel: sessionRow.thinkingLevel,
            fastMode: sessionRow.fastMode,
            verboseLevel: sessionRow.verboseLevel,
            traceLevel: sessionRow.traceLevel,
            reasoningLevel: sessionRow.reasoningLevel,
            elevatedLevel: sessionRow.elevatedLevel,
            sendPolicy: sessionRow.sendPolicy,
            systemSent: sessionRow.systemSent,
            abortedLastRun: sessionRow.abortedLastRun,
            inputTokens: sessionRow.inputTokens,
            outputTokens: sessionRow.outputTokens,
            lastChannel: sessionRow.lastChannel,
            lastTo: sessionRow.lastTo,
            lastAccountId: sessionRow.lastAccountId,
            lastThreadId: sessionRow.lastThreadId,
            totalTokens: sessionRow.totalTokens,
            totalTokensFresh: sessionRow.totalTokensFresh,
            ...(omitUnscopedGlobalGoal ? {} : { goal: sessionRow.goal ?? null }),
            contextTokens: sessionRow.contextTokens,
            estimatedCostUsd: sessionRow.estimatedCostUsd,
            responseUsage: sessionRow.responseUsage,
            modelProvider: sessionRow.modelProvider,
            model: sessionRow.model,
            status: sessionRow.status,
            hasActiveRun: hasTrackedActiveSessionRun({
              context,
              requestedKey: payload.sessionKey ?? sessionRow.key,
              canonicalKey: sessionRow.key,
              agentId: sessionRow.key === "global" ? payload.agentId : undefined,
              defaultAgentId,
            }),
            startedAt: sessionRow.startedAt,
            endedAt: sessionRow.endedAt,
            runtimeMs: sessionRow.runtimeMs,
            compactionCheckpointCount: sessionRow.compactionCheckpointCount,
            latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
            pluginExtensions: sessionRow.pluginExtensions,
          }
        : {}),
      // satisfies pins this emit to the wire-contract SessionsChangedEventSchema
      // so payload drift fails the build instead of silently diverging from UI.
    } satisfies SessionsChangedEvent,
    connIds,
    {
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      dropIfSlow: true,
      // Scope only to a concrete key; a `[undefined]` scope filters no connection
      // correctly and would strip draft gating, so fall back to an unscoped send.
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
    broadcastSessionsChanged(pending.context, pending.payload);
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
  const key = sessionChangeKey(payload);
  const byKey = pendingChangesByContext.get(context) ?? new Map<string, PendingSessionChange>();
  pendingChangesByContext.set(context, byKey);
  const pending = byKey.get(key);
  if (pending) {
    pending.payload = payload;
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
    timer: null,
  };
  next.timer = setTimeout(() => finishPendingSessionChange(next), SESSIONS_CHANGED_DEBOUNCE_MS);
  next.timer.unref?.();
  byKey.set(key, next);
  pendingSessionChanges.add(next);
  broadcastSessionsChanged(context, payload);
}
