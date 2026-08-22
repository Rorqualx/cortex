// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { PluginJsonValueSchema } from "./plugins.js";
import { NonEmptyString } from "./primitives.js";
import { SessionPlacementSchema } from "./session-placement.js";
import { SessionCompactionCheckpointReasonSchema } from "./session-compaction-reason.js";

/**
 * Gateway session row and session event schemas.
 *
 * `GatewaySessionRowSchema` is the canonical wire projection of one session
 * for `sessions.list` results and `sessions.changed` / `session.message`
 * broadcasts. Server emit types and Control UI parse types both derive from
 * these schemas so the row shape cannot drift between the two sides.
 */

/** Conversation kind for a session row. */
export const GatewaySessionKindSchema = Type.Union([
  Type.Literal("direct"),
  Type.Literal("group"),
  Type.Literal("global"),
  Type.Literal("unknown"),
]);

/** Normalized conversation kind shared by channel routing and session rows. */
export const ChatTypeSchema = Type.Union([
  Type.Literal("direct"),
  Type.Literal("group"),
  Type.Literal("channel"),
]);

/** Runtime status surfaced for the latest session run. */
export const SessionRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("done"),
  Type.Literal("failed"),
  Type.Literal("killed"),
  Type.Literal("timeout"),
]);

/** Lifecycle state of the latest subagent run bound to the session. */
export const SubagentRunStateSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("interrupted"),
  Type.Literal("historical"),
]);

/** Lifecycle status of a session goal. */
export const SessionGoalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("blocked"),
  Type.Literal("usage_limited"),
  Type.Literal("budget_limited"),
  Type.Literal("complete"),
]);

/** Operator-defined goal tracked against token usage for a session. */
export const SessionGoalSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: NonEmptyString,
    objective: Type.String(),
    status: SessionGoalStatusSchema,
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    tokenStart: Type.Number(),
    tokenStartFresh: Type.Optional(Type.Boolean()),
    tokensUsed: Type.Number(),
    tokenBudget: Type.Optional(Type.Number()),
    continuationTurns: Type.Number(),
    lastStatusNote: Type.Optional(Type.String()),
    pausedAt: Type.Optional(Type.Number()),
    blockedAt: Type.Optional(Type.Number()),
    completedAt: Type.Optional(Type.Number()),
    usageLimitedAt: Type.Optional(Type.Number()),
    budgetLimitedAt: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** One selectable thinking level for the session's current model. */
export const GatewayThinkingLevelOptionSchema = Type.Object(
  {
    id: Type.String(),
    label: Type.String(),
  },
  { additionalProperties: false },
);

/** Resolved agent runtime id plus how it was selected. */
export const GatewayAgentRuntimeSchema = Type.Object(
  {
    id: Type.String(),
    fallback: Type.Optional(Type.Union([Type.Literal("openclaw"), Type.Literal("none")])),
    // Upstream #127xxx device placement: worker-side dispatch metadata. The fork
    // carries the worker-environments placement runtime, so the field stays in the
    // protocol even though the fork's cloud-placement siblings are not adopted.
    devicePlacement: Type.Optional(
      Type.Object(
        {
          requiredNodeCommands: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
            maxItems: 32,
            uniqueItems: true,
          }),
          consumesWorkerSlot: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
    ),
    source: Type.Union([
      Type.Literal("env"),
      Type.Literal("agent"),
      Type.Literal("defaults"),
      Type.Literal("model"),
      Type.Literal("provider"),
      Type.Literal("implicit"),
      Type.Literal("session"),
      Type.Literal("session-key"),
    ]),
  },
  { additionalProperties: false },
);

/** Channel/source metadata recorded when a session was first created. */
export const SessionOriginSchema = Type.Object(
  {
    label: Type.Optional(Type.String()),
    provider: Type.Optional(Type.String()),
    surface: Type.Optional(Type.String()),
    chatType: Type.Optional(ChatTypeSchema),
    from: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    nativeChannelId: Type.Optional(Type.String()),
    nativeDirectUserId: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  },
  { additionalProperties: false },
);

/** Deferred outbound delivery intent attached to a session. */
export const DeliveryIntentRefSchema = Type.Object(
  {
    id: NonEmptyString,
    kind: Type.Literal("outbound_queue"),
    queuePolicy: Type.Optional(Type.Union([Type.Literal("required"), Type.Literal("best_effort")])),
  },
  { additionalProperties: false },
);

/** Canonical channel delivery target carried on session rows. */
export const DeliveryContextSchema = Type.Object(
  {
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
    deliveryIntent: Type.Optional(DeliveryIntentRefSchema),
  },
  { additionalProperties: false },
);

/** Pre-prompt context budget estimate for the session's next turn. */
export const SessionContextBudgetStatusSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    source: Type.Literal("pre-prompt-estimate"),
    updatedAt: Type.Number(),
    provider: Type.String(),
    model: Type.String(),
    route: Type.Union([
      Type.Literal("fits"),
      Type.Literal("compact_only"),
      Type.Literal("truncate_tool_results_only"),
      Type.Literal("compact_then_truncate"),
    ]),
    shouldCompact: Type.Boolean(),
    estimatedPromptTokens: Type.Number(),
    contextTokenBudget: Type.Number(),
    promptBudgetBeforeReserve: Type.Number(),
    reserveTokens: Type.Number(),
    effectiveReserveTokens: Type.Number(),
    remainingPromptBudgetTokens: Type.Number(),
    overflowTokens: Type.Number(),
    toolResultReducibleChars: Type.Number(),
    messageCount: Type.Number(),
    unwindowedMessageCount: Type.Number(),
    sessionId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Queue mode for follow-up sends while a run is active. */
export const SessionQueueModeSchema = Type.Union([
  Type.Literal("steer"),
  Type.Literal("followup"),
  Type.Literal("collect"),
  Type.Literal("interrupt"),
]);

/** Transient operator-facing agent status note surfaced on a session row. */
export const SessionAgentStatusSchema = Type.Object(
  {
    note: Type.String(),
    expiresAt: Type.Number(),
    // Literal list mirrors SESSION_AGENT_ATTENTION_ICON_IDS in ../session-icon.ts;
    // a mapped Type.Union loses the literal tuple and degrades Static inference.
    attention: Type.Optional(
      Type.Union([
        Type.Literal("hand"),
        Type.Literal("key"),
        Type.Literal("alert"),
        Type.Literal("flag"),
        Type.Literal("lock"),
        Type.Literal("hourglass"),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Compact checkpoint preview embedded in session rows. */
export const SessionCompactionCheckpointPreviewSchema = Type.Object(
  {
    checkpointId: NonEmptyString,
    createdAt: Type.Number(),
    reason: SessionCompactionCheckpointReasonSchema,
  },
  { additionalProperties: false },
);

/** Plugin-owned session extension data projected onto a row. */
export const PluginSessionExtensionSchema = Type.Object(
  {
    pluginId: NonEmptyString,
    namespace: NonEmptyString,
    value: PluginJsonValueSchema,
  },
  { additionalProperties: false },
);

// Shared between the full row and the flattened per-event snapshot spread so
// the two shapes cannot drift; row-required fields (key/kind/updatedAt) and
// goal (nullable only in events) are declared per-schema below.
const gatewaySessionRowOptionalFields = {
  spawnedBy: Type.Optional(Type.String()),
  /** Collector swarm group that owns this child session, when applicable. */
  swarmGroupId: Type.Optional(Type.String()),
  icon: Type.Optional(Type.String()),
  agentStatus: Type.Optional(SessionAgentStatusSchema),
  /** Compact user-facing reason for the latest failed or timed-out run. */
  lastRunError: Type.Optional(Type.String()),
  /** An enabled cron job is bound to this session (runs in it or delivers to it). */
  hasAutomation: Type.Optional(Type.Boolean()),
  /** Managed worktree bound to this session (repo checkout + branch). */
  worktree: Type.Optional(
    Type.Object(
      {
        id: NonEmptyString,
        branch: Type.String(),
        repoRoot: Type.String(),
      },
      { additionalProperties: false },
    ),
  ),
  /** Session-scoped exec node binding (exec host=node routing). */
  execNode: Type.Optional(Type.String()),
  /** Working directory interpreted only by the bound exec node. */
  execCwd: Type.Optional(Type.String()),
  spawnedWorkspaceDir: Type.Optional(Type.String()),
  spawnedCwd: Type.Optional(Type.String()),
  forkedFromParent: Type.Optional(Type.Boolean()),
  spawnDepth: Type.Optional(Type.Number()),
  subagentRole: Type.Optional(Type.Union([Type.Literal("orchestrator"), Type.Literal("leaf")])),
  subagentControlScope: Type.Optional(Type.Union([Type.Literal("children"), Type.Literal("none")])),
  label: Type.Optional(Type.String()),
  displayName: Type.Optional(Type.String()),
  derivedTitle: Type.Optional(Type.String()),
  llmTitle: Type.Optional(Type.String()),
  firstMessagePreview: Type.Optional(Type.String()),
  lastMessagePreview: Type.Optional(Type.String()),
  channel: Type.Optional(Type.String()),
  subject: Type.Optional(Type.String()),
  groupChannel: Type.Optional(Type.String()),
  space: Type.Optional(Type.String()),
  chatType: Type.Optional(ChatTypeSchema),
  origin: Type.Optional(SessionOriginSchema),
  sessionId: Type.Optional(Type.String()),
  systemSent: Type.Optional(Type.Boolean()),
  abortedLastRun: Type.Optional(Type.Boolean()),
  thinkingLevel: Type.Optional(Type.String()),
  thinkingLevels: Type.Optional(Type.Array(GatewayThinkingLevelOptionSchema)),
  thinkingOptions: Type.Optional(Type.Array(Type.String())),
  thinkingDefault: Type.Optional(Type.String()),
  fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
  effectiveFastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Literal("auto")])),
  effectiveFastModeSource: Type.Optional(
    Type.Union([
      Type.Literal("session"),
      Type.Literal("agent"),
      Type.Literal("config"),
      Type.Literal("default"),
    ]),
  ),
  fastAutoOnSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  verboseLevel: Type.Optional(Type.String()),
  traceLevel: Type.Optional(Type.String()),
  reasoningLevel: Type.Optional(Type.String()),
  elevatedLevel: Type.Optional(Type.String()),
  sendPolicy: Type.Optional(Type.Union([Type.Literal("allow"), Type.Literal("deny")])),
  inputTokens: Type.Optional(Type.Number()),
  outputTokens: Type.Optional(Type.Number()),
  cacheRead: Type.Optional(Type.Number()),
  cacheWrite: Type.Optional(Type.Number()),
  totalTokens: Type.Optional(Type.Number()),
  totalTokensFresh: Type.Optional(Type.Boolean()),
  estimatedCostUsd: Type.Optional(Type.Number()),
  status: Type.Optional(SessionRunStatusSchema),
  hasActiveRun: Type.Optional(Type.Boolean()),
  activeRunIds: Type.Optional(Type.Array(Type.String())),
  // Session-lifecycle projection fields consumed by buildGatewaySessionEventFields
  // (upstream session grouping / unread / pin / archive controls, #100814). Optional
  // so rows built before the row-builder populates them emit safe defaults.
  archived: Type.Optional(Type.Boolean()),
  archivedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  pinned: Type.Optional(Type.Boolean()),
  pinnedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  unread: Type.Optional(Type.Boolean()),
  lastReadAt: Type.Optional(Type.Number()),
  /** Last real user/channel interaction; background work does not advance it. */
  lastInteractionAt: Type.Optional(Type.Number()),
  lastActivityAt: Type.Optional(Type.Number()),
  category: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  subagentRunState: Type.Optional(SubagentRunStateSchema),
  hasActiveSubagentRun: Type.Optional(Type.Boolean()),
  startedAt: Type.Optional(Type.Number()),
  endedAt: Type.Optional(Type.Number()),
  runtimeMs: Type.Optional(Type.Number()),
  parentSessionKey: Type.Optional(Type.String()),
  childSessions: Type.Optional(Type.Array(Type.String())),
  responseUsage: Type.Optional(
    Type.Union([
      Type.Literal("on"),
      Type.Literal("off"),
      Type.Literal("tokens"),
      Type.Literal("full"),
    ]),
  ),
  effectiveResponseUsage: Type.Optional(
    Type.Union([
      Type.Literal("on"),
      Type.Literal("off"),
      Type.Literal("tokens"),
      Type.Literal("full"),
    ]),
  ),
  /** Explicit per-session queue override, before channel/global defaults. */
  queueMode: Type.Optional(SessionQueueModeSchema),
  /** Queue mode for Control UI sends (session override → webchat config → global default). */
  effectiveQueueMode: Type.Optional(SessionQueueModeSchema),
  placement: Type.Optional(SessionPlacementSchema),
  modelProvider: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  modelSelectionLocked: Type.Optional(Type.Boolean()),
  agentRuntime: Type.Optional(GatewayAgentRuntimeSchema),
  contextTokens: Type.Optional(Type.Number()),
  contextBudgetStatus: Type.Optional(SessionContextBudgetStatusSchema),
  deliveryContext: Type.Optional(DeliveryContextSchema),
  lastChannel: Type.Optional(Type.String()),
  lastTo: Type.Optional(Type.String()),
  lastAccountId: Type.Optional(Type.String()),
  lastThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  compactionCheckpointCount: Type.Optional(Type.Number()),
  latestCompactionCheckpoint: Type.Optional(SessionCompactionCheckpointPreviewSchema),
  pluginExtensions: Type.Optional(Type.Array(PluginSessionExtensionSchema)),
};

/** One session row projected for sessions.list and session event payloads. */
export const GatewaySessionRowSchema = Type.Object(
  {
    key: NonEmptyString,
    kind: GatewaySessionKindSchema,
    updatedAt: Type.Union([Type.Number(), Type.Null()]),
    goal: Type.Optional(SessionGoalSchema),
    ...gatewaySessionRowOptionalFields,
  },
  { additionalProperties: false },
);

/** Session defaults attached to sessions.list results. */
export const GatewaySessionsDefaultsSchema = Type.Object(
  {
    modelProvider: Type.Union([Type.String(), Type.Null()]),
    model: Type.Union([Type.String(), Type.Null()]),
    contextTokens: Type.Union([Type.Number(), Type.Null()]),
    agentRuntime: Type.Optional(GatewayAgentRuntimeSchema),
    thinkingLevels: Type.Optional(Type.Array(GatewayThinkingLevelOptionSchema)),
    thinkingOptions: Type.Optional(Type.Array(Type.String())),
    thinkingDefault: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** sessions.list RPC result: defaults plus paginated session rows. */
export const SessionsListResultSchema = Type.Object(
  {
    ts: Type.Number(),
    path: Type.String(),
    count: Type.Number(),
    totalCount: Type.Optional(Type.Number()),
    limitApplied: Type.Optional(Type.Number()),
    offset: Type.Optional(Type.Number()),
    nextOffset: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    hasMore: Type.Optional(Type.Boolean()),
    defaults: GatewaySessionsDefaultsSchema,
    sessions: Type.Array(GatewaySessionRowSchema),
  },
  { additionalProperties: false },
);

// Event payload fields shared by sessions.changed and session.message: the
// flattened row snapshot plus the optional full row. goal admits null in
// events (emitters send `goal ?? null` so clients can clear a removed goal).
const sessionEventSnapshotFields = {
  kind: Type.Optional(GatewaySessionKindSchema),
  updatedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  goal: Type.Optional(Type.Union([SessionGoalSchema, Type.Null()])),
  session: Type.Optional(GatewaySessionRowSchema),
  ...gatewaySessionRowOptionalFields,
};

/** Broadcast when session metadata, lifecycle, or transcript state changes. */
export const SessionsChangedEventSchema = Type.Object(
  {
    ts: Type.Number(),
    sessionKey: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    compacted: Type.Optional(Type.Boolean()),
    phase: Type.Optional(Type.String()),
    runId: Type.Optional(Type.String()),
    clientRunId: Type.Optional(Type.String()),
    messageId: Type.Optional(Type.String()),
    messageSeq: Type.Optional(Type.Number()),
    ...sessionEventSnapshotFields,
  },
  { additionalProperties: false },
);

/** Broadcast for each displayable transcript message with a session snapshot. */
export const SessionMessageEventSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(Type.String()),
    // Chat display projection; intentionally opaque here like the chat.*
    // message payloads (projection shape is owned by chat-display-projection).
    message: Type.Unknown(),
    messageId: Type.Optional(Type.String()),
    messageSeq: Type.Optional(Type.Number()),
    ...sessionEventSnapshotFields,
  },
  { additionalProperties: false },
);

// Owner-local wire types derived directly from local schema consts so the
// public plugin-sdk declaration graph never pulls in the ProtocolSchemas registry.
export type GatewaySessionRow = Static<typeof GatewaySessionRowSchema>;
export type GatewaySessionKind = GatewaySessionRow["kind"];
// Named distinctly from sessions-row.ts's SessionRunStatus (same literal union,
// derived from this file's own GatewaySessionRow) to avoid an ambiguous
// re-export collision in schema-modules.ts, which wildcard-exports both files.
export type GatewaySessionRunStatus = NonNullable<GatewaySessionRow["status"]>;
export type SubagentRunState = NonNullable<GatewaySessionRow["subagentRunState"]>;
export type SessionCompactionCheckpointPreview = NonNullable<
  GatewaySessionRow["latestCompactionCheckpoint"]
>;
export type GatewayThinkingLevelOption = NonNullable<GatewaySessionRow["thinkingLevels"]>[number];
export type GatewaySessionsDefaults = Static<typeof GatewaySessionsDefaultsSchema>;
export type SessionGoal = Static<typeof SessionGoalSchema>;
export type GatewayAgentRuntime = Static<typeof GatewayAgentRuntimeSchema>;
export type DeliveryContext = Static<typeof DeliveryContextSchema>;
export type SessionsListResult = Static<typeof SessionsListResultSchema>;
export type SessionsChangedEvent = Static<typeof SessionsChangedEventSchema>;
export type SessionMessageEvent = Static<typeof SessionMessageEventSchema>;
