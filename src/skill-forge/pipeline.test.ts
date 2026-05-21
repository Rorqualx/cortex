import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "../trajectory/types.js";
import {
  resolveSkillForgeCandidatesDir,
  resolveSkillForgePromotedSkillDir,
  resolveSkillForgeSessionsDir,
} from "./paths.js";
import { runForgePipeline } from "./pipeline.js";

function event(type: string, data: Record<string, unknown> = {}): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace",
    source: "transcript",
    type,
    ts: "2026-05-20T18:00:00.000Z",
    seq: 1,
    sessionId: "sess",
    data,
  };
}

async function writeCapture(captureDir: string, events: TrajectoryEvent[]): Promise<void> {
  await fsp.mkdir(captureDir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  await fsp.writeFile(path.join(captureDir, "events.jsonl"), `${body}\n`, "utf8");
}

describe("runForgePipeline", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-pipeline-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("discovers captures, detects, distills, validates, and promotes end-to-end", async () => {
    const sessionsDir = resolveSkillForgeSessionsDir(env());
    const dirs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const dir = path.join(sessionsDir, `cap-${i}-2026-05-20T18-00-${i}0`);
      dirs.push(dir);
      await writeCapture(dir, [
        event("tool.call", { name: "read_file" }),
        event("tool.result", { message: { role: "toolResult", content: "ok" } }),
        event("tool.call", { name: "grep" }),
        event("tool.result", { message: { role: "toolResult", content: "ok" } }),
      ]);
    }

    const result = await runForgePipeline({ env: env() });

    expect(result.scannedCaptureDirs).toBe(3);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].lane).toBe("tool-shape");
    expect(result.drafted).toHaveLength(1);
    expect(result.promotions).toHaveLength(1);
    expect(result.promotions[0].status).toBe("promoted");

    const candidatesDir = resolveSkillForgeCandidatesDir(env());
    const candidateFiles = await fsp.readdir(candidatesDir);
    expect(candidateFiles).toHaveLength(1);

    const promotedDir = resolveSkillForgePromotedSkillDir({
      name: result.drafted[0].name,
      env: env(),
    });
    const skillContent = await fsp.readFile(path.join(promotedDir, "SKILL.md"), "utf8");
    expect(skillContent).toContain("read_file");
    expect(skillContent).toContain("grep");
  });

  it("returns empty result when there are no captures", async () => {
    const result = await runForgePipeline({ env: env() });
    expect(result).toEqual({
      scannedCaptureDirs: 0,
      candidates: [],
      candidateFiles: [],
      drafted: [],
      promotions: [],
    });
  });
});
