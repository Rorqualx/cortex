// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Exec approval protocol schemas.
 *
 * These payloads cross the security-review boundary for command execution, so
 * persisted policy, request snapshots, and resolve decisions stay explicit.
 */
/** One persisted allowlist entry for a command pattern or resolved executable. */
export const ExecApprovalsAllowlistEntrySchema = Type.Object(
  {
    id: Type.Optional(NonEmptyString),
    pattern: Type.String(),
    source: Type.Optional(Type.Literal("allow-always")),
    commandText: Type.Optional(Type.String()),
    argPattern: Type.Optional(Type.String()),
    lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
    lastUsedCommand: Type.Optional(Type.String()),
    lastResolvedPath: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ExecApprovalsPolicyFields = {
  security: Type.Optional(Type.String()),
  ask: Type.Optional(Type.String()),
  askFallback: Type.Optional(Type.String()),
  autoAllowSkills: Type.Optional(Type.Boolean()),
};

/** Default exec approval policy shared by all agents unless overridden. */
export const ExecApprovalsDefaultsSchema = Type.Object(ExecApprovalsPolicyFields, {
  additionalProperties: false,
});

/** Agent-specific exec approval policy and allowlist. */
export const ExecApprovalsAgentSchema = Type.Object(
  {
    ...ExecApprovalsPolicyFields,
    allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema)),
  },
  { additionalProperties: false },
);

/** Versioned exec approvals config file edited through gateway APIs. */
export const ExecApprovalsFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    socket: Type.Optional(
      Type.Object(
        {
          path: Type.Optional(Type.String()),
          token: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    defaults: Type.Optional(ExecApprovalsDefaultsSchema),
    agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema)),
  },
  { additionalProperties: false },
);

/** Read snapshot with path/hash metadata for optimistic writes. */
export const ExecApprovalsSnapshotSchema = Type.Object(
  {
    path: NonEmptyString,
    exists: Type.Boolean(),
    hash: NonEmptyString,
    file: ExecApprovalsFileSchema,
  },
  { additionalProperties: false },
);

/** Empty request payload for reading local exec approval policy. */
export const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });

/** Local exec approval policy write request with optional base hash guard. */
export const ExecApprovalsSetParamsSchema = Type.Object(
  {
    file: ExecApprovalsFileSchema,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Node-scoped request payload for reading exec approval policy. */
export const ExecApprovalsNodeGetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Node-scoped exec approval policy write request with optional base hash guard. */
export const ExecApprovalsNodeSetParamsSchema = Type.Object(
  {
    nodeId: NonEmptyString,
    file: ExecApprovalsFileSchema,
    baseHash: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Lookup request for one pending exec approval by id. */
export const ExecApprovalGetParamsSchema = Type.Object(
  {
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

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
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
export const ExecApprovalRequestParamsSchema = Type.Object(
  {
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
    // ENHANCE-OURS: adopt upstream's unavailableDecisions; keep our named
    // ExecApprovalCommandSpanSchema ref (defined above, reused at line ~203).
    unavailableDecisions: Type.Optional(
      Type.Array(Type.String({ enum: ["allow-always"] }), {
        minItems: 1,
        maxItems: 1,
      }),
    ),
    commandSpans: Type.Optional(Type.Array(ExecApprovalCommandSpanSchema)),
    agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    twoPhase: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Reviewer decision payload for one pending exec approval. */
export const ExecApprovalResolveParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    decision: NonEmptyString,
  },
  { additionalProperties: false },
);
