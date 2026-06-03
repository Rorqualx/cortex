#!/usr/bin/env -S node --import tsx
import fsp from "node:fs/promises";
import path from "node:path";
import { loadWorkspaceSkillEntries } from "../src/agents/skills/workspace.ts";
import { captureSessionToForge } from "../src/skill-forge/capture.ts";
import { resolveSkillForgeRoot, resolveSkillForgeSessionsDir } from "../src/skill-forge/paths.ts";
import { runForgePipeline } from "../src/skill-forge/pipeline.ts";
import { runDecaySweep } from "../src/skill-forge/promoter.ts";
import { listTelemetryEntries } from "../src/skill-forge/telemetry.ts";
import { parseTrajectoryLine } from "../src/skill-forge/watcher.ts";

const HELP = `
openclaw skill-forge cli (demo launcher)

Subcommands:
  capture <session.jsonl> <sessionId> <workspaceDir>
      Capture one session's trajectory into the forge.
  capture-dir <dir>
      Auto-discover every *.trajectory.jsonl in <dir>, read its session.started
      event to recover sessionId + sessionFile + workspaceDir, then capture each.
  pipeline
      Run detector → distiller → gate → promoter over all captured sessions.
  ls
      List forge state on disk: captures, candidates, staged, promoted, retired.
  decay [maxUnusedDays]
      Run the decay sweep.
  reset
      Wipe ~/.openclaw/skill-forge/ for a clean demo.
  verify-discovery [workspaceDir]
      Call the real workspace skill discovery loader and print every skill
      sourced from openclaw-skill-forge (proves the running binary will pick
      up promoted forge skills).
  daemon [--once] [--scan-dir <dir>] [--scan-interval <sec>] [--pipeline-interval <sec>]
      Sidecar auto-capture loop. Polls the trajectory dir for sessions that
      have ended; captures any not yet in the forge; periodically runs the
      pipeline. Use --once for cron-style invocation.
`.trim();

type SessionMeta = {
  sessionId: string;
  sessionFile: string;
  workspaceDir: string;
  sessionKey?: string;
};

async function readSessionStartedMeta(trajectoryFile: string): Promise<SessionMeta | null> {
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

async function captureSingle(
  sessionFile: string,
  sessionId: string,
  workspaceDir: string,
): Promise<void> {
  const result = await captureSessionToForge({
    sessionFile,
    sessionId,
    workspaceDir,
    trigger: "manual",
  });
  console.log(JSON.stringify(result, null, 2));
}

async function captureDir(dir: string): Promise<void> {
  const names = await fsp.readdir(dir);
  const candidates = names.filter((name) => name.endsWith(".trajectory.jsonl"));
  console.log(`Scanning ${candidates.length} trajectory file(s) in ${dir}`);
  let captured = 0;
  let skipped = 0;
  for (const name of candidates) {
    const trajectoryPath = path.join(dir, name);
    const meta = await readSessionStartedMeta(trajectoryPath);
    if (!meta) {
      console.log(`  skip ${name} (no session.started event)`);
      skipped += 1;
      continue;
    }
    // Confirm the session file actually exists; some sessions are deleted/rotated.
    try {
      await fsp.stat(meta.sessionFile);
    } catch {
      console.log(`  skip ${meta.sessionId} (session file missing: ${meta.sessionFile})`);
      skipped += 1;
      continue;
    }
    const result = await captureSessionToForge({
      sessionFile: meta.sessionFile,
      sessionId: meta.sessionId,
      sessionKey: meta.sessionKey,
      workspaceDir: meta.workspaceDir,
      runtimeFile: trajectoryPath,
      trigger: "manual",
    });
    if (result.status === "captured") {
      console.log(`  ok   ${meta.sessionId} -> ${result.outputDir}`);
      captured += 1;
    } else {
      console.log(`  fail ${meta.sessionId}: ${result.reason}`);
      skipped += 1;
    }
  }
  console.log(`Done. captured=${captured} skipped=${skipped}`);
}

async function pipeline(): Promise<void> {
  const result = await runForgePipeline();
  console.log("=== pipeline result ===");
  console.log(`scannedCaptureDirs: ${result.scannedCaptureDirs}`);
  console.log(`candidates: ${result.candidates.length}`);
  for (const c of result.candidates) {
    console.log(`  [${c.lane}] ${c.candidateId}`);
  }
  console.log(`drafted: ${result.drafted.length}`);
  for (const d of result.drafted) {
    console.log(`  ${d.name} -> ${d.skillMdPath}`);
  }
  console.log(`promotions: ${result.promotions.length}`);
  for (const p of result.promotions) {
    if (p.status === "promoted") {
      console.log(`  promoted: ${p.name} -> ${p.promotedDir}`);
    } else {
      console.log(`  rejected: ${p.name} (reasons: ${p.verdict.reasons.join("; ")})`);
    }
  }
}

async function listForge(): Promise<void> {
  const root = resolveSkillForgeRoot();
  console.log(`forge root: ${root}`);
  const subs = [
    "sessions",
    "candidates",
    "skills/.staging",
    "skills",
    "skills/.retired",
    "telemetry",
  ];
  for (const sub of subs) {
    const full = path.join(root, sub);
    try {
      const entries = await fsp.readdir(full);
      console.log(`  ${sub}/ (${entries.length})`);
      for (const entry of entries.slice(0, 20)) {
        console.log(`    ${entry}`);
      }
      if (entries.length > 20) {
        console.log(`    ...and ${entries.length - 20} more`);
      }
    } catch {
      console.log(`  ${sub}/ (missing)`);
    }
  }
  const tel = await listTelemetryEntries();
  if (tel.length > 0) {
    console.log("telemetry entries:");
    for (const e of tel) {
      console.log(`  ${e.name}: status=${e.status} usage=${e.usageCount} createdAt=${e.createdAt}`);
    }
  }
}

async function decay(maxUnusedDaysArg: string | undefined): Promise<void> {
  const maxUnusedDays = maxUnusedDaysArg ? Number(maxUnusedDaysArg) : 30;
  const demoted = await runDecaySweep({ policy: { maxUnusedDays } });
  console.log(`demoted: ${demoted.length}`);
  for (const d of demoted) {
    console.log(`  ${d.name} (${d.reason})`);
  }
}

async function reset(): Promise<void> {
  const root = resolveSkillForgeRoot();
  await fsp.rm(root, { recursive: true, force: true });
  console.log(`removed ${root}`);
}

async function hasSessionEnded(trajectoryFile: string, sessionId: string): Promise<boolean> {
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

async function listAlreadyCapturedSessionIds(): Promise<Set<string>> {
  const dir = resolveSkillForgeSessionsDir();
  const result = new Set<string>();
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return result;
  }
  for (const name of entries) {
    // capture dirs are named "<safe-sessionId>-<iso-stamp>"; strip the trailing -YYYY-...-HH-MM-SS
    const stripped = name.replace(/-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/u, "");
    if (stripped && stripped !== name) {
      result.add(stripped);
    }
  }
  return result;
}

type DaemonOptions = {
  once: boolean;
  scanDir: string;
  scanIntervalMs: number;
  pipelineIntervalMs: number;
};

function parseDaemonArgs(args: string[]): DaemonOptions {
  const options: DaemonOptions = {
    once: false,
    scanDir: path.join(process.env.HOME ?? "/tmp", ".openclaw", "agents", "main", "sessions"),
    scanIntervalMs: 60_000,
    pipelineIntervalMs: 300_000,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--once") {
      options.once = true;
    } else if (arg === "--scan-dir" && args[i + 1]) {
      options.scanDir = args[i + 1];
      i += 1;
    } else if (arg === "--scan-interval" && args[i + 1]) {
      options.scanIntervalMs = Math.max(5_000, Number(args[i + 1]) * 1000);
      i += 1;
    } else if (arg === "--pipeline-interval" && args[i + 1]) {
      options.pipelineIntervalMs = Math.max(30_000, Number(args[i + 1]) * 1000);
      i += 1;
    }
  }
  return options;
}

async function scanAndCapture(scanDir: string): Promise<number> {
  let names: string[];
  try {
    names = await fsp.readdir(scanDir);
  } catch {
    return 0;
  }
  const trajectoryFiles = names.filter((name) => name.endsWith(".trajectory.jsonl"));
  const alreadyCaptured = await listAlreadyCapturedSessionIds();
  let captured = 0;
  for (const name of trajectoryFiles) {
    const trajectoryPath = path.join(scanDir, name);
    const meta = await readSessionStartedMeta(trajectoryPath);
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
    if (!(await hasSessionEnded(trajectoryPath, meta.sessionId))) {
      continue;
    }
    const result = await captureSessionToForge({
      sessionFile: meta.sessionFile,
      sessionId: meta.sessionId,
      sessionKey: meta.sessionKey,
      workspaceDir: meta.workspaceDir,
      runtimeFile: trajectoryPath,
      trigger: "session-end",
    });
    if (result.status === "captured") {
      console.log(`[${new Date().toISOString()}] captured ${meta.sessionId}`);
      captured += 1;
    } else {
      console.log(`[${new Date().toISOString()}] skipped ${meta.sessionId}: ${result.reason}`);
    }
  }
  return captured;
}

async function daemon(args: string[]): Promise<void> {
  const opts = parseDaemonArgs(args);
  console.log(`skill-forge daemon`);
  console.log(`  scanDir: ${opts.scanDir}`);
  console.log(`  once: ${opts.once}`);
  if (!opts.once) {
    console.log(`  scanInterval: ${opts.scanIntervalMs / 1000}s`);
    console.log(`  pipelineInterval: ${opts.pipelineIntervalMs / 1000}s`);
  }

  const runOnePass = async (runPipelineToo: boolean): Promise<void> => {
    const captured = await scanAndCapture(opts.scanDir);
    if (runPipelineToo || captured > 0) {
      const result = await runForgePipeline();
      const promoted = result.promotions.filter((p) => p.status === "promoted").length;
      const rejected = result.promotions.filter((p) => p.status === "rejected").length;
      console.log(
        `[${new Date().toISOString()}] pipeline: candidates=${result.candidates.length} promoted=${promoted} rejected=${rejected}`,
      );
    }
  };

  if (opts.once) {
    await runOnePass(true);
    return;
  }

  const state = { stopping: false };
  const stop = (signal: string): void => {
    if (state.stopping) {
      return;
    }
    state.stopping = true;
    console.log(`[${new Date().toISOString()}] received ${signal}, stopping`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await runOnePass(true);
  let lastPipelineAt = Date.now();
  while (!state.stopping) {
    await new Promise((resolve) => setTimeout(resolve, opts.scanIntervalMs));
    if (state.stopping) {
      break;
    }
    const runPipelineToo = Date.now() - lastPipelineAt >= opts.pipelineIntervalMs;
    await runOnePass(runPipelineToo);
    if (runPipelineToo) {
      lastPipelineAt = Date.now();
    }
  }
}

async function verifyDiscovery(workspaceDirArg: string | undefined): Promise<void> {
  const workspaceDir = workspaceDirArg ?? process.cwd();
  const entries = loadWorkspaceSkillEntries(workspaceDir);
  const forge = entries.filter((e) => e.skill.source === "openclaw-skill-forge");
  console.log(`workspaceDir: ${workspaceDir}`);
  console.log(`total skills discovered: ${entries.length}`);
  console.log(`skill-forge sourced: ${forge.length}`);
  for (const entry of forge) {
    console.log(`  ${entry.skill.name}`);
    console.log(`    filePath: ${entry.skill.filePath}`);
    console.log(
      `    description: ${entry.skill.description.slice(0, 100)}${entry.skill.description.length > 100 ? "..." : ""}`,
    );
  }
}

async function main(): Promise<void> {
  const [, , subcommand, ...args] = process.argv;
  switch (subcommand) {
    case "capture": {
      const [sessionFile, sessionId, workspaceDir] = args;
      if (!sessionFile || !sessionId || !workspaceDir) {
        console.error("usage: capture <session.jsonl> <sessionId> <workspaceDir>");
        process.exit(2);
      }
      await captureSingle(sessionFile, sessionId, workspaceDir);
      return;
    }
    case "capture-dir": {
      const [dir] = args;
      if (!dir) {
        console.error("usage: capture-dir <directory>");
        process.exit(2);
      }
      await captureDir(dir);
      return;
    }
    case "pipeline":
      await pipeline();
      return;
    case "ls":
      await listForge();
      return;
    case "decay":
      await decay(args[0]);
      return;
    case "reset":
      await reset();
      return;
    case "verify-discovery":
      await verifyDiscovery(args[0]);
      return;
    case "daemon":
      await daemon(args);
      return;
    default:
      console.log(HELP);
      process.exit(subcommand ? 1 : 0);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
