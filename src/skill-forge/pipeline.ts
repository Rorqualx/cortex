import fsp from "node:fs/promises";
import path from "node:path";
import { runDetector, writeCandidatesToForge, type Candidate } from "./detector.js";
import { distillCandidateToStaging, type DraftedSkill } from "./distiller.js";
import { resolveSkillForgeSessionsDir } from "./paths.js";
import { promoteStagedSkill, type PromotionResult } from "./promoter.js";
import { recordSkillCreation } from "./telemetry.js";

export type PipelineRunInput = {
  captureDirs?: string[];
  env?: NodeJS.ProcessEnv;
};

export type PipelineRunResult = {
  scannedCaptureDirs: number;
  candidates: Candidate[];
  candidateFiles: string[];
  drafted: DraftedSkill[];
  promotions: PromotionResult[];
};

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
  const drafted: DraftedSkill[] = [];
  const promotions: PromotionResult[] = [];
  for (const candidate of candidates) {
    const draft = await distillCandidateToStaging({ candidate, env });
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
