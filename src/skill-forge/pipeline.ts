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
import {
  judgeSkillCandidateWithLlmAgreement,
  type LlmReplayGateResult,
  type ReplayAgreementResult,
} from "./replay-gate.js";
import { compressDraftedSkill } from "./skill-compressor.js";
import { recordSkillCreation, recordSkillPromotion } from "./telemetry.js";

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
  judged: Array<{ name: string; gate: LlmReplayGateResult | ReplayAgreementResult }>;
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
    // Multi-run agreement (QW3 2026-08-23): k judge runs per skill (default 3,
    // env-tunable via OPENCLAW_SKILL_FORGE_REPLAY_RUNS). The pass rate feeds
    // the gate's robustness facet; variance is stamped on the telemetry card
    // so promotion decisions can weigh judge stability.
    const judged: Array<{ name: string; gate: LlmReplayGateResult | ReplayAgreementResult }> = [];
    for (const target of judgeTargets) {
      const draftedBody = await readDraftedBody(target.draft);
      const gate = await judgeSkillCandidateWithLlmAgreement({
        candidate: target.candidate,
        draftedBody,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      judged.push({ name: target.draft.name, gate });
      if (gate.status === "ran") {
        try {
          await recordSkillPromotion({
            name: target.draft.name,
            env,
            replayAgreement: {
              runs: gate.stats.runs,
              passRate: gate.stats.passRate,
              agreement: gate.stats.agreement,
              variance: gate.stats.variance,
              provider: gate.provider,
              modelId: gate.modelId,
            },
          });
        } catch {
          // Telemetry is best-effort — the lane result below carries the same data.
        }
      }
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
