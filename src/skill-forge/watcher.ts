import fsp from "node:fs/promises";
import { captureSessionToForge } from "./capture.js";
import type { CaptureResult } from "./types.js";

const SESSION_ENDED_EVENT_TYPE = "session.ended" as const;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export type ParsedTrajectoryLine =
  | { kind: "ignored" }
  | { kind: "session-ended"; event: Record<string, unknown> };

export function parseTrajectoryLine(line: string, sessionId: string): ParsedTrajectoryLine {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "ignored" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "ignored" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "ignored" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== SESSION_ENDED_EVENT_TYPE) {
    return { kind: "ignored" };
  }
  if (record.sessionId !== sessionId) {
    return { kind: "ignored" };
  }
  return { kind: "session-ended", event: record };
}

export type FileTailerState = {
  offset: number;
  buffer: string;
};

export function createFileTailerState(): FileTailerState {
  return { offset: 0, buffer: "" };
}

export async function readNewLinesFromOffset(
  filePath: string,
  state: FileTailerState,
): Promise<string[]> {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return [];
  }
  if (!stat.isFile()) {
    return [];
  }
  if (stat.size < state.offset) {
    // Truncated or rotated underneath us; restart from the beginning.
    state.offset = 0;
    state.buffer = "";
  }
  if (stat.size === state.offset) {
    return [];
  }
  const handle = await fsp.open(filePath, "r");
  try {
    const length = stat.size - state.offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, state.offset);
    state.offset = stat.size;
    const text = state.buffer + buffer.toString("utf8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      state.buffer = text;
      return [];
    }
    const complete = text.slice(0, lastNewline);
    state.buffer = text.slice(lastNewline + 1);
    return complete.split("\n").filter((line) => line.length > 0);
  } finally {
    await handle.close();
  }
}

export type WatchTrajectoryInput = {
  sessionFile: string;
  sessionId: string;
  workspaceDir: string;
  trajectoryFile: string;
  sessionKey?: string;
  pollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type TrajectoryWatcherHandle = {
  stop: () => Promise<void>;
  poll: () => Promise<CaptureResult | null>;
  done: () => Promise<CaptureResult | null>;
};

export function watchTrajectoryForSessionEnd(input: WatchTrajectoryInput): TrajectoryWatcherHandle {
  const state = createFileTailerState();
  let stopped = false;
  let captureResult: CaptureResult | null = null;
  let captureInFlight: Promise<CaptureResult> | null = null;
  const completionWaiters: Array<(result: CaptureResult | null) => void> = [];

  const finish = (result: CaptureResult | null): void => {
    captureResult = result;
    stopped = true;
    for (const waiter of completionWaiters.splice(0)) {
      waiter(result);
    }
  };

  const poll = async (): Promise<CaptureResult | null> => {
    if (stopped) {
      return captureResult;
    }
    if (captureInFlight) {
      return captureInFlight;
    }
    const lines = await readNewLinesFromOffset(input.trajectoryFile, state);
    for (const line of lines) {
      const parsed = parseTrajectoryLine(line, input.sessionId);
      if (parsed.kind === "session-ended") {
        captureInFlight = captureSessionToForge({
          sessionFile: input.sessionFile,
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          workspaceDir: input.workspaceDir,
          trigger: "session-end",
          runtimeFile: input.trajectoryFile,
          env: input.env,
        });
        const result = await captureInFlight;
        finish(result);
        return result;
      }
    }
    return null;
  };

  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const interval = setInterval(() => {
    void poll();
  }, pollIntervalMs);
  if (typeof interval.unref === "function") {
    interval.unref();
  }

  return {
    poll,
    stop: async () => {
      clearInterval(interval);
      if (captureInFlight) {
        await captureInFlight.catch(() => undefined);
      }
      finish(captureResult);
    },
    done: () =>
      new Promise<CaptureResult | null>((resolve) => {
        if (stopped) {
          resolve(captureResult);
          return;
        }
        completionWaiters.push(resolve);
      }),
  };
}
