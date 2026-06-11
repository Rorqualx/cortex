// Tests for per-turn file pre-image capture and timestamp-based restore.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureToolFilePreImage, restoreFilesToTimestamp } from "./turn-file-snapshots.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("turn file snapshots", () => {
  it("captures pre-images for write/edit and restores them past the cutoff", () => {
    const env = { OPENCLAW_STATE_DIR: tempDir("snap-state-") };
    const workDir = tempDir("snap-work-");
    const filePath = path.join(workDir, "code.ts");
    fs.writeFileSync(filePath, "original");

    const beforeTurn = Date.now() - 1;
    captureToolFilePreImage({
      toolName: "write",
      params: { path: filePath },
      sessionId: "sess-1",
      env,
    });
    fs.writeFileSync(filePath, "mutated");

    const report = restoreFilesToTimestamp({ sessionId: "sess-1", cutoffMs: beforeTurn, env });

    expect(report.restored).toEqual([filePath]);
    expect(report.skipped).toEqual([]);
    expect(fs.readFileSync(filePath, "utf8")).toBe("original");
  });

  it("deletes files that did not exist before the rolled-back turn", () => {
    const env = { OPENCLAW_STATE_DIR: tempDir("snap-state-") };
    const workDir = tempDir("snap-work-");
    const filePath = path.join(workDir, "new-file.ts");

    const beforeTurn = Date.now() - 1;
    captureToolFilePreImage({
      toolName: "write",
      params: { file_path: filePath },
      sessionId: "sess-2",
      env,
    });
    fs.writeFileSync(filePath, "created by the turn");

    const report = restoreFilesToTimestamp({ sessionId: "sess-2", cutoffMs: beforeTurn, env });

    expect(report.restored).toEqual([filePath]);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("restores the earliest pre-image when a file is touched repeatedly", () => {
    const env = { OPENCLAW_STATE_DIR: tempDir("snap-state-") };
    const workDir = tempDir("snap-work-");
    const filePath = path.join(workDir, "multi.ts");
    fs.writeFileSync(filePath, "v1");

    const beforeTurn = Date.now() - 1;
    captureToolFilePreImage({
      toolName: "edit",
      params: { path: filePath },
      sessionId: "sess-3",
      env,
    });
    fs.writeFileSync(filePath, "v2");
    captureToolFilePreImage({
      toolName: "edit",
      params: { path: filePath },
      sessionId: "sess-3",
      env,
    });
    fs.writeFileSync(filePath, "v3");

    const report = restoreFilesToTimestamp({ sessionId: "sess-3", cutoffMs: beforeTurn, env });

    expect(report.restored).toEqual([filePath]);
    expect(fs.readFileSync(filePath, "utf8")).toBe("v1");
  });

  it("ignores snapshots captured before the cutoff and non-mutating tools", () => {
    const env = { OPENCLAW_STATE_DIR: tempDir("snap-state-") };
    const workDir = tempDir("snap-work-");
    const filePath = path.join(workDir, "old.ts");
    fs.writeFileSync(filePath, "old original");

    captureToolFilePreImage({
      toolName: "write",
      params: { path: filePath },
      sessionId: "sess-4",
      env,
    });
    captureToolFilePreImage({
      toolName: "read",
      params: { path: path.join(workDir, "ignored.ts") },
      sessionId: "sess-4",
      env,
    });
    fs.writeFileSync(filePath, "later content");

    const afterCapture = Date.now() + 5;
    const report = restoreFilesToTimestamp({ sessionId: "sess-4", cutoffMs: afterCapture, env });

    expect(report.restored).toEqual([]);
    expect(fs.readFileSync(filePath, "utf8")).toBe("later content");
  });
});
