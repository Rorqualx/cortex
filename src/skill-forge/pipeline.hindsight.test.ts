import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "../trajectory/types.js";
import type { HindsightCandidate } from "./detector.js";
import { runHindsightAnalyst, type HindsightLaneResult } from "./hindsight.js";
import { resolveSkillForgeSessionsDir } from "./paths.js";
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

describe("runForgePipeline hindsight lane", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-pipeline-hindsight-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  const writeExplicitCapture = async (name: string): Promise<string> => {
    const dir = path.join(resolveSkillForgeSessionsDir(env()), name);
    await fsp.mkdir(dir, { recursive: true });
    const events: TrajectoryEvent[] = [
      event("user.message", {
        message: { content: "please turn this into a skill for me" },
      }),
      event("tool.call", { name: "read_file" }),
    ];
    await fsp.writeFile(
      path.join(dir, "events.jsonl"),
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8",
    );
    return dir;
  };

  const hindsightCandidate = (id: string): HindsightCandidate => ({
    lane: "hindsight",
    candidateId: id,
    captureDir: "/tmp/cap",
    toolSequence: ["read_file"],
    skillHypothesis: "Preflight config checks before deploy",
    hypothesisKind: "failure-avoidance",
    rationale: "Checking config first caught the bad port.",
    successScore: 1,
  });

  it("default-off: useHindsight unset → status disabled, zero hindsight candidates, no lane writes", async () => {
    await writeExplicitCapture("cap-explicit-1");
    const result = await runForgePipeline({ env: env(), useLlm: false });
    expect(result.hindsight).toEqual({ status: "disabled" });
    expect(result.candidates.every((c) => c.lane !== "hindsight")).toBe(true);
  });

  it("opt-in: injected runHindsight candidates merge into candidates[] by candidateId", async () => {
    await writeExplicitCapture("cap-explicit-2");
    const injected: HindsightLaneResult = {
      status: "ran",
      captureDirs: ["/tmp/cap"],
      candidates: [hindsightCandidate("hind-1"), hindsightCandidate("hind-1")],
      digestChars: 123,
      failedCaptures: [],
    };
    const result = await runForgePipeline({
      env: env(),
      useLlm: false,
      useHindsight: true,
      runHindsight: (async () => injected) as typeof runHindsightAnalyst,
    });
    expect(result.hindsight.status).toBe("ran");
    // Deduplicated by candidateId — one merged candidate, alongside the detector's explicit one.
    const hindsight = result.candidates.filter((c) => c.lane === "hindsight");
    expect(hindsight).toHaveLength(1);
    expect(hindsight[0]!.candidateId).toBe("hind-1");
    // And it flows through the funnel: drafted + promoted like any other lane.
    expect(result.drafted.some((d) => d.name.startsWith("forge-hindsight-"))).toBe(true);
  });

  it("injected analyst total failure → pipeline completes with detector candidates intact", async () => {
    await writeExplicitCapture("cap-explicit-3");
    const failed: HindsightLaneResult = {
      status: "ran",
      captureDirs: ["/tmp/cap"],
      candidates: [],
      digestChars: 0,
      failedCaptures: [{ captureDir: "/tmp/cap", reason: "validation failed: not-json" }],
    };
    const result = await runForgePipeline({
      env: env(),
      useLlm: false,
      useHindsight: true,
      runHindsight: (async () => failed) as typeof runHindsightAnalyst,
    });
    expect(result.hindsight).toEqual(failed);
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.lane !== "hindsight")).toBe(true);
  });
});
