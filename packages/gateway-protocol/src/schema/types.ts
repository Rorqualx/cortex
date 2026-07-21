/**
 * Static TypeScript types derived from the canonical gateway protocol schemas.
 *
 * Keep aliases wired through `ProtocolSchemas` so validators, runtime schemas,
 * and exported compile-time types cannot drift apart.
 */
import type { Static } from "typebox";
import { ProtocolSchemas } from "./protocol-schemas.js";

/** Stable schema names registered in the protocol schema registry. */
type ProtocolSchemaName = keyof typeof ProtocolSchemas;
/** Inferred TypeScript type for a named TypeBox protocol schema. */
type SchemaType<TName extends ProtocolSchemaName> = Static<(typeof ProtocolSchemas)[TName]>;

/** Connection handshake, envelope, snapshot, and shared error wire types. */

/** Environment status RPC payloads used by CLI and Control UI surfaces. */

/** Cross-agent Control UI activity feed payloads. */
export type ActivityEvent = SchemaType<"ActivityEvent">;
export type ActivityEventDetail = SchemaType<"ActivityEventDetail">;
export type ActivityEventMetrics = SchemaType<"ActivityEventMetrics">;
export type ActivityCursor = SchemaType<"ActivityCursor">;
export type ActivityListParams = SchemaType<"ActivityListParams">;
export type ActivityListResult = SchemaType<"ActivityListResult">;
export type ActivitySubscribeParams = SchemaType<"ActivitySubscribeParams">;
export type ActivitySubscribeResult = SchemaType<"ActivitySubscribeResult">;
export type ActivityUnsubscribeParams = SchemaType<"ActivityUnsubscribeParams">;

/** Agent activity, identity, send, poll, wait, and wake protocol payloads. */

/** Node pairing, presence, invoke, and pending-queue protocol payloads. */

/** Push notification test result contracts exposed through gateway RPC. */

/** Session lifecycle, message routing, compaction, patch, and usage payloads. */
export type GatewaySessionRow = SchemaType<"GatewaySessionRow">;
export type GatewaySessionKind = GatewaySessionRow["kind"];
export type SessionRunStatus = NonNullable<GatewaySessionRow["status"]>;
export type SubagentRunState = NonNullable<GatewaySessionRow["subagentRunState"]>;
export type SessionCompactionCheckpointPreview = NonNullable<
  GatewaySessionRow["latestCompactionCheckpoint"]
>;
export type GatewayThinkingLevelOption = NonNullable<GatewaySessionRow["thinkingLevels"]>[number];
export type GatewaySessionsDefaults = SchemaType<"GatewaySessionsDefaults">;
export type SessionGoal = SchemaType<"SessionGoal">;
export type GatewayAgentRuntime = SchemaType<"GatewayAgentRuntime">;
export type DeliveryContext = SchemaType<"DeliveryContext">;
export type SessionsListResult = SchemaType<"SessionsListResult">;
export type SessionsChangedEvent = SchemaType<"SessionsChangedEvent">;
export type SessionMessageEvent = SchemaType<"SessionMessageEvent">;

/** Metadata-only audit query payloads. */

/** Task ledger query and cancellation payloads. */

/** Config read/write/schema payloads plus update status and run controls. */

/** Wizard setup flow payloads exchanged by CLI, UI, and gateway. */

/** Realtime Talk client/session/event payloads. */

/** Channel control and web-login payloads. */

/** Agent config-file CRUD and artifact download/list payloads. */
export type AgentSummary = SchemaType<"AgentSummary">;
export type AgentsFileEntry = SchemaType<"AgentsFileEntry">;
export type AgentsCreateParams = SchemaType<"AgentsCreateParams">;
export type AgentsCreateResult = SchemaType<"AgentsCreateResult">;
export type AgentsUpdateParams = SchemaType<"AgentsUpdateParams">;
export type AgentsUpdateResult = SchemaType<"AgentsUpdateResult">;
export type AgentsDeleteParams = SchemaType<"AgentsDeleteParams">;
export type AgentsDeleteResult = SchemaType<"AgentsDeleteResult">;
export type AgentsFilesListParams = SchemaType<"AgentsFilesListParams">;
export type AgentsFilesListResult = SchemaType<"AgentsFilesListResult">;
export type AgentsFilesGetParams = SchemaType<"AgentsFilesGetParams">;
export type AgentsFilesGetResult = SchemaType<"AgentsFilesGetResult">;
export type AgentsFilesSetParams = SchemaType<"AgentsFilesSetParams">;
export type AgentsFilesSetResult = SchemaType<"AgentsFilesSetResult">;

/** Model, command, plugin UI action, tool catalog, and skill workshop payloads. */
export type AgentsListParams = SchemaType<"AgentsListParams">;
export type AgentsListResult = SchemaType<"AgentsListResult">;
export type ModelChoice = SchemaType<"ModelChoice">;
export type ModelsListParams = SchemaType<"ModelsListParams">;
export type ModelsListResult = SchemaType<"ModelsListResult">;
export type ModelsProbeParams = SchemaType<"ModelsProbeParams">;
export type ModelsProbeTargetResult = SchemaType<"ModelsProbeTargetResult">;
export type ModelsProbeResult = SchemaType<"ModelsProbeResult">;
export type ChatMetadataParams = SchemaType<"ChatMetadataParams">;
export type SkillsStatusParams = SchemaType<"SkillsStatusParams">;
export type ToolsCatalogParams = SchemaType<"ToolsCatalogParams">;
export type ToolCatalogProfile = SchemaType<"ToolCatalogProfile">;
export type ToolCatalogEntry = SchemaType<"ToolCatalogEntry">;
export type ToolCatalogGroup = SchemaType<"ToolCatalogGroup">;
export type ToolsCatalogResult = SchemaType<"ToolsCatalogResult">;
export type ToolsEffectiveParams = SchemaType<"ToolsEffectiveParams">;
export type ToolsEffectiveEntry = SchemaType<"ToolsEffectiveEntry">;
export type ToolsEffectiveGroup = SchemaType<"ToolsEffectiveGroup">;
export type ToolsEffectiveNotice = SchemaType<"ToolsEffectiveNotice">;
export type ToolsEffectiveResult = SchemaType<"ToolsEffectiveResult">;
export type ToolsInvokeParams = SchemaType<"ToolsInvokeParams">;
export type ToolsInvokeResult = SchemaType<"ToolsInvokeResult">;
export type SkillsBinsParams = SchemaType<"SkillsBinsParams">;
export type SkillsBinsResult = SchemaType<"SkillsBinsResult">;
export type SkillsSearchParams = SchemaType<"SkillsSearchParams">;
export type SkillsSearchResult = SchemaType<"SkillsSearchResult">;
export type SkillsDetailParams = SchemaType<"SkillsDetailParams">;
export type SkillsDetailResult = SchemaType<"SkillsDetailResult">;
export type SkillsSecurityVerdictsParams = SchemaType<"SkillsSecurityVerdictsParams">;
export type SkillsSecurityVerdictsResult = SchemaType<"SkillsSecurityVerdictsResult">;
export type SkillsSkillCardParams = SchemaType<"SkillsSkillCardParams">;
export type SkillsSkillCardResult = SchemaType<"SkillsSkillCardResult">;
export type SkillsUploadBeginParams = SchemaType<"SkillsUploadBeginParams">;
export type SkillsUploadChunkParams = SchemaType<"SkillsUploadChunkParams">;
export type SkillsUploadCommitParams = SchemaType<"SkillsUploadCommitParams">;
export type SkillsInstallParams = SchemaType<"SkillsInstallParams">;
export type SkillsUpdateParams = SchemaType<"SkillsUpdateParams">;

/** Cron scheduler and run-log payloads. */

/** Logs and approval payloads for chat, exec commands, plugins, and devices. */
export type LogsTailParams = SchemaType<"LogsTailParams">;
export type LogsTailResult = SchemaType<"LogsTailResult">;
export type ExecApprovalDecision = SchemaType<"ExecApprovalDecision">;
export type ExecApprovalCommandSpan = SchemaType<"ExecApprovalCommandSpan">;
export type CommandExplanationSummary = SchemaType<"CommandExplanationSummary">;
export type SystemRunApprovalFileOperand = SchemaType<"SystemRunApprovalFileOperand">;
export type SystemRunApprovalPlan = SchemaType<"SystemRunApprovalPlan">;
export type SystemRunApprovalBinding = SchemaType<"SystemRunApprovalBinding">;
export type ExecApprovalRequestPayload = SchemaType<"ExecApprovalRequestPayload">;
export type ExecApprovalRequestedEvent = SchemaType<"ExecApprovalRequestedEvent">;
export type ExecApprovalResolvedEvent = SchemaType<"ExecApprovalResolvedEvent">;
export type PluginApprovalActionView = SchemaType<"PluginApprovalActionView">;
export type PluginApprovalRequestPayload = SchemaType<"PluginApprovalRequestPayload">;
export type PluginApprovalRequestedEvent = SchemaType<"PluginApprovalRequestedEvent">;
export type PluginApprovalResolvedEvent = SchemaType<"PluginApprovalResolvedEvent">;
export type ChatAbortParams = SchemaType<"ChatAbortParams">;
export type ChatInjectParams = SchemaType<"ChatInjectParams">;
export type ChatEvent = SchemaType<"ChatEvent">;
export type ChatSendTimingEvent = SchemaType<"ChatSendTimingEvent">;
/** Server-side phase markers for operator chat.send timing diagnostics. */
export type ChatSendTimingPhase = ChatSendTimingEvent["phase"];
export type ChatSideResultEvent = SchemaType<"ChatSideResultEvent">;

/** Gateway update and process lifecycle event payloads. */
