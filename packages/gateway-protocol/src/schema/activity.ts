// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

/**
 * Activity feed protocol schemas.
 *
 * The Control UI Activity view is a persistent, cross-agent feed. The gateway
 * records a curated projection of agent events (tool/command/patch/approval/
 * plan/lifecycle/usage and subagent + media completions) into the shared state
 * DB, then serves history via `activity.list` and live updates via the
 * `activity.event` broadcast gated behind `activity.subscribe`.
 *
 * `kind`/`status` stay free strings (not unions) so the recorder can introduce
 * new step kinds without a protocol bump; the UI maps unknown values to a
 * generic presentation.
 */

/** Redacted, render-ready detail for one activity step. */
export const ActivityEventDetailSchema = Type.Object(
  {
    /** One-line "what happened" (e.g. command, file path) — already redacted. */
    summary: Type.Optional(Type.String()),
    /** Multi-line redacted output/result preview. */
    preview: Type.Optional(Type.String()),
    /** True when preview was truncated/redacted. */
    truncated: Type.Optional(Type.Boolean()),
    /** Model ref active for the run (provider/model). */
    model: Type.Optional(Type.String()),
    /** Process exit code for command-style steps. */
    exitCode: Type.Optional(Type.Integer()),
    /** Error text for failed steps. */
    error: Type.Optional(Type.String()),
    /** Approval id/slug for approval steps. */
    approvalId: Type.Optional(Type.String()),
    /** Free-form secondary label (e.g. item meta). */
    meta: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Token/cost/duration rollup attached to a step or run. */
export const ActivityEventMetricsSchema = Type.Object(
  {
    durationMs: Type.Optional(Type.Number()),
    inputTokens: Type.Optional(Type.Number()),
    outputTokens: Type.Optional(Type.Number()),
    cacheReadTokens: Type.Optional(Type.Number()),
    cacheWriteTokens: Type.Optional(Type.Number()),
    costUsd: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

/** A single activity event, as persisted and streamed to the Control UI. */
export const ActivityEventSchema = Type.Object(
  {
    eventId: NonEmptyString,
    ts: Type.Integer({ minimum: 0 }),
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    runId: Type.Optional(NonEmptyString),
    /** Collapses steps under one run card (usually the run id). */
    groupKey: Type.Optional(NonEmptyString),
    kind: NonEmptyString,
    status: NonEmptyString,
    title: Type.String(),
    detail: Type.Optional(ActivityEventDetailSchema),
    metrics: Type.Optional(ActivityEventMetricsSchema),
  },
  { additionalProperties: false },
);

/** Keyset cursor for paging older events (ts + id of the last seen row). */
export const ActivityCursorSchema = Type.Object(
  {
    ts: Type.Integer({ minimum: 0 }),
    id: NonEmptyString,
  },
  { additionalProperties: false },
);

/** Query a page of activity history, newest first. */
export const ActivityListParamsSchema = Type.Object(
  {
    agentIds: Type.Optional(Type.Array(NonEmptyString)),
    kinds: Type.Optional(Type.Array(NonEmptyString)),
    statuses: Type.Optional(Type.Array(NonEmptyString)),
    /** Only events at or after this ms timestamp. */
    since: Type.Optional(Type.Integer({ minimum: 0 })),
    /** Case-insensitive substring match on title + detail. */
    search: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(ActivityCursorSchema),
  },
  { additionalProperties: false },
);

export const ActivityListResultSchema = Type.Object(
  {
    events: Type.Array(ActivityEventSchema),
    nextCursor: Type.Optional(ActivityCursorSchema),
  },
  { additionalProperties: false },
);

/** Subscribe the calling connection to the live `activity.event` broadcast. */
export const ActivitySubscribeParamsSchema = Type.Object({}, { additionalProperties: false });

export const ActivitySubscribeResultSchema = Type.Object(
  {
    subscribed: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** Remove the live activity subscription for the calling connection. */
export const ActivityUnsubscribeParamsSchema = Type.Object({}, { additionalProperties: false });
