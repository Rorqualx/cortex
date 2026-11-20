import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrajectoryEvent } from "../trajectory/types.js";
import type { RepetitionCandidate } from "./detector.js";

// ARCH-1: flag-gated detector wiring for trajectory reliability (T-D1..T-D5
// per lab docs 2026-11-18 → 2026-11-19). Env law: the flag is a module-scope
// const, so flag-ON tests must vi.resetModules() + set the env var BEFORE
// dynamically importing detector.js; flag-OFF tests import with it unset.

function event(partial: Partial<TrajectoryEvent> & { type: string }): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace",
    source: "transcript",
    type: partial.type,
    ts: partial.ts ?? "2026-11-20T06:00:00.000Z",
    seq: partial.seq ?? 1,
    sessionId: partial.sessionId ?? "sess-1",
    data: partial.data ?? {},
  };
}

function toolCall(name: string, seq = 0): TrajectoryEvent {
  return event({ type: "tool.call", data: { name }, seq });
}

function toolResult(
  textOrError: string | { isError: true; text: string },
  seq = 0,
): TrajectoryEvent {
  if (typeof textOrError === "string") {
    return event({
      type: "tool.result",
      data: { message: { role: "toolResult", content: textOrError } },
      seq,
    });
  }
  return event({
    type: "tool.result",
    data: {
      message: {
        role: "toolResult",
        isError: textOrError.isError,
        content: textOrError.text,
      },
    },
    seq,
  });
}

async function writeCapture(dir: string, events: TrajectoryEvent[]): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  await fsp.writeFile(path.join(dir, "events.jsonl"), `${body}\n`, "utf8");
}

/** Clean capture: single successful tool call (tool-shape ["grep"]). */
function cleanEvents(): TrajectoryEvent[] {
  return [toolCall("grep", 1), toolResult("found", 2)];
}

/** Tainted capture: same tool-shape, but the tool call errors (score 0.5). */
function taintedEvents(): TrajectoryEvent[] {
  return [toolCall("grep", 1), toolResult({ isError: true, text: "boom" }, 2)];
}

type DetectorModule = typeof import("./detector.js");

async function importDetector(flagOn: boolean): Promise<DetectorModule> {
  vi.resetModules();
  if (flagOn) {
    process.env.OPENCLAW_SKILL_FORGE_TRAJECTORY_RELIABILITY = "1";
  } else {
    delete process.env.OPENCLAW_SKILL_FORGE_TRAJECTORY_RELIABILITY;
  }
  return await import("./detector.js");
}

let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "arch1-detector-"));
});

afterEach(async () => {
  delete process.env.OPENCLAW_SKILL_FORGE_TRAJECTORY_RELIABILITY;
  vi.resetModules();
  await fsp.rm(root, { recursive: true, force: true });
});

function toolShapeCandidate(
  candidates: Awaited<ReturnType<DetectorModule["runDetector"]>>,
): RepetitionCandidate | undefined {
  return candidates.find((candidate) => candidate.lane === "tool-shape") as
    | RepetitionCandidate
    | undefined;
}

async function mixedClusterDirs(): Promise<string[]> {
  // 3 captures sharing the tool-shape ["grep"] (≥ REPETITION_THRESHOLD):
  // two clean, one tainted.
  const dirs = [path.join(root, "cap-a"), path.join(root, "cap-b"), path.join(root, "cap-c")];
  await writeCapture(dirs[0]!, cleanEvents());
  await writeCapture(dirs[1]!, cleanEvents());
  await writeCapture(dirs[2]!, taintedEvents());
  return dirs;
}

describe("detector trajectory-reliability wiring (ARCH-1)", () => {
  it("T-D1: flag OFF keeps the binary collapse and emits no trajectory fields", async () => {
    const detector = await importDetector(false);
    const candidates = await detector.runDetector({ captureDirs: await mixedClusterDirs() });
    const cand = toolShapeCandidate(candidates);
    if (!cand) throw new Error("expected a tool-shape candidate");
    expect(cand.occurrences).toBe(3);
    expect(cand.successScore).toBe(0.5);
    expect("trajectoryWeights" in cand).toBe(false);
  });

  it("T-D2: flag ON merges a mixed cluster to the weighted mean (0.833) with aligned weights [1,1,1]", async () => {
    const detector = await importDetector(true);
    const candidates = await detector.runDetector({ captureDirs: await mixedClusterDirs() });
    const cand = toolShapeCandidate(candidates);
    if (!cand) throw new Error("expected a tool-shape candidate");
    expect(cand.successScore).toBe(0.833);
    expect(cand.trajectoryWeights).toBeDefined();
    expect(cand.trajectoryWeights?.map((w) => w.captureDir)).toEqual(cand.captureDirs);
    expect(cand.trajectoryWeights?.map((w) => w.reliability)).toEqual([1, 1, 1]);
  });

  it("T-D3: flag ON all-clean cluster stays exactly 1.0", async () => {
    const detector = await importDetector(true);
    const dirs = [path.join(root, "a"), path.join(root, "b"), path.join(root, "c")];
    for (const dir of dirs) {
      await writeCapture(dir, cleanEvents());
    }
    const cand = toolShapeCandidate(await detector.runDetector({ captureDirs: dirs }));
    if (!cand) throw new Error("expected a tool-shape candidate");
    expect(cand.successScore).toBe(1);
    expect(cand.trajectoryWeights?.map((w) => w.reliability)).toEqual([1, 1, 1]);
  });

  it("T-D4: flag ON all-tainted cluster stays exactly 0.5", async () => {
    const detector = await importDetector(true);
    const dirs = [path.join(root, "a"), path.join(root, "b"), path.join(root, "c")];
    for (const dir of dirs) {
      await writeCapture(dir, taintedEvents());
    }
    const cand = toolShapeCandidate(await detector.runDetector({ captureDirs: dirs }));
    if (!cand) throw new Error("expected a tool-shape candidate");
    expect(cand.successScore).toBe(0.5);
  });

  it("T-D5: flag ON can never flip a candidate across the clean/borderline boundary", async () => {
    const detector = await importDetector(true);
    // Mixed: strictly inside [0.5, 1) — the borderline band the promoter consumes.
    const mixed = toolShapeCandidate(
      await detector.runDetector({ captureDirs: await mixedClusterDirs() }),
    );
    if (!mixed) throw new Error("expected a mixed tool-shape candidate");
    expect(mixed.successScore).toBeGreaterThanOrEqual(0.5);
    expect(mixed.successScore).toBeLessThan(1);

    const taintedDirs = [path.join(root, "t1"), path.join(root, "t2"), path.join(root, "t3")];
    for (const dir of taintedDirs) {
      await writeCapture(dir, taintedEvents());
    }
    const allTainted = toolShapeCandidate(await detector.runDetector({ captureDirs: taintedDirs }));
    if (!allTainted) throw new Error("expected an all-tainted tool-shape candidate");
    expect(allTainted.successScore).toBe(0.5);

    const cleanDirs = [path.join(root, "c1"), path.join(root, "c2"), path.join(root, "c3")];
    for (const dir of cleanDirs) {
      await writeCapture(dir, cleanEvents());
    }
    const allClean = toolShapeCandidate(await detector.runDetector({ captureDirs: cleanDirs }));
    if (!allClean) throw new Error("expected an all-clean tool-shape candidate");
    expect(allClean.successScore).toBe(1);
  });

  it("threads trajectoryReliability onto single-capture lanes only when flag ON", async () => {
    const dir = path.join(root, "recovery");
    await writeCapture(dir, [
      toolCall("write_file", 1),
      toolResult({ isError: true, text: "ENOENT: no such directory" }, 2),
      toolCall("mkdir", 3),
      toolResult("ok", 4),
    ]);

    const on = await importDetector(true);
    const onCandidates = await on.runDetector({ captureDirs: [dir] });
    const recoveryOn = onCandidates.find((c) => c.lane === "error-recovery");
    if (!recoveryOn) throw new Error("expected an error-recovery candidate");
    expect(recoveryOn.successScore).toBe(0.5);
    expect(recoveryOn.trajectoryReliability).toBe(1);

    const off = await importDetector(false);
    const offCandidates = await off.runDetector({ captureDirs: [dir] });
    const recoveryOff = offCandidates.find((c) => c.lane === "error-recovery");
    if (!recoveryOff) throw new Error("expected an error-recovery candidate (flag OFF)");
    expect(recoveryOff.successScore).toBe(0.5);
    expect("trajectoryReliability" in recoveryOff).toBe(false);
  });
});
