import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSessionToForge } from "./capture.js";
import { FORGE_SCHEMA, FORGE_SCHEMA_VERSION } from "./types.js";

const exportTrajectoryBundleMock = vi.fn();

vi.mock("../trajectory/export.js", () => ({
  exportTrajectoryBundle: (...args: unknown[]) => exportTrajectoryBundleMock(...args),
}));

function fakeBundleResult(outputDir: string) {
  return {
    manifest: {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      generatedAt: "2026-05-20T17:30:45.000Z",
      traceId: "trace-1",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      workspaceDir: "$WORKSPACE_DIR",
      leafId: "leaf-1",
      eventCount: 12,
      runtimeEventCount: 4,
      transcriptEventCount: 8,
      sourceFiles: { session: "$WORKSPACE_DIR/session.jsonl" },
    },
    outputDir,
    events: [],
    header: null,
    runtimeFile: undefined,
    supplementalFiles: ["metadata.json", "artifacts.json"],
  };
}

describe("captureSessionToForge", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-forge-test-"));
    exportTrajectoryBundleMock.mockReset();
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("writes forge-manifest.json next to the exported bundle on success", async () => {
    exportTrajectoryBundleMock.mockImplementation(async (input: { outputDir: string }) => {
      await fsp.mkdir(input.outputDir, { recursive: true });
      return fakeBundleResult(input.outputDir);
    });

    const now = new Date("2026-05-20T17:30:45.000Z");
    const result = await captureSessionToForge({
      sessionFile: "/workspace/session.jsonl",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      workspaceDir: "/workspace",
      trigger: "manual",
      now,
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });

    expect(result.status).toBe("captured");
    if (result.status !== "captured") {
      throw new Error("unreachable");
    }
    expect(result.outputDir).toBe(
      path.join(stateDir, "skill-forge", "sessions", "sess-1-2026-05-20T17-30-45"),
    );
    expect(result.manifest).toMatchObject({
      forgeSchema: FORGE_SCHEMA,
      forgeSchemaVersion: FORGE_SCHEMA_VERSION,
      trigger: "manual",
      traceId: "trace-1",
      sessionId: "sess-1",
      sessionKey: "agent:main:main",
      eventCount: 12,
      runtimeEventCount: 4,
      transcriptEventCount: 8,
      supplementalFiles: ["metadata.json", "artifacts.json"],
      capturedAt: "2026-05-20T17:30:45.000Z",
    });

    const manifestOnDisk = JSON.parse(
      await fsp.readFile(path.join(result.outputDir, "forge-manifest.json"), "utf8"),
    );
    expect(manifestOnDisk).toEqual(result.manifest);
  });

  it("propagates trigger field", async () => {
    exportTrajectoryBundleMock.mockImplementation(async (input: { outputDir: string }) => {
      await fsp.mkdir(input.outputDir, { recursive: true });
      return fakeBundleResult(input.outputDir);
    });

    const result = await captureSessionToForge({
      sessionFile: "/workspace/session.jsonl",
      sessionId: "sess-2",
      workspaceDir: "/workspace",
      trigger: "explicit-instruction",
      now: new Date("2026-05-20T18:00:00.000Z"),
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });

    expect(result.status).toBe("captured");
    if (result.status !== "captured") {
      throw new Error("unreachable");
    }
    expect(result.manifest.trigger).toBe("explicit-instruction");
  });

  it("returns skipped result when the exporter throws (oversized session, missing files, etc.)", async () => {
    exportTrajectoryBundleMock.mockRejectedValueOnce(
      new Error("Trajectory session file is too large to export (60000000 bytes; limit 52428800)"),
    );

    const result = await captureSessionToForge({
      sessionFile: "/workspace/session.jsonl",
      sessionId: "sess-3",
      workspaceDir: "/workspace",
      trigger: "manual",
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });

    expect(result.status).toBe("skipped");
    if (result.status !== "skipped") {
      throw new Error("unreachable");
    }
    expect(result.reason).toMatch(/too large/);
    expect(result.error).toBeInstanceOf(Error);
  });

  it("forwards sessionKey and runtimeFile to the underlying exporter", async () => {
    exportTrajectoryBundleMock.mockImplementation(async (input: { outputDir: string }) => {
      await fsp.mkdir(input.outputDir, { recursive: true });
      return fakeBundleResult(input.outputDir);
    });

    await captureSessionToForge({
      sessionFile: "/workspace/session.jsonl",
      sessionId: "sess-4",
      sessionKey: "agent:sub:42",
      runtimeFile: "/workspace/session.trajectory.jsonl",
      workspaceDir: "/workspace",
      trigger: "subagent-end",
      env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" },
    });

    expect(exportTrajectoryBundleMock).toHaveBeenCalledTimes(1);
    expect(exportTrajectoryBundleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: "/workspace/session.jsonl",
        sessionId: "sess-4",
        sessionKey: "agent:sub:42",
        runtimeFile: "/workspace/session.trajectory.jsonl",
        workspaceDir: "/workspace",
      }),
    );
  });
});
