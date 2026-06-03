import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "../trajectory/types.js";
import {
  actionCaptureDir,
  actionDaemonScan,
  actionListForge,
  actionReset,
  hasSessionEndedInTrajectory,
  listAlreadyCapturedSessionIds,
  readSessionStartedMetaFromTrajectory,
} from "./cli-actions.js";
import { resolveSkillForgeSessionsDir } from "./paths.js";

function envWithState(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_TEST_FAST: "1" };
}

function event(type: string, data: Record<string, unknown> = {}): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace",
    source: "runtime",
    type,
    ts: "2026-05-20T18:00:00.000Z",
    seq: 1,
    sessionId: "sess",
    data,
  };
}

async function writeTrajectory(filePath: string, events: TrajectoryEvent[]): Promise<void> {
  await fsp.writeFile(filePath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

describe("readSessionStartedMetaFromTrajectory", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-cli-meta-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("extracts sessionId, sessionFile, workspaceDir, sessionKey from session.started", async () => {
    const file = path.join(tmp, "x.trajectory.jsonl");
    await writeTrajectory(file, [
      {
        ...event("session.started", {
          sessionFile: "/ws/session.jsonl",
          workspaceDir: "/ws",
        }),
        sessionId: "abc",
        sessionKey: "agent:main:main",
      },
    ]);
    const meta = await readSessionStartedMetaFromTrajectory(file);
    expect(meta).toEqual({
      sessionId: "abc",
      sessionFile: "/ws/session.jsonl",
      workspaceDir: "/ws",
      sessionKey: "agent:main:main",
    });
  });

  it("returns null when no session.started event is present", async () => {
    const file = path.join(tmp, "y.trajectory.jsonl");
    await writeTrajectory(file, [event("tool.call")]);
    expect(await readSessionStartedMetaFromTrajectory(file)).toBeNull();
  });
});

describe("hasSessionEndedInTrajectory", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-cli-end-"));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it("returns true when session.ended for the right sessionId is in the file", async () => {
    const file = path.join(tmp, "z.trajectory.jsonl");
    await writeTrajectory(file, [
      { ...event("tool.call"), sessionId: "abc" },
      { ...event("session.ended", { status: "ok" }), sessionId: "abc" },
    ]);
    expect(await hasSessionEndedInTrajectory(file, "abc")).toBe(true);
  });

  it("returns false when only other sessions have ended", async () => {
    const file = path.join(tmp, "w.trajectory.jsonl");
    await writeTrajectory(file, [
      { ...event("session.ended", { status: "ok" }), sessionId: "other" },
    ]);
    expect(await hasSessionEndedInTrajectory(file, "abc")).toBe(false);
  });
});

describe("listAlreadyCapturedSessionIds", () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-cli-already-"));
  });
  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("strips trailing -ISO8601 timestamp suffix from capture dir names", async () => {
    const sessionsDir = resolveSkillForgeSessionsDir(envWithState(stateDir));
    await fsp.mkdir(path.join(sessionsDir, "abc-2026-05-20T18-00-00"), { recursive: true });
    await fsp.mkdir(path.join(sessionsDir, "def-2026-05-21T01-30-45"), { recursive: true });
    const result = await listAlreadyCapturedSessionIds(envWithState(stateDir));
    expect([...result].toSorted()).toEqual(["abc", "def"]);
  });

  it("returns empty set when sessions dir does not exist", async () => {
    expect((await listAlreadyCapturedSessionIds(envWithState(stateDir))).size).toBe(0);
  });
});

describe("actionCaptureDir + actionDaemonScan + actionReset + actionListForge", () => {
  let scanDir: string;
  let stateDir: string;
  beforeEach(async () => {
    scanDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-cli-scan-"));
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-cli-state-"));
  });
  afterEach(async () => {
    await fsp.rm(scanDir, { recursive: true, force: true });
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  async function setupSession(id: string, opts: { ended: boolean }): Promise<void> {
    const sessionFile = path.join(scanDir, `${id}.jsonl`);
    const trajectoryFile = path.join(scanDir, `${id}.trajectory.jsonl`);
    await fsp.writeFile(sessionFile, "{}\n", "utf8");
    const events: TrajectoryEvent[] = [
      {
        ...event("session.started", {
          sessionFile,
          workspaceDir: "/ws",
        }),
        sessionId: id,
        sessionKey: `agent:main:${id}`,
      },
      { ...event("tool.call", { name: "read_file" }), sessionId: id },
    ];
    if (opts.ended) {
      events.push({ ...event("session.ended", { status: "ok" }), sessionId: id });
    }
    await writeTrajectory(trajectoryFile, events);
  }

  it("actionCaptureDir captures every session regardless of end state", async () => {
    await setupSession("running", { ended: false });
    await setupSession("done", { ended: true });
    const report = await actionCaptureDir({
      dir: scanDir,
      env: envWithState(stateDir),
    });
    expect(report.scannedTrajectories).toBe(2);
    expect(report.captured.map((c) => c.sessionId).toSorted()).toEqual(["done", "running"]);
  });

  it("actionDaemonScan only captures ended sessions and skips already-captured ones", async () => {
    await setupSession("running", { ended: false });
    await setupSession("done", { ended: true });

    const first = await actionDaemonScan({ scanDir, env: envWithState(stateDir) });
    expect(first.capturedSessionIds).toEqual(["done"]);

    const second = await actionDaemonScan({ scanDir, env: envWithState(stateDir) });
    expect(second.capturedSessionIds).toEqual([]);
  });

  it("actionReset removes the entire forge root", async () => {
    await setupSession("done", { ended: true });
    await actionDaemonScan({ scanDir, env: envWithState(stateDir) });

    const ls1 = await actionListForge(envWithState(stateDir));
    expect(ls1.subdirs.some((s) => s.sub === "sessions" && s.entries.length === 1)).toBe(true);

    const reset = await actionReset(envWithState(stateDir));
    expect(reset.removed).toContain("skill-forge");

    const ls2 = await actionListForge(envWithState(stateDir));
    for (const sub of ls2.subdirs) {
      expect(sub.entries).toEqual([]);
    }
  });
});
