// Covers the activity feed store: upsert, keyset paging, filters, and pruning.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ActivityEventRecord,
  clearActivityEvents,
  queryActivityEvents,
  recordActivityEvent,
} from "./activity-events-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

let previousStateDir: string | undefined;

function baseRecord(overrides: Partial<ActivityEventRecord> = {}): ActivityEventRecord {
  return {
    eventId: "run-1:tool:t1",
    ts: Date.now(),
    agentId: "davos",
    sessionKey: "main",
    runId: "run-1",
    groupKey: "run-1",
    kind: "tool",
    status: "ok",
    title: "Read foo.ts",
    ...overrides,
  };
}

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-activity-"));
  clearActivityEvents();
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

describe("activity-events-store", () => {
  it("persists and reads back an event with parsed detail/metrics", () => {
    recordActivityEvent(
      baseRecord({ detail: { summary: "cat foo.ts" }, metrics: { durationMs: 42 } }),
    );
    const page = queryActivityEvents();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({
      eventId: "run-1:tool:t1",
      kind: "tool",
      status: "ok",
      detail: { summary: "cat foo.ts" },
      metrics: { durationMs: 42 },
    });
  });

  it("upserts the same event id instead of duplicating", () => {
    recordActivityEvent(baseRecord({ status: "running" }));
    recordActivityEvent(baseRecord({ status: "ok", ts: Date.now() + 1_000 }));
    const page = queryActivityEvents();
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.status).toBe("ok");
  });

  it("returns events newest-first and pages with the keyset cursor", () => {
    for (let i = 0; i < 5; i += 1) {
      recordActivityEvent(baseRecord({ eventId: `e${i}`, ts: Date.now() + i }));
    }
    const first = queryActivityEvents({ limit: 2 });
    expect(first.events.map((e) => e.eventId)).toStrictEqual(["e4", "e3"]);
    expect(first.nextCursor).not.toBeNull();
    const second = queryActivityEvents({
      limit: 2,
      cursorTs: first.nextCursor!.ts,
      cursorId: first.nextCursor!.id,
    });
    expect(second.events.map((e) => e.eventId)).toStrictEqual(["e2", "e1"]);
  });

  it("filters by agent, kind, and search", () => {
    recordActivityEvent(
      baseRecord({ eventId: "a", agentId: "davos", kind: "tool", title: "Read foo" }),
    );
    recordActivityEvent(
      baseRecord({ eventId: "b", agentId: "scout", kind: "patch", title: "Patch bar" }),
    );
    expect(queryActivityEvents({ agentIds: ["scout"] }).events.map((e) => e.eventId)).toStrictEqual(
      ["b"],
    );
    expect(queryActivityEvents({ kinds: ["patch"] }).events.map((e) => e.eventId)).toStrictEqual([
      "b",
    ]);
    expect(queryActivityEvents({ search: "foo" }).events.map((e) => e.eventId)).toStrictEqual([
      "a",
    ]);
  });

  it("drops events older than the age cutoff on write", () => {
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    recordActivityEvent(baseRecord({ eventId: "stale", ts: old }));
    recordActivityEvent(baseRecord({ eventId: "fresh", ts: Date.now() }));
    expect(queryActivityEvents().events.map((e) => e.eventId)).toStrictEqual(["fresh"]);
  });
});
