import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileTailerState,
  parseTrajectoryLine,
  readNewLinesFromOffset,
  watchTrajectoryForSessionEnd,
} from "./watcher.js";

const captureSessionToForgeMock = vi.fn();

vi.mock("./capture.js", () => ({
  captureSessionToForge: (...args: unknown[]) => captureSessionToForgeMock(...args),
}));

describe("parseTrajectoryLine", () => {
  it("ignores blank, malformed, and unrelated events", () => {
    expect(parseTrajectoryLine("", "sess-1").kind).toBe("ignored");
    expect(parseTrajectoryLine("not-json", "sess-1").kind).toBe("ignored");
    expect(parseTrajectoryLine("[]", "sess-1").kind).toBe("ignored");
    expect(
      parseTrajectoryLine(JSON.stringify({ type: "tool.call", sessionId: "sess-1" }), "sess-1")
        .kind,
    ).toBe("ignored");
  });

  it("ignores session.ended for a different session", () => {
    const line = JSON.stringify({ type: "session.ended", sessionId: "other" });
    expect(parseTrajectoryLine(line, "sess-1").kind).toBe("ignored");
  });

  it("matches session.ended for the right session id", () => {
    const line = JSON.stringify({
      type: "session.ended",
      sessionId: "sess-1",
      status: "ok",
    });
    const parsed = parseTrajectoryLine(line, "sess-1");
    expect(parsed.kind).toBe("session-ended");
    if (parsed.kind !== "session-ended") {
      throw new Error("unreachable");
    }
    expect(parsed.event.status).toBe("ok");
  });
});

describe("readNewLinesFromOffset", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-tail-test-"));
    filePath = path.join(tmpDir, "trajectory.jsonl");
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns nothing when the file does not exist yet", async () => {
    const state = createFileTailerState();
    expect(await readNewLinesFromOffset(filePath, state)).toEqual([]);
    expect(state.offset).toBe(0);
  });

  it("reads complete lines and buffers partials across reads", async () => {
    await fsp.writeFile(filePath, "one\ntwo\npartial");
    const state = createFileTailerState();
    expect(await readNewLinesFromOffset(filePath, state)).toEqual(["one", "two"]);
    expect(state.buffer).toBe("partial");

    await fsp.appendFile(filePath, "-complete\nthree\n");
    expect(await readNewLinesFromOffset(filePath, state)).toEqual(["partial-complete", "three"]);
    expect(state.buffer).toBe("");
  });

  it("restarts from the beginning when the file shrinks (rotation/truncation)", async () => {
    await fsp.writeFile(filePath, "first\nsecond\n");
    const state = createFileTailerState();
    expect(await readNewLinesFromOffset(filePath, state)).toEqual(["first", "second"]);

    await fsp.writeFile(filePath, "fresh\n");
    expect(await readNewLinesFromOffset(filePath, state)).toEqual(["fresh"]);
  });
});

describe("watchTrajectoryForSessionEnd", () => {
  let tmpDir: string;
  let trajectoryFile: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-test-"));
    trajectoryFile = path.join(tmpDir, "session.trajectory.jsonl");
    captureSessionToForgeMock.mockReset();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("fires captureSessionToForge with trigger=session-end when session.ended appears", async () => {
    captureSessionToForgeMock.mockResolvedValue({
      status: "captured",
      outputDir: "/fake",
      manifest: { trigger: "session-end" },
    });

    await fsp.writeFile(
      trajectoryFile,
      `${JSON.stringify({ type: "tool.call", sessionId: "sess-1" })}\n`,
    );

    const handle = watchTrajectoryForSessionEnd({
      sessionFile: path.join(tmpDir, "session.jsonl"),
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      workspaceDir: "/workspace",
      trajectoryFile,
      pollIntervalMs: 60_000,
    });

    expect(await handle.poll()).toBeNull();
    expect(captureSessionToForgeMock).not.toHaveBeenCalled();

    await fsp.appendFile(
      trajectoryFile,
      `${JSON.stringify({ type: "session.ended", sessionId: "sess-1", status: "ok" })}\n`,
    );

    const result = await handle.poll();
    expect(result).toEqual({
      status: "captured",
      outputDir: "/fake",
      manifest: { trigger: "session-end" },
    });
    expect(captureSessionToForgeMock).toHaveBeenCalledTimes(1);
    expect(captureSessionToForgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: path.join(tmpDir, "session.jsonl"),
        sessionId: "sess-1",
        sessionKey: "agent:main:main",
        workspaceDir: "/workspace",
        trigger: "session-end",
        runtimeFile: trajectoryFile,
      }),
    );

    // Subsequent polls are no-ops once captured.
    expect(await handle.poll()).toEqual({
      status: "captured",
      outputDir: "/fake",
      manifest: { trigger: "session-end" },
    });
    expect(captureSessionToForgeMock).toHaveBeenCalledTimes(1);

    await handle.stop();
  });

  it("ignores session.ended for the wrong session id", async () => {
    captureSessionToForgeMock.mockResolvedValue({ status: "captured" });

    await fsp.writeFile(
      trajectoryFile,
      `${JSON.stringify({ type: "session.ended", sessionId: "other" })}\n`,
    );

    const handle = watchTrajectoryForSessionEnd({
      sessionFile: path.join(tmpDir, "session.jsonl"),
      sessionId: "sess-1",
      workspaceDir: "/workspace",
      trajectoryFile,
      pollIntervalMs: 60_000,
    });

    expect(await handle.poll()).toBeNull();
    expect(captureSessionToForgeMock).not.toHaveBeenCalled();
    await handle.stop();
  });

  it("stop() resolves a pending done() with the last result", async () => {
    captureSessionToForgeMock.mockResolvedValue(null);
    const handle = watchTrajectoryForSessionEnd({
      sessionFile: path.join(tmpDir, "session.jsonl"),
      sessionId: "sess-1",
      workspaceDir: "/workspace",
      trajectoryFile,
      pollIntervalMs: 60_000,
    });
    const done = handle.done();
    await handle.stop();
    await expect(done).resolves.toBeNull();
  });
});
