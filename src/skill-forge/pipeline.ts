import fsp from "node:fs/promises";
import path from "node:path";
import { generateCrossoverCandidates } from "./crossover.js";
import { runDetector, writeCandidatesToForge, type Candidate } from "./detector.js";
import { distillProseBodyWithLlm } from "./distiller-llm.js";
import {
  distillCandidateToStaging,
  skillNameForCandidate,
  type DraftedSkill,
} from "./distiller.js";
import {
  detectEmbeddingRepetitionCandidates,
  type EmbeddingClusteringReport,
} from "./embedding-clusterer.js";
import { tryResolveSkillForgeEmbeddingProvider } from "./embedding-provider.js";
import { nameCollisionCheck } from "./gate.js";
import { resolveSkillForgeSessionsDir } from "./paths.js";
import { promoteStagedSkill, type PromotionResult } from "./promoter.js";
import { judgeSkillCandidateWithLlm, type LlmReplayGateResult } from "./replay-gate.js";
import { compressDraftedSkill } from "./skill-compressor.js";
import { recordSkillCreation } from "./telemetry.js";

export type PipelineRunInput = {
  captureDirs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Set false to skip LLM distillation and keep heuristic draft bodies. */
  useLlm?: boolean;
  /** Agent whose default model runs LLM distillation; defaults to the configured default agent. */
  agentId?: string;
  /** Opt-in: run the embedding clustering lane (needs a configured memory embedding provider). */
  useEmbedding?: boolean;
  /** Opt-in: run the LLM-as-judge replay gate over each drafted skill. */
  useLlmReplay?: boolean;
  /** Injectable LLM prose pass forwarded to the distiller (tests); wins over useLlm/agentId. */
  distillProse?: Parameters<typeof distillCandidateToStaging>[0]["distillProse"];
  /**
   * Injectable embedding-provider resolution (tests); wins over the runtime-config lookup.
   * The real resolver reads ambient config and can load the whole plugin graph, so pipeline
   * tests inject instead of paying that cost and inheriting the host machine's config.
   */
  resolveEmbeddingProvider?: typeof tryResolveSkillForgeEmbeddingProvider;
  /** Opt-in: generate crossover candidates from high-success pairs (Frontis-MA1 Crossover operator). Default false. */
  enableCrossover?: boolean;
};

/** Embedding clustering lane outcome. `disabled` unless `useEmbedding` was set. */
export type EmbeddingLaneResult =
  | { status: "disabled" }
  | { status: "unavailable"; reason: string }
  | { status: "ran"; providerId: string; model: string; report: EmbeddingClusteringReport };

/** LLM replay-gate outcome over the drafted skills (present only when `useLlmReplay`). */
export type LlmReplayLaneResult = {
  status: "ran";
  judged: Array<{ name: string; gate: LlmReplayGateResult }>;
};

/**
 * Controlled-budget parallel sampling baseline for Skill Forge promotions.
 *
 * When the LLM-replay lane is implemented, skill promotion must verify that the
 * candidate skill beats a simple parallel-sampling baseline at a matched token
 * budget. This prevents promoting skills that are just "extra compute in disguise."
 *
 * Protocol:
 * 1. Run N parallel samples WITHOUT the candidate skill (baseline).
 * 2. Run N samples WITH the skill (treatment).
 * 3. Compare success rates at matched token budget.
 * 4. Promotion gate: skill must beat baseline by > Δ% (configurable, suggest 10%).
 *
 * SEE: openclaw-analysis-2026-07-19 (Finding #6 — Harness Evolution)
 */
export type ParallelSamplingBaseline = {
  /** Number of parallel samples per condition (baseline and treatment). */
  sampleCount: number;
  /** Token budget per sample (both conditions get the same budget). */
  tokenBudgetPerSample: number;
  /** Minimum improvement percentage required for promotion (e.g. 0.10 = 10%). */
  promotionThresholdDelta: number;
  /** Baseline (without skill) success rate [0,1]. */
  baselineSuccessRate: number;
  /** Treatment (with skill) success rate [0,1]. */
  treatmentSuccessRate: number;
  /** Whether the candidate beat the threshold. */
  beatsBaseline: boolean;
};

/**
 * Variance-hardened gate over the controlled-budget evaluation protocol
 * (arXiv:2608.18066: un-hardened promotion gates pass noise). A skill must
 * clear FOUR bars, not just the mean delta:
 *   1. pass-rate floor — treatment success rate ≥ minTreatmentPassRate;
 *   2. baseline delta  — treatment − baseline > promotionThresholdDelta;
 *   3. variance ceiling — across seeded shuffles of session order, the
 *      variance of bucket success rates stays ≤ maxBucketRateVariance
 *      (order-clustered wins — a skill that only helps one contiguous run
 *      of sessions — blow this up);
 *   4. leave-one-out stability — dropping ANY single treatment session must
 *      still leave treatment > baseline (one lucky session cannot carry the
 *      promotion).
 * Pure + deterministic (seeded mulberry32 PRNG) so it is unit-testable.
 */
export type SessionOutcome = { sessionId: string; success: boolean };

export type SamplingBaselineGateResult = {
  sampleCount: number;
  baselineSuccessRate: number;
  treatmentSuccessRate: number;
  promotionThresholdDelta: number;
  beatsBaseline: boolean;
  /** Bar 1: treatment rate at or above the pass-rate floor. */
  passRateFloorMet: boolean;
  /** Bar 3: shuffled-bucket rate variance (population variance). */
  bucketRateVariance: number;
  varianceCeilingMet: boolean;
  /** Bar 4: every leave-one-out treatment rate still beats baseline. */
  leaveOneOutStable: boolean;
  status: "pass" | "fail";
  reasons: string[];
};

export const DEFAULT_SAMPLING_GATE_CONFIG = {
  /** Treatment must succeed at least half the sampled sessions. */
  minTreatmentPassRate: 0.5,
  /** Max population variance of shuffled bucket success rates. */
  maxBucketRateVariance: 0.15,
  /** Buckets per shuffled ordering. */
  shuffleBuckets: 3,
  /** Shuffled orderings evaluated (different seeds). */
  shuffleSeeds: 5,
} as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function populationVariance(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
}

function shuffledOrder<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

function successRate(samples: readonly SessionOutcome[]): number {
  if (samples.length === 0) {
    return 0;
  }
  return samples.filter((s) => s.success).length / samples.length;
}

export function evaluateSamplingBaselineGate(params: {
  baseline: readonly SessionOutcome[];
  treatment: readonly SessionOutcome[];
  promotionThresholdDelta: number;
  minTreatmentPassRate?: number;
  maxBucketRateVariance?: number;
  shuffleBuckets?: number;
  shuffleSeeds?: number;
}): SamplingBaselineGateResult {
  const minTreatmentPassRate =
    params.minTreatmentPassRate ?? DEFAULT_SAMPLING_GATE_CONFIG.minTreatmentPassRate;
  const maxBucketRateVariance =
    params.maxBucketRateVariance ?? DEFAULT_SAMPLING_GATE_CONFIG.maxBucketRateVariance;
  const shuffleBuckets = params.shuffleBuckets ?? DEFAULT_SAMPLING_GATE_CONFIG.shuffleBuckets;
  const shuffleSeeds = params.shuffleSeeds ?? DEFAULT_SAMPLING_GATE_CONFIG.shuffleSeeds;
  const baselineRate = successRate(params.baseline);
  const treatmentRate = successRate(params.treatment);
  const reasons: string[] = [];

  if (params.baseline.length === 0 || params.treatment.length === 0) {
    return {
      sampleCount: params.treatment.length,
      baselineSuccessRate: baselineRate,
      treatmentSuccessRate: treatmentRate,
      promotionThresholdDelta: params.promotionThresholdDelta,
      beatsBaseline: false,
      passRateFloorMet: false,
      bucketRateVariance: 0,
      varianceCeilingMet: false,
      leaveOneOutStable: false,
      status: "fail",
      reasons: ["empty baseline or treatment sample set"],
    };
  }

  // Bar 1: pass-rate floor.
  const passRateFloorMet = treatmentRate >= minTreatmentPassRate;
  if (!passRateFloorMet) {
    reasons.push(
      `treatment pass rate ${treatmentRate.toFixed(2)} below floor ${minTreatmentPassRate}`,
    );
  }

  // Bar 2: baseline delta.
  const beatsBaseline = treatmentRate - baselineRate > params.promotionThresholdDelta;
  if (!beatsBaseline) {
    reasons.push(
      `treatment-baseline delta ${(treatmentRate - baselineRate).toFixed(2)} does not exceed threshold ${params.promotionThresholdDelta}`,
    );
  }

  // Bar 3: variance ceiling across seeded shuffles of session order. Each
  // shuffle splits the treatment outcomes into contiguous buckets; a skill
  // whose wins cluster in a run of sessions yields wildly uneven bucket rates.
  const bucketCount = Math.max(1, Math.min(shuffleBuckets, params.treatment.length));
  const bucketRates: number[] = [];
  for (let seed = 0; seed < shuffleSeeds; seed += 1) {
    const order = shuffledOrder(params.treatment, mulberry32(seed));
    const bucketSize = Math.ceil(order.length / bucketCount);
    for (let b = 0; b < bucketCount; b += 1) {
      const bucket = order.slice(b * bucketSize, (b + 1) * bucketSize);
      if (bucket.length > 0) {
        bucketRates.push(successRate(bucket));
      }
    }
  }
  const bucketRateVariance = populationVariance(bucketRates);
  const varianceCeilingMet = bucketRateVariance <= maxBucketRateVariance;
  if (!varianceCeilingMet) {
    reasons.push(
      `shuffled-bucket rate variance ${bucketRateVariance.toFixed(3)} exceeds ceiling ${maxBucketRateVariance}`,
    );
  }

  // Bar 4: leave-one-out stability — dropping any single session must keep
  // treatment strictly above baseline.
  let leaveOneOutStable = true;
  if (params.treatment.length < 2) {
    leaveOneOutStable = false;
    reasons.push("fewer than 2 treatment sessions — leave-one-out stability unprovable");
  } else {
    for (let i = 0; i < params.treatment.length; i += 1) {
      const rest = params.treatment.filter((_, idx) => idx !== i);
      if (successRate(rest) <= baselineRate) {
        leaveOneOutStable = false;
        reasons.push(
          `leave-one-out: dropping session ${params.treatment[i]?.sessionId} drops treatment to/below baseline`,
        );
        break;
      }
    }
  }

  const pass = *** && beatsBaseline && varianceCeilingMet && leaveOneOutStable;
  return {
    sampleCount: params.treatment.length,
    baselineSuccessRate: baselineRate,
    treatmentSuccessRate: treatmentRate,
    promotionThresholdDelta: params.promotionThresholdDelta,
    beatsBaseline,
    passRateFloorMet,
    bucketRateVariance,
    varianceCeilingMet,
    leaveOneOutStable,
    status: pass ? "pass" : "fail",
    reasons: pass ? [] : reasons,
  };
}

export type PipelineRunResult = {
  scannedCaptureDirs: number;
  candidates: Candidate[];
  candidateFiles: string[];
  drafted: DraftedSkill[];
  promotions: PromotionResult[];
  /** Candidate skill names skipped because the capability was already crystallized (promoted/retired). */
  skipped: string[];
  /** Embedding clustering lane outcome (disabled unless useEmbedding). */
  embedding: EmbeddingLaneResult;
  /** LLM replay-gate outcome over drafted skills; present only when useLlmReplay. */
  llmReplay?: LlmReplayLaneResult;
  /** Crossover candidates generated from high-success pairs (Frontis-MA1). */
  crossover: { generated: number; candidateIds: string[] };
};

/** Maps CLI-level useLlm/agentId options onto the distiller's injectable seam. */
function resolveDistillProseOverride(
  input: PipelineRunInput,
): Parameters<typeof distillCandidateToStaging>[0]["distillProse"] {
  if (input.useLlm === false) {
    return async () => ({ status: "skipped", reason: "LLM distillation disabled" });
  }
  if (input.agentId) {
    const agentId = input.agentId;
    return (args) => distillProseBodyWithLlm({ ...args, agentId });
  }
  return undefined;
}

async function discoverCaptureDirs(env: NodeJS.ProcessEnv): Promise<string[]> {
  const dir = resolveSkillForgeSessionsDir(env);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of entries) {
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      if (stat.isDirectory()) {
        dirs.push(full);
      }
    } catch {
      // Skip unreadable entries.
    }
  }
  return dirs;
}

/** Read a drafted skill's SKILL.md body for the replay judge; empty string if unreadable. */
async function readDraftedBody(draft: DraftedSkill): Promise<string> {
  try {
    return await fsp.readFile(draft.skillMdPath, "utf8");
  } catch {
    return "";
  }
}

export async function runForgePipeline(input: PipelineRunInput = {}): Promise<PipelineRunResult> {
  const env = input.env ?? process.env;
  const captureDirs = input.captureDirs ?? (await discoverCaptureDirs(env));
  const candidates = await runDetector({ captureDirs });

  // Embedding lane (semantic clustering): opt-in. Resolves a memory embedding
  // provider, clusters captures by cosine + tool-shape, and merges the extra
  // repetition candidates into the batch so they distill/promote like detector
  // candidates. Inert (disabled) unless requested or when no provider resolves.
  let embedding: EmbeddingLaneResult = { status: "disabled" };
  if (input.useEmbedding) {
    const resolveProvider = input.resolveEmbeddingProvider ?? tryResolveSkillForgeEmbeddingProvider;
    const resolution = await resolveProvider(input.agentId ? { agentId: input.agentId } : {});
    if (resolution.status === "unavailable") {
      embedding = { status: "unavailable", reason: resolution.reason };
    } else {
      const report = await detectEmbeddingRepetitionCandidates({
        captureDirs,
        options: { embed: resolution.embed },
      });
      embedding = {
        status: "ran",
        providerId: resolution.providerId,
        model: resolution.model,
        report,
      };
      for (const candidate of report.candidates) {
        if (!candidates.some((existing) => existing.candidateId === candidate.candidateId)) {
          candidates.push(candidate);
        }
      }
    }
  }

  // Crossover operator (Frontis-MA1, arXiv:2607.28568): generates merged
  // candidates from pairs of high-success candidates with complementary tool
  // sequences. Opt-in via enableCrossover. Disabled by default.
  let crossoverResult = { generated: 0, candidateIds: [] as string[] };
  if (input.enableCrossover && candidates.length >= 2) {
    const xoverCandidates = generateCrossoverCandidates(candidates);
    for (const xover of xoverCandidates) {
      if (!candidates.some((existing) => existing.candidateId === xover.candidateId)) {
        candidates.push(xover);
      }
    }
    crossoverResult = {
      generated: xoverCandidates.length,
      candidateIds: xoverCandidates.map((c) => c.candidateId),
    };
  }

  const candidateFiles = await writeCandidatesToForge(candidates, env);
  const distillProse = input.distillProse ?? resolveDistillProseOverride(input);
  const drafted: DraftedSkill[] = [];
  const promotions: PromotionResult[] = [];
  const skipped: string[] = [];
  // Drafted skills paired with their source candidate, for the optional replay gate.
  const judgeTargets: Array<{ candidate: Candidate; draft: DraftedSkill }> = [];
  for (const candidate of candidates) {
    const name = skillNameForCandidate(candidate);
    // Skip candidates whose capability is already crystallized. The detector
    // emits a stable name per capability, so a promoted/retired match means this
    // skill already exists; re-distilling would re-stage a duplicate that the
    // gate then rejects, leaving orphaned staging dirs — the churn that buried
    // working skills under unused re-forges. The candidate file is still written
    // above, so the detection is not lost.
    const collision = await nameCollisionCheck({ name, env });
    if (collision.status === "fail") {
      skipped.push(name);
      continue;
    }
    const draft = await distillCandidateToStaging({
      candidate,
      env,
      ...(distillProse && { distillProse }),
    });
    // QW-2: Zip-on-Write — compress the drafted skill body to remove
    // intra-skill redundancy before the promotion gate. Coverage-safe:
    // skips compression if tool refs or triggers would be lost.
    await compressDraftedSkill(draft.skillMdPath);
    drafted.push(draft);
    judgeTargets.push({ candidate, draft });
    await recordSkillCreation({ name: draft.name, env });
    const promotion = await promoteStagedSkill({
      name: draft.name,
      env,
      successScore: candidate.successScore,
    });
    promotions.push(promotion);
  }

  // LLM replay gate (LLM-as-judge): opt-in. Judges each drafted skill body for
  // safety + usefulness. Diagnostic only here — it reports verdicts without
  // gating promotion (promotion already ran above via the strict frontmatter gate).
  let llmReplay: LlmReplayLaneResult | undefined;
  if (input.useLlmReplay) {
    const judged: Array<{ name: string; gate: LlmReplayGateResult }> = [];
    for (const target of judgeTargets) {
      const draftedBody = await readDraftedBody(target.draft);
      const gate = await judgeSkillCandidateWithLlm({
        candidate: target.candidate,
        draftedBody,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      judged.push({ name: target.draft.name, gate });
    }
    llmReplay = { status: "ran", judged };
  }

  return {
    scannedCaptureDirs: captureDirs.length,
    candidates,
    candidateFiles,
    drafted,
    promotions,
    skipped,
    embedding,
    crossover: crossoverResult,
    ...(llmReplay ? { llmReplay } : {}),
  };
}
