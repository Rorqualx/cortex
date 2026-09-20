/**
 * Shared session-tool data shapes and classification helpers.
 *
 * Keeps list/send/status tools aligned on rows, visibility context, and compact kind/channel labels.
 */
import {
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
} from "./sessions-access.js";
export {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
  formatSessionToolAccessDenial,
  recordSessionToolActionFact,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionToolAccess,
} from "./sessions-access.js";
export {
  isExpectedSessionLookupMiss,
  resolveCurrentSessionClientAlias,
  resolveDisplaySessionKey,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSessionReference,
  resolveVisibleSessionReference,
  shouldResolveSessionIdInput,
} from "./sessions-resolution.js";
export {
  extractStoredAssistantText as extractAssistantText,
  sanitizeTextContent,
  stripToolMessages,
} from "./chat-history-text.js";
import {
  normalizeOptionalString,
  type FastMode,
} from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import type { SessionRow } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import {
  SessionCreatedActorSchema,
  SessionRowSchema,
} from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FastModeSource } from "../../shared/fast-mode.js";
import { stringEnum } from "../schema/typebox.js";

/** Coarse session category used by session list/status tools. */
export const SESSION_LIST_KINDS = ["main", "group", "cron", "hook", "node", "other"] as const;
export type SessionKind = (typeof SESSION_LIST_KINDS)[number];

// Upstream projects the Gateway's authoritative `classification` field into the
// coarse kinds via this map. The fork's live path is the key-based
// classifySessionKind below (six callers depend on it); this map and the
// classification-based helpers exist to preserve upstream's exported module
// contract for adopted importers until the sessions-tool cluster is ported.
const SESSION_KIND_BY_CLASSIFICATION: Readonly<Record<string, SessionKind>> = {
  main: "main",
  global: "main",
  group: "group",
  channel: "group",
  cron: "cron",
  hook: "hook",
  node: "node",
};

/** Delivery target metadata attached to session rows. */
export type SessionListDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

/** Compact run status shown by session tools. */
export type SessionRunStatus = "queued" | "running" | "done" | "failed" | "killed" | "timeout";

const SessionInventoryActorSchema = Type.Omit(SessionCreatedActorSchema, ["avatarUrl"]);

/**
 * Upstream's schema-derived model-facing row contract. The fork's live row is the
 * inline `SessionListRow` below; this schema preserves upstream's exported module
 * surface (see SESSION_KIND_BY_CLASSIFICATION note) for adopted importers.
 */
export const SessionListRowSchema = Type.Object(
  {
    ...Type.Pick(SessionRowSchema, [
      "key",
      "sessionId",
      "label",
      "worktree",
      "repositoryWorkspaceId",
      "repository",
      "execCwd",
      "spawnedCwd",
      "spawnedWorkspaceDir",
      "projectId",
      "workspaceDir",
      "displayName",
      "derivedTitle",
      "lastMessagePreview",
      "parentSessionKey",
      "model",
      "contextTokens",
      "totalTokens",
      "status",
      "childSessions",
    ]).properties,
    agentId: Type.String(),
    kind: stringEnum(SESSION_LIST_KINDS),
    channel: Type.String(),
    archived: Type.Boolean(),
    pinned: Type.Boolean(),
    createdActor: Type.Optional(SessionInventoryActorSchema),
    owner: Type.Optional(
      Type.Object({ actor: SessionInventoryActorSchema }, { additionalProperties: false }),
    ),
    group: Type.Optional(
      Type.String({
        description: 'Custom sidebar group membership; unrelated to kind "group" (group chats).',
      }),
    ),
    updatedAt: Type.Optional(Type.Number()),
    stateVersion: Type.Optional(Type.Number()),
    abortedLastRun: Type.Optional(Type.Boolean()),
    messages: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: false },
);

/** Full Gateway session row consumed by session orchestration internals. */
export type GatewaySessionListRow = Omit<
  SessionRow,
  "classification" | "contextTokens" | "totalTokens"
> & {
  classification: NonNullable<SessionRow["classification"]>;
  contextTokens?: number | null;
  totalTokens?: number | null;
  origin?: {
    provider?: string;
    accountId?: string;
  };
  category?: string;
  deliveryContext?: SessionListDeliveryContext;
  stateVersion?: number;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  childSessions?: string[];
  thinkingLevel?: string;
  fastMode?: FastMode;
  effectiveFastMode?: FastMode;
  effectiveFastModeSource?: FastModeSource;
  fastAutoOnSeconds?: number;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  responseUsage?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  sendPolicy?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  transcriptPath?: string;
  messages?: unknown[];
};

/** Normalized session row returned by session list-style tools. */
export type SessionListRow = {
  key: string;
  agentId?: string;
  kind: SessionKind;
  channel: string;
  origin?: {
    provider?: string;
    accountId?: string;
  };
  spawnedBy?: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  llmTitle?: string;
  lastMessagePreview?: string;
  parentSessionKey?: string;
  deliveryContext?: SessionListDeliveryContext;
  updatedAt?: number | null;
  archived?: boolean;
  archivedAt?: number;
  pinned?: boolean;
  pinnedAt?: number;
  sessionId?: string;
  model?: string;
  contextTokens?: number | null;
  totalTokens?: number | null;
  estimatedCostUsd?: number;
  status?: SessionRunStatus;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  childSessions?: string[];
  thinkingLevel?: string;
  fastMode?: boolean;
  verboseLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  responseUsage?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  sendPolicy?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  transcriptPath?: string;
  messages?: unknown[];
};

/** Resolves config plus sandbox visibility context for a session tool call. */
export function resolveSessionToolContext(opts?: {
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
}) {
  const cfg = opts?.config ?? getRuntimeConfig();
  return {
    cfg,
    a2aPolicy: createAgentToAgentPolicy(cfg),
    sessionVisibility: resolveEffectiveSessionToolsVisibility({
      cfg,
      sandboxed: opts?.sandboxed === true,
    }),
    ...resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: opts?.agentSessionKey,
      sandboxed: opts?.sandboxed,
    }),
  };
}

/**
 * Upstream's classification-based projection into the coarse kinds. Preserved for
 * upstream's exported module contract; the fork's live path is classifySessionKind.
 */
export function classifySessionListKind(params: {
  classification: NonNullable<GatewaySessionListRow["classification"]>;
  peerKind?: GatewaySessionListRow["peerKind"];
}): SessionKind {
  if (params.classification === "thread") {
    return params.peerKind === "group" || params.peerKind === "channel" ? "group" : "other";
  }
  return SESSION_KIND_BY_CLASSIFICATION[params.classification] ?? "other";
}

/** Classifies a session key/gateway kind into the row category used by tools. */
export function classifySessionKind(params: {
  key: string;
  gatewayKind?: string | null;
  alias: string;
  mainKey: string;
}): SessionKind {
  const key = params.key;
  if (key === params.alias || key === params.mainKey) {
    return "main";
  }
  if (key.startsWith("cron:")) {
    return "cron";
  }
  if (key.startsWith("hook:")) {
    return "hook";
  }
  if (key.startsWith("node-") || key.startsWith("node:")) {
    return "node";
  }
  if (params.gatewayKind === "group") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    // Gateway-less archived rows still encode group/channel shape in the session key.
    return "group";
  }
  return "other";
}

/** Derives the best channel label for a session row. */
export function deriveChannel(params: {
  key: string;
  kind: SessionKind;
  channel?: string | null;
  lastChannel?: string | null;
}): string {
  if (params.kind === "cron" || params.kind === "hook" || params.kind === "node") {
    return "internal";
  }
  const channel = normalizeOptionalString(params.channel ?? undefined);
  if (channel) {
    return channel;
  }
  const lastChannel = normalizeOptionalString(params.lastChannel ?? undefined);
  if (lastChannel) {
    return lastChannel;
  }
  const [scopePart, kindPart, targetPart] = params.key.split(":").filter(Boolean);
  if (scopePart && targetPart !== undefined && (kindPart === "group" || kindPart === "channel")) {
    return scopePart;
  }
  return "unknown";
}
