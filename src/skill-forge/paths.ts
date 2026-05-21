import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { safeTrajectorySessionFileName } from "../trajectory/paths.js";

const FORGE_DIR_NAME = "skill-forge";
const SESSIONS_SUBDIR = "sessions";
const CANDIDATES_SUBDIR = "candidates";
const CLUSTERS_SUBDIR = "clusters";
const STAGING_SUBDIR = "_staging";
const TELEMETRY_SUBDIR = "telemetry";
const SKILLS_SUBDIR = "skills";
const STAGED_SKILLS_SUBDIR = "_staging";
const RETIRED_SKILLS_SUBDIR = "_retired";

export function resolveSkillForgeRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), FORGE_DIR_NAME);
}

export function resolveSkillForgeSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSkillForgeRoot(env), SESSIONS_SUBDIR);
}

export function resolveSkillForgeCandidatesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSkillForgeRoot(env), CANDIDATES_SUBDIR);
}

export function resolveSkillForgeClustersDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSkillForgeRoot(env), CLUSTERS_SUBDIR);
}

export function resolveSkillForgeStagingDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSkillForgeRoot(env), STAGING_SUBDIR);
}

export function resolveSkillForgeTelemetryDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSkillForgeRoot(env), TELEMETRY_SUBDIR);
}

function safeIsoStampForFileName(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function resolveSkillForgeSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSkillForgeRoot(env), SKILLS_SUBDIR);
}

export function resolveSkillForgeStagedSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSkillForgeSkillsRoot(env), STAGED_SKILLS_SUBDIR);
}

export function resolveSkillForgeRetiredSkillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSkillForgeSkillsRoot(env), RETIRED_SKILLS_SUBDIR);
}

export function resolveSkillForgePromotedSkillDir(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return path.join(resolveSkillForgeSkillsRoot(params.env ?? process.env), params.name);
}

export function resolveSkillForgeStagedSkillDir(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return path.join(resolveSkillForgeStagedSkillsDir(params.env ?? process.env), params.name);
}

export function resolveSkillForgeRetiredSkillDir(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return path.join(resolveSkillForgeRetiredSkillsDir(params.env ?? process.env), params.name);
}

export function resolveSkillForgeCaptureDir(params: {
  sessionId: string;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = params.env ?? process.env;
  const stamp = safeIsoStampForFileName(params.now ?? new Date());
  const safeName = safeTrajectorySessionFileName(params.sessionId);
  return path.join(resolveSkillForgeSessionsDir(env), `${safeName}-${stamp}`);
}
