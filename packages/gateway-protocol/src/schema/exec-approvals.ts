import type { Static } from "typebox";
// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { ApprovalChannelReviewerSchema, ApprovalScopeSchema } from "./approvals.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Exec approval protocol schemas.
 *
 * These payloads cross the security-review boundary for command execution, so
 * persisted policy, request snapshots, and resolve decisions stay explicit.
 */
/** One persisted allowlist entry for a command pattern or resolved executable. */
const ExecApprovalsAllowlistEntrySchema = closedObject({
  id: Type.Optional(NonEmptyString),
  pattern: Type.String(),
  source: Type.Optional(Type.Literal("allow-always")),
  commandText: Type.Optional(Type.String()),
  argPattern: Type.Optional(Type.String()),
  lastUsedAt: Type.Optional(Type.Number({ minimum: 0 })),
  lastUsedCommand: Type.Optional(Type.String()),
  lastResolvedPath: Type.Optional(Type.String()),
});

const ExecApprovalsPolicyFields = {
  security: Type.Optional(Type.String()),
  ask: Type.Optional(Type.String()),
  askFallback: Type.Optional(Type.String()),
  autoAllowSkills: Type.Optional(Type.Boolean()),
};

const ExecSecuritySchema = Type.Union([
  Type.Literal("deny"),
  Type.Literal("allowlist"),
  Type.Literal("full"),
]);
const ExecAskSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("on-miss"),
  Type.Literal("always"),
]);

/** Host-resolved default policy after applying persisted defaults and runtime fallbacks. */
const ExecApprovalsResolvedDefaultsSchema = closedObject({
  security: ExecSecuritySchema,
  ask: ExecAskSchema,
  askFallback: ExecSecuritySchema,
  autoAllowSkills: Type.Boolean(),
});

/** Default exec approval policy shared by all agents unless overridden. */
const ExecApprovalsDefaultsSchema = closedObject(ExecApprovalsPolicyFields);

/** Agent-specific exec approval policy and allowlist. */
const ExecApprovalsAgentSchema = closedObject({
  ...ExecApprovalsPolicyFields,
  allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema)),
});

/** Versioned exec approvals config file edited through gateway APIs. */
const ExecApprovalsFileSchema = closedObject({
  version: Type.Literal(1),
  socket: Type.Optional(
    closedObject({
      path: Type.Optional(Type.String()),
      token: Type.Optional(Type.String()),
    }),
  ),
  defaults: Type.Optional(ExecApprovalsDefaultsSchema),
  agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema)),
});

/** File-backed read snapshot with path/hash metadata for optimistic writes. */
export const ExecApprovalsSnapshotSchema = closedObject({
  path: NonEmptyString,
  exists: Type.Boolean(),
  hash: NonEmptyString,
  file: ExecApprovalsFileSchema,
  resolvedDefaults: Type.Optional(ExecApprovalsResolvedDefaultsSchema),
});

const NativeExecApprovalActionSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
  Type.Literal("prompt"),
]);

/** One rule owned and enforced by a host-native exec policy implementation. */
const NativeExecApprovalRuleSchema = closedObject({
  pattern: NonEmptyString,
  action: NativeExecApprovalActionSchema,
  shells: Type.Optional(Type.Array(NonEmptyString)),
  description: Type.Optional(Type.String()),
  enabled: Type.Optional(Type.Boolean()),
});

const NativeExecApprovalConstraintsSchema = closedObject({
  baseHashRequired: Type.Optional(Type.Boolean()),
  defaultAllowAllowed: Type.Optional(Type.Boolean()),
  broadAllowRulesAllowed: Type.Optional(Type.Boolean()),
  dangerousAllowRulesAllowed: Type.Optional(Type.Boolean()),
});

/** Node read snapshot supporting file-backed and host-native approval owners. */
export const ExecApprovalsNodeSnapshotSchema = Type.Object(
  {
    path: Type.Optional(Type.String()),
    exists: Type.Optional(Type.Boolean()),
    hash: Type.Optional(Type.String()),
    file: Type.Optional(ExecApprovalsFileSchema),
    resolvedDefaults: Type.Optional(ExecApprovalsResolvedDefaultsSchema),
    enabled: Type.Optional(Type.Boolean()),
    baseHash: Type.Optional(NonEmptyString),
    defaultAction: Type.Optional(NativeExecApprovalActionSchema),
    rules: Type.Optional(Type.Array(NativeExecApprovalRuleSchema)),
    constraints: Type.Optional(NativeExecApprovalConstraintsSchema),
    message: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
    oneOf: [
      {
        required: ["path", "exists", "hash", "file"],
        not: {
          anyOf: [
            { required: ["enabled"] },
            { required: ["baseHash"] },
            { required: ["defaultAction"] },
            { required: ["rules"] },
            { required: ["constraints"] },
            { required: ["message"] },
          ],
        },
      },
      {
        properties: { enabled: { const: true }, hash: { minLength: 1 } },
        required: ["enabled", "hash", "defaultAction", "rules"],
        not: {
          anyOf: [
            { required: ["path"] },
            { required: ["exists"] },
            { required: ["file"] },
            { required: ["resolvedDefaults"] },
            { required: ["message"] },
          ],
        },
      },
      {
        properties: { enabled: { const: false } },
        required: ["enabled"],
        not: {
          anyOf: [
            { required: ["path"] },
            { required: ["exists"] },
            { required: ["hash"] },
            { required: ["file"] },
            { required: ["resolvedDefaults"] },
            { required: ["baseHash"] },
            { required: ["defaultAction"] },
            { required: ["rules"] },
            { required: ["constraints"] },
          ],
        },
      },
    ],
  },
);

/** Empty request payload for reading local exec approval policy. */
export const ExecApprovalsGetParamsSchema = closedObject({});

/** Local exec approval policy write request with optional base hash guard. */
export const ExecApprovalsSetParamsSchema = closedObject({
  file: ExecApprovalsFileSchema,
  baseHash: Type.Optional(NonEmptyString),
});

/** Node-scoped request payload for reading exec approval policy. */
export const ExecApprovalsNodeGetParamsSchema = closedObject({
  nodeId: NonEmptyString,
});

/** Writable host-native policy fields; the node remains the validation authority. */
const NativeExecApprovalPolicySchema = closedObject({
  defaultAction: Type.Optional(NativeExecApprovalActionSchema),
  // Windows treats set as full replacement; omission would silently clear the rule list.
  rules: Type.Array(NativeExecApprovalRuleSchema),
});

/** Node-scoped write for exactly one file-backed or host-native approval owner. */
export const ExecApprovalsNodeSetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    file: Type.Optional(ExecApprovalsFileSchema),
    native: Type.Optional(NativeExecApprovalPolicySchema),
    baseHash: Type.Optional(NonEmptyString),
  },
  {
    additionalProperties: false,
    oneOf: [
      { required: ["file"], not: { required: ["native"] } },
      {
        required: ["native", "baseHash"],
        not: { required: ["file"] },
      },
    ],
  },
);

/** Lookup request for one pending exec approval by id. */
export const ExecApprovalGetParamsSchema = closedObject({
  id: NonEmptyString,
});

const ExecApprovalPolicySecuritySchema = Type.Union([
  Type.Literal("deny"),
  Type.Literal("allowlist"),
  Type.Literal("full"),
]);

const ExecApprovalPolicySnapshotSchema = closedObject({
  security: ExecApprovalPolicySecuritySchema,
  ask: Type.Union([Type.Literal("off"), Type.Literal("on-miss"), Type.Literal("always")]),
  askFallback: ExecApprovalPolicySecuritySchema,
  autoAllowSkills: Type.Boolean(),
  allowlistRules: Type.Array(
    closedObject({
      pattern: Type.String(),
      argPattern: Type.Optional(Type.String()),
      source: Type.Optional(Type.Literal("allow-always")),
    }),
  ),
});

/** Reviewer decision for an exec or plugin approval. */
export const ExecApprovalDecisionSchema = Type.Union([
  Type.Literal("allow-once"),
  Type.Literal("allow-always"),
  Type.Literal("deny"),
]);

/** Highlighted span of the command string shown to reviewers. */
export const ExecApprovalCommandSpanSchema = Type.Object(
  {
    startIndex: Type.Integer({
      minimum: 0,
      description: "Inclusive UTF-16 code unit offset into command.",
    }),
    endIndex: Type.Integer({
      minimum: 1,
      description:
        "Exclusive UTF-16 code unit offset into command; must be greater than startIndex and no greater than command.length.",
    }),
  },
  { additionalProperties: false },
);

/** Static command analysis summary attached to approval prompts. */
export const CommandExplanationSummarySchema = Type.Object(
  {
    commandCount: Type.Number(),
    nestedCommandCount: Type.Number(),
    riskKinds: Type.Array(Type.String()),
    warningLines: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

/** Mutable file operand captured for two-phase system-run approvals. */
export const SystemRunApprovalFileOperandSchema = Type.Object(
  {
    argvIndex: Type.Integer({ minimum: 0 }),
    path: Type.String(),
    sha256: Type.String(),
  },
  { additionalProperties: false },
);

/** Planned system-run invocation pending reviewer approval. */
export const SystemRunApprovalPlanSchema = Type.Object(
  {
    argv: Type.Array(Type.String()),
    cwd: Type.Union([Type.String(), Type.Null()]),
    commandText: Type.String(),
    commandPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    agentId: Type.Union([Type.String(), Type.Null()]),
    sessionKey: Type.Union([Type.String(), Type.Null()]),
    policySnapshot: Type.Optional(ExecApprovalPolicySnapshotSchema),
    mutableFileOperand: Type.Optional(
      Type.Union([SystemRunApprovalFileOperandSchema, Type.Null()]),
    ),
  },
  { additionalProperties: false },
);

/** Approved system-run binding replayed when the command executes. */
export const SystemRunApprovalBindingSchema = Type.Object(
  {
    argv: Type.Array(Type.String()),
    cwd: Type.Union([Type.String(), Type.Null()]),
    agentId: Type.Union([Type.String(), Type.Null()]),
    sessionKey: Type.Union([Type.String(), Type.Null()]),
    envHash: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** Reviewer-facing snapshot of one pending exec approval request. */
export const ExecApprovalRequestPayloadSchema = Type.Object(
  {
    command: Type.String(),
    commandPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    commandArgv: Type.Optional(Type.Array(Type.String())),
    envKeys: Type.Optional(Type.Array(Type.String())),
    systemRunBinding: Type.Optional(Type.Union([SystemRunApprovalBindingSchema, Type.Null()])),
    systemRunPlan: Type.Optional(Type.Union([SystemRunApprovalPlanSchema, Type.Null()])),
    cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    nodeId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    warningText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    commandAnalysis: Type.Optional(Type.Union([CommandExplanationSummarySchema, Type.Null()])),
    commandSpans: Type.Optional(Type.Array(ExecApprovalCommandSpanSchema)),
    // Immutable keeps the schema-derived field `readonly`, matching the
    // server-side payload types that freeze the decision set after build.
    allowedDecisions: Type.Optional(Type.Immutable(Type.Array(ExecApprovalDecisionSchema))),
    unavailableDecisions: Type.Optional(
      Type.Immutable(Type.Array(Type.String({ enum: ["allow-always"] }))),
    ),
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    runId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    toolCallId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
  },
  { additionalProperties: false },
);

/** Broadcast when a command approval starts waiting on a reviewer. */
export const ExecApprovalRequestedEventSchema = Type.Object(
  {
    id: NonEmptyString,
    request: ExecApprovalRequestPayloadSchema,
    createdAtMs: Type.Number(),
    expiresAtMs: Type.Number(),
  },
  { additionalProperties: false },
);

/** Broadcast when a pending exec approval is decided or expires. */
export const ExecApprovalResolvedEventSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: ExecApprovalDecisionSchema,
    resolvedBy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    ts: Type.Number(),
    request: Type.Optional(ExecApprovalRequestPayloadSchema),
  },
  { additionalProperties: false },
);

/** Pending command execution approval request shown to reviewers. */
export const ExecApprovalRequestParamsSchema = closedObject({
  id: Type.Optional(NonEmptyString),
  command: Type.Optional(NonEmptyString),
  commandArgv: Type.Optional(Type.Array(Type.String())),
  systemRunPlan: Type.Optional(SystemRunApprovalPlanSchema),
  env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  nodeId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  warningText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scope: Type.Optional(ApprovalScopeSchema),
  unavailableDecisions: Type.Optional(
    Type.Array(Type.String({ enum: ["allow-always"] }), {
      minItems: 1,
      maxItems: 1,
    }),
  ),
  // Named span/plan schemas above stay the canonical shapes; upstream inlines
  // identical closedObject bodies here, so keep the single-declaration refs.
  commandSpans: Type.Optional(Type.Array(ExecApprovalCommandSpanSchema)),
  agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sessionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  runId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  toolCallId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Null()])),
  approvalReviewerDeviceIds: Type.Optional(
    Type.Array(NonEmptyString, {
      description:
        "Trusted approval-runtime metadata naming operator devices that may review this approval; ordinary Gateway clients may send the field, but the Gateway only binds it for internal approval-runtime requests.",
    }),
  ),
  requireDeliveryRoute: Type.Optional(Type.Boolean()),
  suppressDelivery: Type.Optional(Type.Boolean()),
  deliverToApprovalClientsOnly: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  twoPhase: Type.Optional(Type.Boolean()),
});

/** Reviewer decision payload for one pending exec approval. */
export const ExecApprovalResolveParamsSchema = closedObject({
  id: NonEmptyString,
  decision: NonEmptyString,
  reviewer: Type.Optional(ApprovalChannelReviewerSchema),
  // Per-grant expiry override for allow-always on automation approvals:
  // days from resolution. Absent defers to tools.exec.grantExpiryDays, and
  // an unset config keeps the grant valid until revoked. Ignored for other
  // decisions and non-grant approvals.
  grantExpiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650 })),
});

/** Operator listing filter for standing grants; bounded for prompt-safe output. */
export const ExecApprovalGrantsListParamsSchema = closedObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});

/** One standing grant projected for operator surfaces. */
export const ExecApprovalStandingGrantSchema = closedObject({
  grantId: NonEmptyString,
  mintedByApprovalId: NonEmptyString,
  agentId: NonEmptyString,
  cronJobId: NonEmptyString,
  cronJobName: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  command: Type.String({ minLength: 1, maxLength: 512 }),
  cwd: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  createdAtMs: Type.Integer({ minimum: 0 }),
  expiresAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  revokedAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  revokedBy: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
  lastUsedAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  useCount: Type.Integer({ minimum: 0 }),
});

export const ExecApprovalGrantsListResultSchema = closedObject({
  grants: Type.Array(ExecApprovalStandingGrantSchema, { maxItems: 500 }),
});

export const ExecApprovalGrantsRevokeParamsSchema = closedObject({
  grantId: NonEmptyString,
});

export const ExecApprovalGrantsRevokeResultSchema = closedObject({
  outcome: Type.Union([
    Type.Literal("revoked"),
    Type.Literal("already-revoked"),
    Type.Literal("not-found"),
  ]),
});

// Owner-local wire types derived directly from local schema consts so the
// public plugin-sdk declaration graph never pulls in the ProtocolSchemas registry.
export type ExecApprovalsGetParams = Static<typeof ExecApprovalsGetParamsSchema>;
export type ExecApprovalsSetParams = Static<typeof ExecApprovalsSetParamsSchema>;
export type ExecApprovalsNodeGetParams = Static<typeof ExecApprovalsNodeGetParamsSchema>;
export type ExecApprovalsNodeSnapshot = Static<typeof ExecApprovalsNodeSnapshotSchema>;
export type ExecApprovalsNodeSetParams = Static<typeof ExecApprovalsNodeSetParamsSchema>;
export type ExecApprovalsSnapshot = Static<typeof ExecApprovalsSnapshotSchema>;
export type ExecApprovalGetParams = Static<typeof ExecApprovalGetParamsSchema>;
export type ExecApprovalRequestParams = Static<typeof ExecApprovalRequestParamsSchema>;
export type ExecApprovalResolveParams = Static<typeof ExecApprovalResolveParamsSchema>;
export type ExecApprovalDecision = Static<typeof ExecApprovalDecisionSchema>;
export type ExecApprovalCommandSpan = Static<typeof ExecApprovalCommandSpanSchema>;
export type CommandExplanationSummary = Static<typeof CommandExplanationSummarySchema>;
export type SystemRunApprovalFileOperand = Static<typeof SystemRunApprovalFileOperandSchema>;
export type SystemRunApprovalPlan = Static<typeof SystemRunApprovalPlanSchema>;
export type SystemRunApprovalBinding = Static<typeof SystemRunApprovalBindingSchema>;
export type ExecApprovalRequestPayload = Static<typeof ExecApprovalRequestPayloadSchema>;
export type ExecApprovalRequestedEvent = Static<typeof ExecApprovalRequestedEventSchema>;
export type ExecApprovalResolvedEvent = Static<typeof ExecApprovalResolvedEventSchema>;
export type ExecApprovalGrantsListParams = Static<typeof ExecApprovalGrantsListParamsSchema>;
export type ExecApprovalStandingGrant = Static<typeof ExecApprovalStandingGrantSchema>;
export type ExecApprovalGrantsListResult = Static<typeof ExecApprovalGrantsListResultSchema>;
export type ExecApprovalGrantsRevokeParams = Static<typeof ExecApprovalGrantsRevokeParamsSchema>;
export type ExecApprovalGrantsRevokeResult = Static<typeof ExecApprovalGrantsRevokeResultSchema>;
