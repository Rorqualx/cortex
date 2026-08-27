import type { Static } from "typebox";
// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { ApprovalChannelReviewerSchema, ApprovalScopeSchema } from "./approvals.js";
import { closedObject } from "./closed-object.js";
import { ExecApprovalDecisionSchema } from "./exec-approvals.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Plugin approval schemas.
 *
 * These payloads cross from plugin/tool execution into reviewer-facing UI, so
 * title, description, decision set, and timeout limits are part of the public
 * gateway contract.
 */
const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;
const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 512;

/** Approval request raised by a plugin before a sensitive tool action proceeds. */
export const PluginApprovalRequestParamsSchema = closedObject({
  pluginId: Type.Optional(NonEmptyString),
  title: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_TITLE_MAX_LENGTH }),
  description: Type.String({ minLength: 1, maxLength: PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH }),
  detail: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 16_384,
      description: "Reviewer-surface-only detail; not delivered to channels or push notifications.",
    }),
  ),
  severity: Type.Optional(Type.String({ enum: ["info", "warning", "critical"] })),
  scope: Type.Optional(ApprovalScopeSchema),
  toolName: Type.Optional(Type.String()),
  toolCallId: Type.Optional(Type.String()),
  allowedDecisions: Type.Optional(
    Type.Array(Type.String({ enum: ["allow-once", "allow-always", "deny"] }), {
      minItems: 1,
      maxItems: 3,
    }),
  ),
  agentId: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
  approvalReviewerDeviceIds: Type.Optional(
    Type.Array(NonEmptyString, {
      description:
        "Trusted approval-runtime metadata naming operator devices that may review this approval; ordinary Gateway clients may send the field, but the Gateway only binds it for internal approval-runtime requests.",
    }),
  ),
  turnSourceChannel: Type.Optional(Type.String()),
  turnSourceTo: Type.Optional(Type.String()),
  turnSourceAccountId: Type.Optional(Type.String()),
  turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PLUGIN_APPROVAL_TIMEOUT_MS })),
  twoPhase: Type.Optional(Type.Boolean()),
});

/** Reviewer decision payload resolving one pending plugin approval request. */
export const PluginApprovalResolveParamsSchema = closedObject({
  id: NonEmptyString,
  decision: NonEmptyString,
  reviewer: Type.Optional(ApprovalChannelReviewerSchema),
});

/** One reviewer action button advertised with a plugin approval prompt. */
export const PluginApprovalActionViewSchema = Type.Object(
  {
    kind: Type.Optional(Type.Union([Type.Literal("command"), Type.Literal("decision")])),
    label: Type.String(),
    command: Type.String(),
    decision: Type.Optional(ExecApprovalDecisionSchema),
    style: Type.Optional(
      Type.Union([
        Type.Literal("primary"),
        Type.Literal("secondary"),
        Type.Literal("success"),
        Type.Literal("danger"),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Reviewer-facing snapshot of one pending plugin approval request. */
export const PluginApprovalRequestPayloadSchema = Type.Object(
  {
    pluginId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    title: Type.String(),
    description: Type.String(),
    // Reviewer-surface-only; approval forwarders must strip this before any
    // channel message or push alert (see exec-approval-ios-push redaction).
    detail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    severity: Type.Optional(
      Type.Union([
        Type.Literal("info"),
        Type.Literal("warning"),
        Type.Literal("critical"),
        Type.Null(),
      ]),
    ),
    // Owner-declared blast-radius facts; display-only, never authorization.
    scope: Type.Optional(Type.Union([ApprovalScopeSchema, Type.Null()])),
    toolName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    toolCallId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    // Immutable keeps the schema-derived fields `readonly`, matching the
    // server-side payload types that freeze these views after build.
    allowedDecisions: Type.Optional(
      Type.Union([Type.Immutable(Type.Array(ExecApprovalDecisionSchema)), Type.Null()]),
    ),
    actions: Type.Optional(
      Type.Union([Type.Immutable(Type.Array(PluginApprovalActionViewSchema)), Type.Null()]),
    ),
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
  },
  { additionalProperties: false },
);

/** Broadcast when a plugin approval starts waiting on a reviewer. */
export const PluginApprovalRequestedEventSchema = Type.Object(
  {
    id: NonEmptyString,
    request: PluginApprovalRequestPayloadSchema,
    createdAtMs: Type.Number(),
    expiresAtMs: Type.Number(),
  },
  { additionalProperties: false },
);

/** Broadcast when a pending plugin approval is decided or expires. */
export const PluginApprovalResolvedEventSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: ExecApprovalDecisionSchema,
    resolvedBy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ts: Type.Number(),
    request: Type.Optional(PluginApprovalRequestPayloadSchema),
  },
  { additionalProperties: false },
);

// Owner-local wire types derived directly from local schema consts so the
// public plugin-sdk declaration graph never pulls in the ProtocolSchemas registry.
export type PluginApprovalRequestParams = Static<typeof PluginApprovalRequestParamsSchema>;
export type PluginApprovalResolveParams = Static<typeof PluginApprovalResolveParamsSchema>;
export type PluginApprovalActionView = Static<typeof PluginApprovalActionViewSchema>;
export type PluginApprovalRequestPayload = Static<typeof PluginApprovalRequestPayloadSchema>;
export type PluginApprovalRequestedEvent = Static<typeof PluginApprovalRequestedEventSchema>;
export type PluginApprovalResolvedEvent = Static<typeof PluginApprovalResolvedEventSchema>;
