// Control UI controller for the cross-agent activity feed. Backfills history via
// `activity.list`, subscribes to the live `activity.event` broadcast, and merges
// both into a single newest-first event list the Activity view renders.
import { mergeActivityEvents } from "../activity-model.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ActivityCursor, ActivityEvent, ActivityListResult } from "../types.ts";
import {
  formatMissingOperatorReadScopeMessage,
  isMissingOperatorReadScopeError,
} from "./scope-errors.ts";

const ACTIVITY_PAGE_LIMIT = 200;

export type ActivityControllerHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  activityEvents: ActivityEvent[];
  activityLoading: boolean;
  activityError: string | null;
  activityHasMore: boolean;
  activityCursor: ActivityCursor | null;
  activitySubscribed: boolean;
  requestUpdate: () => void;
  scheduleActivityScroll?: (force?: boolean) => void;
};

function isActivityEvent(value: unknown): value is ActivityEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventId === "string" &&
    typeof record.ts === "number" &&
    typeof record.kind === "string" &&
    typeof record.status === "string"
  );
}

function describeError(error: unknown): string {
  if (isMissingOperatorReadScopeError(error)) {
    return formatMissingOperatorReadScopeMessage("activity");
  }
  return error instanceof Error ? error.message : String(error);
}

/** Replace the feed with a fresh first page of history. */
export async function loadActivity(host: ActivityControllerHost): Promise<void> {
  const client = host.client;
  if (!client || !host.connected) {
    return;
  }
  host.activityLoading = true;
  host.activityError = null;
  host.requestUpdate();
  try {
    const result = await client.request<ActivityListResult>("activity.list", {
      limit: ACTIVITY_PAGE_LIMIT,
    });
    host.activityEvents = mergeActivityEvents([], result.events ?? []);
    host.activityCursor = result.nextCursor ?? null;
    host.activityHasMore = Boolean(result.nextCursor);
  } catch (error) {
    host.activityError = describeError(error);
  } finally {
    host.activityLoading = false;
    host.requestUpdate();
  }
  // Ensure we are receiving live updates once history is in place.
  await ensureActivitySubscription(host);
}

/** Append the next older page using the keyset cursor. */
export async function loadMoreActivity(host: ActivityControllerHost): Promise<void> {
  const client = host.client;
  if (!client || !host.connected || host.activityLoading || !host.activityCursor) {
    return;
  }
  host.activityLoading = true;
  host.requestUpdate();
  try {
    const result = await client.request<ActivityListResult>("activity.list", {
      limit: ACTIVITY_PAGE_LIMIT,
      cursor: host.activityCursor,
    });
    host.activityEvents = mergeActivityEvents(host.activityEvents, result.events ?? []);
    host.activityCursor = result.nextCursor ?? null;
    host.activityHasMore = Boolean(result.nextCursor);
  } catch (error) {
    host.activityError = describeError(error);
  } finally {
    host.activityLoading = false;
    host.requestUpdate();
  }
}

/** Subscribe this connection to the live activity broadcast (idempotent). */
export async function ensureActivitySubscription(host: ActivityControllerHost): Promise<void> {
  const client = host.client;
  if (!client || !host.connected || host.activitySubscribed) {
    return;
  }
  try {
    await client.request("activity.subscribe", {});
    host.activitySubscribed = true;
  } catch {
    // A failed subscribe is non-fatal; history still renders and a later
    // reconnect/tab open retries. Avoid surfacing a scary error for this.
  }
}

/** Mark the subscription dropped after a disconnect so reconnect re-subscribes. */
export function resetActivitySubscription(host: ActivityControllerHost): void {
  host.activitySubscribed = false;
}

/** Merge one live broadcast event into the feed. */
export function handleActivityBroadcast(host: ActivityControllerHost, payload: unknown): void {
  if (!isActivityEvent(payload)) {
    return;
  }
  host.activityEvents = mergeActivityEvents(host.activityEvents, [payload]);
  host.requestUpdate();
  host.scheduleActivityScroll?.(false);
}
