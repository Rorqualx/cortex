/**
 * Aggregated static TypeScript types for the gateway protocol.
 *
 * Each type is co-located with its canonical TypeBox schema const in the owning
 * domain module, so validators and exported compile-time types cannot drift.
 * This barrel only re-exports those co-located types under one stable path; it
 * imports no schema-registry value, so the public plugin-sdk declaration graph
 * stays free of runtime registry consts.
 */

/** Cross-agent Control UI activity feed payloads. */
export type {
  ActivityEvent,
  ActivityEventDetail,
  ActivityEventMetrics,
  ActivityCursor,
  ActivityListParams,
  ActivityListResult,
  ActivitySubscribeParams,
  ActivitySubscribeResult,
  ActivityUnsubscribeParams,
} from "./activity.js";

/** Session lifecycle, message routing, compaction, patch, and usage payloads. */
export type {
  GatewaySessionRow,
  GatewaySessionKind,
  SessionRunStatus,
  SubagentRunState,
  SessionCompactionCheckpointPreview,
  GatewayThinkingLevelOption,
  GatewaySessionsDefaults,
  SessionGoal,
  GatewayAgentRuntime,
  DeliveryContext,
  SessionsListResult,
  SessionsChangedEvent,
  SessionMessageEvent,
} from "./session-row.js";

/**
 * Agent config-file CRUD plus model, command, plugin UI action, tool catalog,
 * and skill workshop payloads.
 */
export type {
  AgentSummary,
  AgentsFileEntry,
  AgentsCreateParams,
  AgentsCreateResult,
  AgentsUpdateParams,
  AgentsUpdateResult,
  AgentsDeleteParams,
  AgentsDeleteResult,
  AgentsFilesListParams,
  AgentsFilesListResult,
  AgentsFilesGetParams,
  AgentsFilesGetResult,
  AgentsFilesSetParams,
  AgentsFilesSetResult,
  AgentsListParams,
  AgentsListResult,
  ModelChoice,
  ModelsListParams,
  ModelsListResult,
  ModelsProbeParams,
  ModelsProbeTargetResult,
  ModelsProbeResult,
  SkillsStatusParams,
  ToolsCatalogParams,
  ToolCatalogProfile,
  ToolCatalogEntry,
  ToolCatalogGroup,
  ToolsCatalogResult,
  ToolsEffectiveParams,
  ToolsEffectiveEntry,
  ToolsEffectiveGroup,
  ToolsEffectiveNotice,
  ToolsEffectiveResult,
  ToolsInvokeParams,
  ToolsInvokeResult,
  SkillsBinsParams,
  SkillsBinsResult,
  SkillsSearchParams,
  SkillsSearchResult,
  SkillsDetailParams,
  SkillsDetailResult,
  SkillsSecurityVerdictsParams,
  SkillsSecurityVerdictsResult,
  SkillsSkillCardParams,
  SkillsSkillCardResult,
  SkillsUploadBeginParams,
  SkillsUploadChunkParams,
  SkillsUploadCommitParams,
  SkillsInstallParams,
  SkillsUpdateParams,
} from "./agents-models-skills.js";

/** Logs and chat.send timing/result payloads exposed through gateway RPC. */
export type {
  LogsTailParams,
  LogsTailResult,
  ChatMetadataParams,
  ChatAbortParams,
  ChatInjectParams,
  ChatEvent,
  ChatSendTimingEvent,
  ChatSendTimingPhase,
  ChatSideResultEvent,
} from "./logs-chat.js";

/** Exec command approval request/decision payloads. */
export type {
  ExecApprovalDecision,
  ExecApprovalCommandSpan,
  CommandExplanationSummary,
  SystemRunApprovalFileOperand,
  SystemRunApprovalPlan,
  SystemRunApprovalBinding,
  ExecApprovalRequestPayload,
  ExecApprovalRequestedEvent,
  ExecApprovalResolvedEvent,
} from "./exec-approvals.js";

/** Plugin approval request/decision payloads. */
export type {
  PluginApprovalActionView,
  PluginApprovalRequestPayload,
  PluginApprovalRequestedEvent,
  PluginApprovalResolvedEvent,
} from "./plugin-approvals.js";
