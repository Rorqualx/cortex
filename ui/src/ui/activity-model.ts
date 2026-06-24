// Control UI activity model: client-side merge + run-grouping for the
// persistent, cross-agent activity feed served by the gateway. Events arrive
// from `activity.list` (history backfill) and the `activity.event` broadcast
// (live). This module owns the dedupe/merge and the run-card grouping the view
// renders; it no longer derives activity from the local tool stream.
import type { ActivityEvent } from "./types.ts";

export type { ActivityEvent } from "./types.ts";

/** Cap merged events so a long-lived tab cannot grow unbounded. */
export const ACTIVITY_EVENT_LIMIT = 1_500;

/** Coarse status buckets the filter chips and styling key off. */
export type ActivityStatusKey = "running" | "ok" | "error" | "blocked" | "info";

const KNOWN_STATUS: Record<string, ActivityStatusKey> = {
  running: "running",
  ok: "ok",
  error: "error",
  blocked: "blocked",
  info: "info",
};

export function statusKey(status: string): ActivityStatusKey {
  return KNOWN_STATUS[status] ?? "info";
}

function compareEvents(a: ActivityEvent, b: ActivityEvent): number {
  if (b.ts !== a.ts) {
    return b.ts - a.ts;
  }
  return a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0;
}

/** Upsert incoming events by id, keep newest-first, and cap the total. */
export function mergeActivityEvents(
  existing: readonly ActivityEvent[],
  incoming: readonly ActivityEvent[],
): ActivityEvent[] {
  if (incoming.length === 0) {
    return existing.slice(0, ACTIVITY_EVENT_LIMIT);
  }
  const byId = new Map<string, ActivityEvent>();
  for (const event of existing) {
    byId.set(event.eventId, event);
  }
  for (const event of incoming) {
    byId.set(event.eventId, event);
  }
  return [...byId.values()].toSorted(compareEvents).slice(0, ACTIVITY_EVENT_LIMIT);
}

/** One run's worth of activity: a header (run lifecycle) plus its steps. */
export type ActivityRunGroup = {
  key: string;
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  header?: ActivityEvent;
  steps: ActivityEvent[];
  latestTs: number;
  status: ActivityStatusKey;
  model?: string;
  metrics?: ActivityEvent["metrics"];
};

function groupStatus(header: ActivityEvent | undefined, steps: ActivityEvent[]): ActivityStatusKey {
  if (header) {
    return statusKey(header.status);
  }
  const keys = new Set(steps.map((step) => statusKey(step.status)));
  if (keys.has("running")) {
    return "running";
  }
  if (keys.has("error")) {
    return "error";
  }
  if (keys.has("blocked")) {
    return "blocked";
  }
  if (keys.has("ok")) {
    return "ok";
  }
  return "info";
}

/**
 * Collapse a flat, newest-first event list into run cards. The `:run` lifecycle
 * event becomes the card header (carrying model + token/cost rollup); every
 * other event in the same group is a step. Groups are ordered by most-recent
 * activity so live runs float to the top.
 */
export function groupActivityRuns(events: readonly ActivityEvent[]): ActivityRunGroup[] {
  const groups = new Map<string, ActivityRunGroup>();
  for (const event of events) {
    const key = event.groupKey ?? event.runId ?? event.eventId;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        ...(event.runId ? { runId: event.runId } : {}),
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
        steps: [],
        latestTs: 0,
        status: "info",
      };
      groups.set(key, group);
    }
    group.agentId ??= event.agentId;
    group.sessionKey ??= event.sessionKey;
    group.latestTs = Math.max(group.latestTs, event.ts);
    if (event.kind === "lifecycle") {
      group.header = event;
      group.model ??= event.detail?.model;
      if (event.metrics) {
        group.metrics = event.metrics;
      }
    } else {
      group.steps.push(event);
      group.model ??= event.detail?.model;
    }
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.steps = group.steps.toSorted(compareEvents);
    group.status = groupStatus(group.header, group.steps);
  }
  return list.toSorted((a, b) => b.latestTs - a.latestTs);
}

/** True when a single event matches the case-insensitive search needle. */
export function eventMatchesSearch(event: ActivityEvent, needle: string): boolean {
  if (!needle) {
    return true;
  }
  const haystack = [
    event.title,
    event.kind,
    event.status,
    event.agentId,
    event.sessionKey,
    event.detail?.summary,
    event.detail?.preview,
    event.detail?.model,
    event.detail?.error,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}
