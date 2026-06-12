import fsp from "node:fs/promises";
import path from "node:path";
import { runDetector, writeCandidatesToForge, type Candidate } from "./detector.js";
import { distillProseBodyWithLlm } from "./distiller-llm.js";
import { distillCandidateToStaging, type DraftedSkill } from "./distiller.js";
import { resolveSkillForgeSessionsDir } from "./paths.js";
import { promoteStagedSkill, type PromotionResult } from "./promoter.js";
import { recordSkillCreation } from "./telemetry.js";

export type PipelineRunInput = {
  captureDirs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Set false to skip LLM distillation and keep heuristic draft bodies. */
  useLlm?: boolean;
  /** Agent whose default model runs LLM distillation; defaults to the configured default agent. */
  agentId?: string;
  /** Injectable LLM prose pass forwarded to the distiller (tests); wins over useLlm/agentId. */
  distillProse?: Parameters<typeof distillCandidateToStaging>[0]["distillProse"];
};

export type PipelineRunResult = {
  scannedCaptureDirs: number;
  candidates: Candidate[];
  candidateFiles: string[];
  drafted: DraftedSkill[];
  promotions: PromotionResult[];
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

export async function runForgePipeline(input: PipelineRunInput = {}): Promise<PipelineRunResult> {
  const env = input.env ?? process.env;
  const captureDirs = input.captureDirs ?? (await discoverCaptureDirs(env));
  const candidates = await runDetector({ captureDirs });
  const candidateFiles = await writeCandidatesToForge(candidates, env);
  const distillProse = input.distillProse ?? resolveDistillProseOverride(input);
  const drafted: DraftedSkill[] = [];
  const promotions: PromotionResult[] = [];
  for (const candidate of candidates) {
    const draft = await distillCandidateToStaging({
      candidate,
      env,
      ...(distillProse && { distillProse }),
    });
    drafted.push(draft);
    await recordSkillCreation({ name: draft.name, env });
    const promotion = await promoteStagedSkill({ name: draft.name, env });
    promotions.push(promotion);
  }
  return {
    scannedCaptureDirs: captureDirs.length,
    candidates,
    candidateFiles,
    drafted,
    promotions,
  };
}
