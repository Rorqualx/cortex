import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TrajectoryEvent } from "../trajectory/types.js";
import {
  detectErrorRecovery,
  detectExplicitInstructions,
  EMBEDDING_LANE_TODO,
  embeddingClusteringStub,
  extractToolSequence,
  hashToolSequence,
  REPETITION_THRESHOLD,
  runDetector,
  writeCandidatesToForge,
  type Candidate,
} from "./detector.js";

function event(partial: Partial<TrajectoryEvent> & { type: string }): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "trace",
    source: "transcript",
    type: partial.type,
    ts: partial.ts ?? "2026-05-20T17:30:45.000Z",
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

function userMessage(text: string, seq = 0): TrajectoryEvent {
  return event({
    type: "user.message",
    data: { message: { role: "user", content: [{ type: "text", text }] } },
    seq,
  });
}

async function writeCapture(dir: string, events: TrajectoryEvent[]): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join("\n");
  await fsp.writeFile(path.join(dir, "events.jsonl"), `${body}\n`, "utf8");
}

describe("extractToolSequence / hashToolSequence", () => {
  it("returns only tool.call names in order", () => {
    const events = [
      userMessage("hello"),
      toolCall("read_file"),
      toolResult("ok"),
      toolCall("grep"),
      toolResult("found"),
    ];
    expect(extractToolSequence(events)).toEqual(["read_file", "grep"]);
  });

  it("produces stable short hash for identical sequences", () => {
    expect(hashToolSequence(["a", "b", "c"])).toBe(hashToolSequence(["a", "b", "c"]));
    expect(hashToolSequence(["a", "b", "c"])).not.toBe(hashToolSequence(["a", "c", "b"]));
    expect(hashToolSequence(["a"])).toHaveLength(16);
  });
});

describe("detectErrorRecovery", () => {
  it("flags [tool.call → error → tool.call → ok]", () => {
    const motifs = detectErrorRecovery([
      toolCall("write_file"),
      toolResult({ isError: true, text: "ENOENT: no such directory" }),
      toolCall("mkdir"),
      toolResult("ok"),
      toolCall("write_file"),
      toolResult("ok"),
    ]);
    expect(motifs).toHaveLength(1);
    expect(motifs[0].failingTool).toBe("write_file");
    expect(motifs[0].recoveringTool).toBe("mkdir");
    expect(motifs[0].recoverySequence).toEqual(["mkdir"]);
  });

  it("does not flag when no recovery happens", () => {
    const motifs = detectErrorRecovery([
      toolCall("write_file"),
      toolResult({ isError: true, text: "EACCES" }),
    ]);
    expect(motifs).toEqual([]);
  });

  it("treats text containing 'error' as failure even without isError flag", () => {
    const motifs = detectErrorRecovery([
      toolCall("api_call"),
      toolResult("HTTP 500 internal server error"),
      toolCall("retry_with_backoff"),
      toolResult("ok"),
    ]);
    expect(motifs).toHaveLength(1);
    expect(motifs[0].recoveringTool).toBe("retry_with_backoff");
  });
});

describe("detectExplicitInstructions", () => {
  it("matches each known phrase once per user message", () => {
    const matches = detectExplicitInstructions([
      userMessage("can you turn this into a skill please"),
      userMessage("unrelated"),
      userMessage("/skills create my-thing"),
    ]);
    expect(matches.map((m) => m.matchedPhrase)).toEqual([
      "turn this into a skill",
      "/skills create",
    ]);
  });

  it("truncates the prompt excerpt to 200 chars", () => {
    const long = "x".repeat(500);
    const matches = detectExplicitInstructions([userMessage(`save this as a skill ${long}`)]);
    expect(matches[0].promptExcerpt).toHaveLength(200);
    expect(matches[0].matchedPhrase).toBe("save this as a skill");
  });
});

describe("embeddingClusteringStub", () => {
  it("throws with the deferred-implementation marker", () => {
    expect(() => embeddingClusteringStub()).toThrow(EMBEDDING_LANE_TODO);
  });
});

describe("runDetector", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-detector-test-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("emits a repetition candidate when ≥ threshold captures share a tool shape", async () => {
    const dirs: string[] = [];
    for (let i = 0; i < REPETITION_THRESHOLD; i += 1) {
      const dir = path.join(tmpDir, `cap-${i}`);
      dirs.push(dir);
      await writeCapture(dir, [
        toolCall("read_file"),
        toolResult("ok"),
        toolCall("grep"),
        toolResult("ok"),
      ]);
    }
    // A different-shape capture that should not join the cluster.
    const otherDir = path.join(tmpDir, "cap-other");
    await writeCapture(otherDir, [toolCall("write_file"), toolResult("ok")]);

    const candidates = await runDetector({ captureDirs: [...dirs, otherDir] });
    const repetitions = candidates.filter(
      (c): c is Extract<Candidate, { lane: "tool-shape" }> => c.lane === "tool-shape",
    );
    expect(repetitions).toHaveLength(1);
    expect(repetitions[0].occurrences).toBe(REPETITION_THRESHOLD);
    expect(repetitions[0].toolSequence).toEqual(["read_file", "grep"]);
    expect(repetitions[0].captureDirs).toEqual(dirs);
  });

  it("emits error-recovery and explicit candidates per-capture", async () => {
    const dir = path.join(tmpDir, "cap-mixed");
    await writeCapture(dir, [
      userMessage("turn this into a skill"),
      toolCall("write_file"),
      toolResult({ isError: true, text: "ENOENT" }),
      toolCall("mkdir"),
      toolResult("ok"),
    ]);
    const candidates = await runDetector({ captureDirs: [dir] });
    expect(candidates.map((c) => c.lane).toSorted()).toEqual(["error-recovery", "explicit"]);
  });

  it("skips empty captures gracefully", async () => {
    const dir = path.join(tmpDir, "cap-empty");
    await fsp.mkdir(dir, { recursive: true });
    const candidates = await runDetector({ captureDirs: [dir] });
    expect(candidates).toEqual([]);
  });

  it("scores clean explicit captures 1.0 and frustrated or erroring captures 0.5", async () => {
    const cleanDir = path.join(tmpDir, "cap-clean");
    await writeCapture(cleanDir, [
      userMessage("turn this into a skill"),
      toolCall("read_file"),
      toolResult("ok"),
    ]);
    const frustratedDir = path.join(tmpDir, "cap-frustrated");
    await writeCapture(frustratedDir, [
      userMessage("make this a skill"),
      userMessage("that's wrong, it's still broken"),
      toolCall("read_file"),
      toolResult("ok"),
    ]);
    const erroringDir = path.join(tmpDir, "cap-error");
    await writeCapture(erroringDir, [
      userMessage("save this as a skill"),
      toolCall("write_file"),
      toolResult({ isError: true, text: "ENOENT" }),
      toolCall("mkdir"),
      toolResult("ok"),
    ]);

    const candidates = await runDetector({
      captureDirs: [cleanDir, frustratedDir, erroringDir],
    });
    const explicitByDir = new Map(
      candidates
        .filter((c): c is Extract<Candidate, { lane: "explicit" }> => c.lane === "explicit")
        .map((c) => [c.captureDir, c.successScore]),
    );
    // Score is blended: 85% base (completion + errors) + 15% domain expertise.
    // Test captures have no constraint keywords, no verification tools, and no
    // errors → direction precision is neutral (0.5), giving expertise of 0.167.
    expect(explicitByDir.get(cleanDir)).toBeCloseTo(0.875, 3);
    expect(explicitByDir.get(frustratedDir)).toBeCloseTo(0.45, 2);
    // Error case has 1 user message, 1 tool error → direction precision = 0.111.
    expect(explicitByDir.get(erroringDir)).toBeCloseTo(0.4306, 3);
    // Error-recovery captures contain a tool error by definition.
    const recovery = candidates.find((c) => c.lane === "error-recovery");
    expect(recovery?.successScore).toBeCloseTo(0.4306, 3);
  });

  it("ordinary coding language does not taint the success score", async () => {
    const dir = path.join(tmpDir, "cap-ordinary");
    await writeCapture(dir, [
      userMessage("remember this workflow: fix the error in the parser, no rush"),
      toolCall("read_file"),
      toolResult("ok"),
    ]);
    const candidates = await runDetector({ captureDirs: [dir] });
    const explicit = candidates.find((c) => c.lane === "explicit");
    // Blended: 0.85 × 1.0 + 0.15 × (0+0+0.5)/3 ≈ 0.875 for clean captures
    // without domain-expertise signals in the test data.
    expect(explicit?.successScore).toBeCloseTo(0.875, 3);
  });

  it("one tainted member pins the whole tool-shape cluster at 0.5", async () => {
    const dirs: string[] = [];
    for (let i = 0; i < REPETITION_THRESHOLD; i += 1) {
      const dir = path.join(tmpDir, `cap-cluster-${i}`);
      dirs.push(dir);
      const events = [toolCall("read_file"), toolResult("ok"), toolCall("grep"), toolResult("ok")];
      if (i === 0) {
        events.unshift(userMessage("this is still not working"));
      }
      await writeCapture(dir, events);
    }
    const candidates = await runDetector({ captureDirs: dirs });
    const repetition = candidates.find((c) => c.lane === "tool-shape");
    expect(repetition?.successScore).toBe(0.5);
  });
});

describe("writeCandidatesToForge", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-detector-write-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("writes one JSON file per candidate under candidates/", async () => {
    const candidate: Candidate = {
      lane: "explicit",
      successScore: 1,
      candidateId: "abc123",
      captureDir: "/fake",
      toolSequence: ["a"],
      matchedPhrase: "/skills create",
      promptExcerpt: "p",
      rationale: "r",
    };
    const files = await writeCandidatesToForge([candidate], {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_TEST_FAST: "1",
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.join(stateDir, "skill-forge", "candidates", "explicit-abc123.json"));
    const onDisk = JSON.parse(await fsp.readFile(files[0], "utf8"));
    expect(onDisk).toEqual(candidate);
  });
});
