import fsp from "node:fs/promises";
import path from "node:path";
import { loadWorkspaceSkillEntries } from "../agents/skills/workspace.js";
import {
  autostartStatus,
  installAutostart,
  uninstallAutostart,
  type AutostartInstallResult,
  type AutostartStatus,
  type AutostartUninstallResult,
} from "./autostart.js";
import { captureSessionToForge } from "./capture.js";
import { resolveSkillForgeRoot, resolveSkillForgeSessionsDir } from "./paths.js";
import { runForgePipeline, type PipelineRunResult } from "./pipeline.js";
import { runDecaySweep, type DecayedSkill } from "./promoter.js";
import { listTelemetryEntries, type SkillTelemetryEntry } from "./telemetry.js";
import type { CaptureResult } from "./types.js";
import { parseTrajectoryLine } from "./watcher.js";

export type SessionMetaFromTrajectory = {
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
  sessionKey?: string;
};

export async function readSessionStartedMetaFromTrajectory(
  trajectoryFile: string,
): Promise<SessionMetaFromTrajectory | null> {
  let content: string;
  try {
    content = await fsp.readFile(trajectoryFile, "utf8");
  } catch {
    return null;
  }
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") {
      continue;
    }
    const record = event as Record<string, unknown>;
    if (record.type !== "session.started") {
      continue;
    }
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
    const data = (record.data ?? {}) as Record<string, unknown>;
    const sessionFile = typeof data.sessionFile === "string" ? data.sessionFile : null;
    const workspaceDir = typeof data.workspaceDir === "string" ? data.workspaceDir : null;
    const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : undefined;
    if (sessionId && sessionFile && workspaceDir) {
      return { sessionId, sessionFile, workspaceDir, sessionKey };
    }
    return null;
  }
  return null;
}

export async function hasSessionEndedInTrajectory(
  trajectoryFile: string,
  sessionId: string,
): Promise<boolean> {
  let content: string;
  try {
    content = await fsp.readFile(trajectoryFile, "utf8");
  } catch {
    return false;
  }
  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseTrajectoryLine(line, sessionId);
    if (parsed.kind === "session-ended") {
      return true;
    }
  }
  return false;
}

export async function listAlreadyCapturedSessionIds(env?: NodeJS.ProcessEnv): Promise<Set<string>> {
  const dir = resolveSkillForgeSessionsDir(env);
  const result = new Set<string>();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return result;
  }
  for (const name of entries) {
    const stripped = name.replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/u, "");
    if (stripped && stripped !== name) {
      result.add(stripped);
    }
  }
  return result;
}

export type CaptureDirReport = {
  scannedTrajectories: number;
  captured: Array<{ sessionId: string; outputDir: string }>;
  skipped: Array<{ name: string; reason: string }>;
};

export async function actionCaptureDir(params: {
  dir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CaptureDirReport> {
  const env = params.env ?? process.env;
  let names: string[];
  try {
    names = await fsp.readdir(params.dir);
  } catch (error) {
    throw new Error(
      `failed to read trajectory dir ${params.dir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const trajectoryFiles = names.filter((name) => name.endsWith(".trajectory.jsonl"));
  const report: CaptureDirReport = {
    scannedTrajectories: trajectoryFiles.length,
    captured: [],
    skipped: [],
  };
  for (const name of trajectoryFiles) {
    const trajectoryPath = path.join(params.dir, name);
    const meta = await readSessionStartedMetaFromTrajectory(trajectoryPath);
    if (!meta) {
      report.skipped.push({ name, reason: "no session.started event" });
      continue;
    }
    try {
      await fsp.stat(meta.sessionFile);
    } catch {
      report.skipped.push({
        name: meta.sessionId,
        reason: `session file missing: ${meta.sessionFile}`,
      });
      continue;
    }
    const result = await captureSessionToForge({
      sessionFile: meta.sessionFile,
      sessionId: meta.sessionId,
      sessionKey: meta.sessionKey,
      workspaceDir: meta.workspaceDir,
      runtimeFile: trajectoryPath,
      trigger: "manual",
      env,
    });
    if (result.status === "captured") {
      report.captured.push({ sessionId: meta.sessionId, outputDir: result.outputDir });
    } else {
      report.skipped.push({ name: meta.sessionId, reason: result.reason });
    }
  }
  return report;
}

export async function actionCaptureSingle(params: {
  sessionFile: string;
  sessionId: string;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CaptureResult> {
  return captureSessionToForge({
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    trigger: "manual",
    env: params.env,
  });
}

export async function actionPipeline(
  params: {
    env?: NodeJS.ProcessEnv;
    useLlm?: boolean;
    useEmbedding?: boolean;
    useLlmReplay?: boolean;
    agentId?: string;
  } = {},
): Promise<PipelineRunResult> {
  return runForgePipeline({
    env: params.env,
    useLlm: params.useLlm,
    useEmbedding: params.useEmbedding,
    useLlmReplay: params.useLlmReplay,
    agentId: params.agentId,
  });
}

export type ListForgeReport = {
  root: string;
  subdirs: Array<{ sub: string; entries: string[] }>;
  telemetry: SkillTelemetryEntry[];
};

export async function actionListForge(env?: NodeJS.ProcessEnv): Promise<ListForgeReport> {
  const resolvedEnv = env ?? process.env;
  const root = resolveSkillForgeRoot(resolvedEnv);
  const subs = [
    "sessions",
    "candidates",
    "skills/.staging",
    "skills",
    "skills/.retired",
    "telemetry",
  ];
  const subdirs: ListForgeReport["subdirs"] = [];
  for (const sub of subs) {
    const full = path.join(root, sub);
    try {
      const entries = await fsp.readdir(full);
      subdirs.push({ sub, entries: entries.toSorted() });
    } catch {
      subdirs.push({ sub, entries: [] });
    }
  }
  return {
    root,
    subdirs,
    telemetry: await listTelemetryEntries(resolvedEnv),
  };
}

export async function actionDecay(params: {
  maxUnusedDays?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<DecayedSkill[]> {
  return runDecaySweep({
    policy: params.maxUnusedDays ? { maxUnusedDays: params.maxUnusedDays } : undefined,
    env: params.env,
  });
}

export async function actionReset(env?: NodeJS.ProcessEnv): Promise<{ removed: string }> {
  const root = resolveSkillForgeRoot(env);
  await fsp.rm(root, { recursive: true, force: true });
  return { removed: root };
}

export type ForgeDiscoveryReport = {
  workspaceDir: string;
  totalDiscovered: number;
  forgeSourced: Array<{ name: string; filePath: string; description: string }>;
};

export function actionVerifyDiscovery(workspaceDir: string): ForgeDiscoveryReport {
  const entries = loadWorkspaceSkillEntries(workspaceDir);
  const forge = entries
    .filter((entry) => entry.skill.source === "openclaw-skill-forge")
    .map((entry) => ({
      name: entry.skill.name,
      filePath: entry.skill.filePath,
      description: entry.skill.description,
    }));
  return {
    workspaceDir,
    totalDiscovered: entries.length,
    forgeSourced: forge,
  };
}

export type DaemonScanResult = {
  scannedTrajectories: number;
  capturedSessionIds: string[];
};

export async function actionDaemonScan(params: {
  scanDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DaemonScanResult> {
  const env = params.env ?? process.env;
  let names: string[];
  try {
    names = await fsp.readdir(params.scanDir);
  } catch {
    return { scannedTrajectories: 0, capturedSessionIds: [] };
  }
  const trajectoryFiles = names.filter((name) => name.endsWith(".trajectory.jsonl"));
  const alreadyCaptured = await listAlreadyCapturedSessionIds(env);
  const capturedSessionIds: string[] = [];
  for (const name of trajectoryFiles) {
    const trajectoryPath = path.join(params.scanDir, name);
    const meta = await readSessionStartedMetaFromTrajectory(trajectoryPath);
    if (!meta) {
      continue;
    }
    if (alreadyCaptured.has(meta.sessionId)) {
      continue;
    }
    try {
      await fsp.stat(meta.sessionFile);
    } catch {
      continue;
    }
    if (!(await hasSessionEndedInTrajectory(trajectoryPath, meta.sessionId))) {
      continue;
    }
    const result = await captureSessionToForge({
      sessionFile: meta.sessionFile,
      sessionId: meta.sessionId,
      sessionKey: meta.sessionKey,
      workspaceDir: meta.workspaceDir,
      runtimeFile: trajectoryPath,
      trigger: "session-end",
      env,
    });
    if (result.status === "captured") {
      capturedSessionIds.push(meta.sessionId);
    }
  }
  return {
    scannedTrajectories: trajectoryFiles.length,
    capturedSessionIds,
  };
}

export function defaultDaemonScanDir(): string {
  const home = process.env.HOME ?? "/tmp";
  return path.join(home, ".openclaw", "agents", "main", "sessions");
}

export async function actionInstallAutostart(params: {
  intervalMinutes?: number;
  withLlmReplay?: boolean;
  withEmbedding?: boolean;
  noLlm?: boolean;
  agentId?: string;
}): Promise<AutostartInstallResult> {
  const daemonFlags: string[] = [];
  if (params.noLlm) {
    daemonFlags.push("--no-llm");
  }
  if (params.withEmbedding) {
    daemonFlags.push("--with-embedding");
  }
  if (params.withLlmReplay) {
    daemonFlags.push("--with-llm-replay");
  }
  if (params.agentId) {
    daemonFlags.push("--agent", params.agentId);
  }
  return installAutostart({
    intervalMinutes: params.intervalMinutes,
    daemonFlags,
  });
}

export async function actionUninstallAutostart(): Promise<AutostartUninstallResult> {
  return uninstallAutostart();
}

export async function actionAutostartStatus(): Promise<AutostartStatus> {
  return autostartStatus();
}
