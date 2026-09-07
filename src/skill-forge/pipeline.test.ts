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
    const candidate = result.candidates[0];
    if (!candidate) throw new Error("expected candidate");
    expect(candidate.lane).toBe("tool-shape");
    expect(result.drafted).toHaveLength(1);
    const draft = result.drafted[0];
    if (!draft) throw new Error("expected draft");
    expect(result.promotions).toHaveLength(1);
    const promotion = result.promotions[0];
    if (!promotion) throw new Error("expected promotion");
    expect(promotion.status).toBe("promoted");

    const candidatesDir = resolveSkillForgeCandidatesDir(env());
    const candidateFiles = await fsp.readdir(candidatesDir);
    expect(candidateFiles).toHaveLength(1);

    const promotedDir = resolveSkillForgePromotedSkillDir({
      name: draft.name,
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
      skipped: [],
      embedding: { status: "disabled" },
      crossover: { generated: 0, candidateIds: [] },
    });
  });

  it("reports embedding lane unavailable when no embedding provider resolves", async () => {
    // Inject the resolution: the real resolver reads ambient runtime config, so it
    // resolved differently per machine and paid a full plugin-graph load (minutes
    // under Vitest). The lane contract under test is that it reports unavailable
    // rather than throwing -- not how the provider is discovered.
    const result = await runForgePipeline({
      env: env(),
      useEmbedding: true,
      resolveEmbeddingProvider: async () => ({
        status: "unavailable",
        reason: "no embedding provider configured",
      }),
    });
    expect(result.embedding).toEqual({
      status: "unavailable",
      reason: "no embedding provider configured",
    });
  });

  it("runs the llm-replay lane with no judged skills when there are no captures", async () => {
    const result = await runForgePipeline({ env: env(), useLlmReplay: true });
    expect(result.llmReplay).toEqual({ status: "ran", judged: [] });
  });

  it("skips an already-crystallized capability on re-run instead of re-staging a duplicate", async () => {
    const sessionsDir = resolveSkillForgeSessionsDir(env());
    for (let i = 0; i < 3; i += 1) {
      await writeCapture(path.join(sessionsDir, `cap-${i}-2026-05-20T18-00-${i}0`), [
        event("tool.call", { name: "read_file" }),
        event("tool.result", { message: { role: "toolResult", content: "ok" } }),
        event("tool.call", { name: "grep" }),
        event("tool.result", { message: { role: "toolResult", content: "ok" } }),
      ]);
    }

    const first = await runForgePipeline({ env: env() });
    expect(first.drafted).toHaveLength(1);
    expect(first.promotions[0]?.status).toBe("promoted");
    expect(first.skipped).toEqual([]);
    const firstDraft = first.drafted[0];
    if (!firstDraft) throw new Error("expected draft");
    const promotedName = firstDraft.name;

    // Same captures, same detected candidate name: the second run must not
    // re-draft or re-promote — the skill is already crystallized.
    const second = await runForgePipeline({ env: env() });
    expect(second.candidates).toHaveLength(1);
    expect(second.drafted).toHaveLength(0);
    expect(second.promotions).toHaveLength(0);
    expect(second.skipped).toEqual([promotedName]);
  });
});

// ---------------------------------------------------------------------
// QW4: borderline candidates route through the step-rubric judge lane
// ---------------------------------------------------------------------

describe("runForgePipeline — step-rubric routing for borderline candidates", () => {
  let stateDir: string;
  const env = (): NodeJS.ProcessEnv => ({
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_FAST: "1",
  });

  beforeEach(async () => {
    stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-pipeline-rubric-"));
  });

  afterEach(async () => {
    await fsp.rm(stateDir, { recursive: true, force: true });
  });

  it("routes tainted candidates to the step-rubric judge and clean ones to the outcome judge", async () => {
    const sessionsDir = resolveSkillForgeSessionsDir(env());
    // Borderline capture (successScore 0.5): a tool error recovered by mkdir
    // produces an error-recovery candidate from a tainted session.
    await writeCapture(path.join(sessionsDir, "cap-tainted-2026-05-20T18-00-00"), [
      event("tool.call", { name: "write_file" }),
      event("tool.result", {
        message: { role: "toolResult", isError: true, content: "ENOENT" },
      }),
      event("tool.call", { name: "mkdir" }),
      event("tool.result", { message: { role: "toolResult", content: "ok" } }),
    ]);
    // Clean capture (successScore 1): explicit crystallization request.
    await writeCapture(path.join(sessionsDir, "cap-clean-2026-05-20T18-01-00"), [
      event("user.message", {
        message: { role: "user", content: [{ type: "text", text: "turn this into a skill" }] },
      }),
      event("tool.call", { name: "read_file" }),
      event("tool.result", { message: { role: "toolResult", content: "ok" } }),
      event("tool.call", { name: "list_dir" }),
      event("tool.result", { message: { role: "toolResult", content: "ok" } }),
    ]);

    const outcomeCalls: string[] = [];
    const rubricCalls: string[] = [];
    const result = await runForgePipeline({
      env: env(),
      useLlmReplay: true,
      judgeSkill: async ({ candidate }) => {
        outcomeCalls.push(candidate.lane);
        return {
          status: "ran",
          verdict: "SAFE_USEFUL",
          rationale: "outcome judge",
          provider: "test",
          modelId: "test-model",
        };
      },
      judgeStepRubric: async ({ candidate }) => {
        rubricCalls.push(candidate.lane);
        return {
          status: "ran",
          verdict: "SAFE_NEUTRAL",
          rationale: "step-rubric judge",
          provider: "test",
          modelId: "test-model",
          judgeMode: "step-rubric",
          stepScores: [{ step: 1, result: "PASS" }],
          consistency: "PASS",
        };
      },
    });

    expect(result.drafted).toHaveLength(2);
    // Only the tainted error-recovery candidate paid the step-rubric cost.
    expect(rubricCalls).toEqual(["error-recovery"]);
    expect(outcomeCalls).toEqual(["explicit"]);
    const byMode = new Map(result.llmReplay?.judged.map((j) => [j.judgeMode, j.gate]));
    expect(byMode.get("step-rubric")).toMatchObject({ status: "ran", verdict: "SAFE_NEUTRAL" });
    expect(byMode.get("outcome")).toMatchObject({ status: "ran", verdict: "SAFE_USEFUL" });
  });
});
