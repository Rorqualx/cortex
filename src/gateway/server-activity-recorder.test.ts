// Covers the activity recorder projection: tool steps, run lifecycle, and the
// live broadcast to subscribed connections.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import { clearActivityEvents, queryActivityEvents } from "../state/activity-events-store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { startGatewayActivityRecorder } from "./server-activity-recorder.js";

let previousStateDir: string | undefined;
let unsub: (() => void) | null = null;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-activity-rec-"));
  resetAgentEventsForTest();
  clearActivityEvents();
});

afterEach(() => {
  unsub?.();
  unsub = null;
  resetAgentEventsForTest();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

function startRecorder(connIds: Set<string>) {
  const broadcast = vi.fn();
  const recorder = startGatewayActivityRecorder({
    broadcastToConnIds: broadcast,
    getSubscriberConnIds: () => connIds,
  });
  unsub = recorder.activityRecorderUnsub;
  return broadcast;
}

describe("server-activity-recorder", () => {
  it("records a tool step with a derived title and redacted args", () => {
    startRecorder(new Set());
    emitAgentEvent({
      runId: "run-1",
      stream: "tool",
      sessionKey: "main",
      data: {
        phase: "result",
        name: "Bash",
        toolCallId: "t1",
        args: { command: "pnpm test", token: "sk-supersecretvalue123" },
        result: { text: "ok" },
      },
    });
    const page = queryActivityEvents();
    expect(page.events).toHaveLength(1);
    const event = page.events[0];
    expect(event.kind).toBe("tool");
    expect(event.status).toBe("ok");
    expect(event.title).toContain("pnpm test");
    expect(JSON.stringify(event)).not.toContain("sk-supersecretvalue123");
  });

  it("marks explicit tool errors as failed", () => {
    startRecorder(new Set());
    emitAgentEvent({
      runId: "run-2",
      stream: "tool",
      data: { phase: "result", name: "exec", toolCallId: "t2", result: { isError: true } },
    });
    expect(queryActivityEvents().events[0]?.status).toBe("error");
  });

  it("rolls run lifecycle into a single run header with token metrics", () => {
    startRecorder(new Set());
    emitAgentEvent({ runId: "run-3", stream: "lifecycle", data: { phase: "start", startedAt: 1 } });
    emitAgentEvent({ runId: "run-3", stream: "usage", data: { input: 100, output: 20 } });
    emitAgentEvent({ runId: "run-3", stream: "lifecycle", data: { phase: "end", endedAt: 50 } });
    const runRow = queryActivityEvents().events.find((e) => e.eventId === "run-3:run");
    expect(runRow?.kind).toBe("lifecycle");
    expect(runRow?.status).toBe("ok");
    expect(runRow?.metrics).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  });

  it("broadcasts to subscribed connections", () => {
    const broadcast = startRecorder(new Set(["conn-1"]));
    emitAgentEvent({
      runId: "run-4",
      stream: "tool",
      data: { phase: "result", name: "Read", toolCallId: "t4", args: { file_path: "src/x.ts" } },
    });
    expect(broadcast).toHaveBeenCalledWith(
      "activity.event",
      expect.objectContaining({ kind: "tool" }),
      expect.any(Set),
      expect.objectContaining({ dropIfSlow: true }),
    );
  });

  it("does not broadcast when there are no subscribers", () => {
    const broadcast = startRecorder(new Set());
    emitAgentEvent({
      runId: "run-5",
      stream: "tool",
      data: { phase: "result", name: "Read", toolCallId: "t5" },
    });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
