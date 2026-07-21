import type { Static } from "typebox";
import { Type } from "typebox";
import { ChatSendSessionKeyString, InputProvenanceSchema, NonEmptyString } from "./primitives.js";

export const LogsTailParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  },
  { additionalProperties: false },
);

export const LogsTailResultSchema = Type.Object(
  {
    file: NonEmptyString,
    cursor: Type.Integer({ minimum: 0 }),
    size: Type.Integer({ minimum: 0 }),
    lines: Type.Array(Type.String()),
    truncated: Type.Optional(Type.Boolean()),
    reset: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

// WebChat/WebSocket-native chat methods
export const ChatHistoryParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    // Keep in sync with the chat.history handler's hardMax (whole-history UI
    // requests the full transcript window in one response).
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 500_000 })),
  },
  { additionalProperties: false },
);

/** Lightweight chat metadata request; optional agent scope keeps selector state explicit. */
export const ChatMetadataParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Batched purpose-title request for tool calls rendered in the Control UI. */
export const ChatToolTitlesParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    items: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1, maxLength: 64 }),
          name: Type.String({ minLength: 1, maxLength: 200 }),
          input: Type.String({ minLength: 1, maxLength: 4_000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 24 },
    ),
  },
  { additionalProperties: false },
);
export type ChatToolTitlesParams = Static<typeof ChatToolTitlesParamsSchema>;

/**
 * Titles keyed by the caller-provided item id; missing ids mean no title.
 * `disabled: true` tells clients the gateway has tool titles switched off so
 * they stop requesting for the rest of the session.
 */
export const ChatToolTitlesResultSchema = Type.Object(
  {
    titles: Type.Record(Type.String(), Type.String()),
    disabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
/** Typed result shape for tool-title consumers. */
export type ChatToolTitlesResult = Static<typeof ChatToolTitlesResultSchema>;

export const ChatMessageGetParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    messageId: NonEmptyString,
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000_000 })),
  },
  { additionalProperties: false },
);

export const ChatMessageGetResultSchema = Type.Object(
  {
    ok: Type.Boolean(),
    message: Type.Optional(Type.Unknown()),
    unavailableReason: Type.Optional(
      Type.Union([
        Type.Literal("not_found"),
        Type.Literal("oversized"),
        Type.Literal("not_visible"),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type ChatMessageGetResult = Static<typeof ChatMessageGetResultSchema>;

// Additive upstream export: sessions-create.ts (upstream module) imports this
// attachment array shape; the fork-frozen file must still provide it.
export const ChatAttachmentsSchema = Type.Array(Type.Unknown());

export const ChatSendParamsSchema = Type.Object(
  {
    sessionKey: ChatSendSessionKeyString,
    agentId: Type.Optional(NonEmptyString),
    sessionId: Type.Optional(NonEmptyString),
    message: Type.String(),
    thinking: Type.Optional(Type.String()),
    fastMode: Type.Optional(Type.Boolean()),
    deliver: Type.Optional(Type.Boolean()),
    originatingChannel: Type.Optional(Type.String()),
    originatingTo: Type.Optional(Type.String()),
    originatingAccountId: Type.Optional(Type.String()),
    originatingThreadId: Type.Optional(Type.String()),
    attachments: Type.Optional(Type.Array(Type.Unknown())),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
    systemInputProvenance: Type.Optional(InputProvenanceSchema),
    systemProvenanceReceipt: Type.Optional(Type.String()),
    // Treat the message as literal text even when it looks like a slash command;
    // the chat.send handler honors it, so the schema must admit it or the
    // strict additionalProperties gate rejects the whole send.
    suppressCommandInterpretation: Type.Optional(Type.Boolean()),
    idempotencyKey: NonEmptyString,
  },
  { additionalProperties: false },
);

export const ChatAbortParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

export const ChatInjectParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    message: NonEmptyString,
    label: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);

/** Server-side phase markers for operator chat.send timing diagnostics. */
const ChatSendTimingPhaseSchema = Type.Union([
  Type.Literal("dispatch-started"),
  Type.Literal("model-selected"),
  Type.Literal("agent-run-started"),
  Type.Literal("dispatch-completed"),
  Type.Literal("post-dispatch-completed"),
]);

/** Payload broadcast on `chat.send_timing` to the operator UI that issued the send. */
export const ChatSendTimingEventSchema = Type.Object(
  {
    phase: ChatSendTimingPhaseSchema,
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    ackToPhaseMs: Type.Number({ minimum: 0 }),
    receivedToPhaseMs: Type.Number({ minimum: 0 }),
    dispatchStartedToPhaseMs: Type.Optional(Type.Number({ minimum: 0 })),
    postDispatchMs: Type.Optional(Type.Number({ minimum: 0 })),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    agentRunId: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);

/** Payload broadcast on `chat.side_result` for side-channel run output (btw answers). */
export const ChatSideResultEventSchema = Type.Object(
  {
    kind: Type.Literal("btw"),
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
    question: Type.String(),
    text: Type.String(),
    isError: Type.Optional(Type.Boolean()),
    ts: Type.Integer({ minimum: 0 }),
    seq: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const ChatEventBaseSchema = {
  runId: NonEmptyString,
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  spawnedBy: Type.Optional(NonEmptyString),
  seq: Type.Integer({ minimum: 0 }),
};

const ChatEventErrorKindSchema = Type.Union([
  Type.Literal("refusal"),
  Type.Literal("timeout"),
  Type.Literal("rate_limit"),
  Type.Literal("context_length"),
  Type.Literal("unknown"),
]);

export const ChatDeltaEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("delta"),
    message: Type.Optional(Type.Unknown()),
    deltaText: Type.String(),
    deltaThinking: Type.Optional(Type.String()),
    replace: Type.Optional(Type.Boolean()),
    usage: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export const ChatFinalEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("final"),
    message: Type.Optional(Type.Unknown()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChatAbortedEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("aborted"),
    message: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChatErrorEventSchema = Type.Object(
  {
    ...ChatEventBaseSchema,
    state: Type.Literal("error"),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    errorKind: Type.Optional(ChatEventErrorKindSchema),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ChatEventSchema = Type.Union([
  ChatDeltaEventSchema,
  ChatFinalEventSchema,
  ChatAbortedEventSchema,
  ChatErrorEventSchema,
]);

// Owner-local wire types derived directly from local schema consts so the
// public plugin-sdk declaration graph never pulls in the ProtocolSchemas registry.
export type LogsTailParams = Static<typeof LogsTailParamsSchema>;
export type LogsTailResult = Static<typeof LogsTailResultSchema>;
export type ChatMetadataParams = Static<typeof ChatMetadataParamsSchema>;
export type ChatAbortParams = Static<typeof ChatAbortParamsSchema>;
export type ChatInjectParams = Static<typeof ChatInjectParamsSchema>;
export type ChatEvent = Static<typeof ChatEventSchema>;
export type ChatSendTimingEvent = Static<typeof ChatSendTimingEventSchema>;
/** Server-side phase markers for operator chat.send timing diagnostics. */
export type ChatSendTimingPhase = ChatSendTimingEvent["phase"];
export type ChatSideResultEvent = Static<typeof ChatSideResultEventSchema>;
