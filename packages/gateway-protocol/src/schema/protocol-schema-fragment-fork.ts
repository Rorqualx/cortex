// Fork-owned protocol schemas, kept in their own fragment so upstream can keep
// reshaping protocol-schemas.ts without this delta conflicting every merge.
// The composer rejects duplicate keys, so nothing here may shadow an upstream
// fragment: these are exactly the keys upstream does not define.
import * as activity from "./activity.js";
import * as exec_approvals from "./exec-approvals.js";
import * as logs_chat from "./logs-chat.js";
import * as plugin_approvals from "./plugin-approvals.js";
import * as session_row from "./session-row.js";
import * as snapshot from "./snapshot.js";

export const ForkProtocolSchemas = {
  ActivityCursor: activity.ActivityCursorSchema,
  ActivityEventDetail: activity.ActivityEventDetailSchema,
  ActivityEventMetrics: activity.ActivityEventMetricsSchema,
  ActivityEvent: activity.ActivityEventSchema,
  ActivityListParams: activity.ActivityListParamsSchema,
  ActivityListResult: activity.ActivityListResultSchema,
  ActivitySubscribeParams: activity.ActivitySubscribeParamsSchema,
  ActivitySubscribeResult: activity.ActivitySubscribeResultSchema,
  ActivityUnsubscribeParams: activity.ActivityUnsubscribeParamsSchema,
  GatewaySessionRow: session_row.GatewaySessionRowSchema,
  GatewaySessionsDefaults: session_row.GatewaySessionsDefaultsSchema,
  SessionGoal: session_row.SessionGoalSchema,
  GatewayAgentRuntime: session_row.GatewayAgentRuntimeSchema,
  DeliveryContext: session_row.DeliveryContextSchema,
  SessionsListResult: session_row.SessionsListResultSchema,
  SessionsChangedEvent: session_row.SessionsChangedEventSchema,
  SessionMessageEvent: session_row.SessionMessageEventSchema,
  ExecApprovalDecision: exec_approvals.ExecApprovalDecisionSchema,
  ExecApprovalCommandSpan: exec_approvals.ExecApprovalCommandSpanSchema,
  CommandExplanationSummary: exec_approvals.CommandExplanationSummarySchema,
  SystemRunApprovalFileOperand: exec_approvals.SystemRunApprovalFileOperandSchema,
  SystemRunApprovalPlan: exec_approvals.SystemRunApprovalPlanSchema,
  SystemRunApprovalBinding: exec_approvals.SystemRunApprovalBindingSchema,
  ExecApprovalRequestPayload: exec_approvals.ExecApprovalRequestPayloadSchema,
  ExecApprovalRequestedEvent: exec_approvals.ExecApprovalRequestedEventSchema,
  ExecApprovalResolvedEvent: exec_approvals.ExecApprovalResolvedEventSchema,
  PluginApprovalActionView: plugin_approvals.PluginApprovalActionViewSchema,
  PluginApprovalRequestPayload: plugin_approvals.PluginApprovalRequestPayloadSchema,
  PluginApprovalRequestedEvent: plugin_approvals.PluginApprovalRequestedEventSchema,
  PluginApprovalResolvedEvent: plugin_approvals.PluginApprovalResolvedEventSchema,
  ChatSendTimingEvent: logs_chat.ChatSendTimingEventSchema,
  ChatSideResultEvent: logs_chat.ChatSideResultEventSchema,
  PresenceEvent: snapshot.PresenceEventSchema,
  UpdateAvailableEvent: snapshot.UpdateAvailableEventSchema,
} as const;
