import type { Command } from "commander";
import {
  actionAutostartStatus,
  actionCaptureDir,
  actionCaptureSingle,
  actionDaemonScan,
  actionDecay,
  actionInstallAutostart,
  actionListForge,
  actionPipeline,
  actionReset,
  actionUninstallAutostart,
  actionVerifyDiscovery,
  defaultDaemonScanDir,
} from "../../skill-forge/cli-actions.js";
import { applyParentDefaultHelpAction } from "../program/parent-default-help.js";

const DEFAULT_DAEMON_SCAN_INTERVAL_SEC = 60;
const DEFAULT_DAEMON_PIPELINE_INTERVAL_SEC = 300;
const MIN_DAEMON_SCAN_INTERVAL_SEC = 5;
const MIN_DAEMON_PIPELINE_INTERVAL_SEC = 30;

function nowIso(): string {
  return new Date().toISOString();
}

function parseSecondsOption(raw: unknown, fallback: number, minimumSec: number): number {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(minimumSec, Math.trunc(value));
}

function registerCaptureCommand(parent: Command): void {
  parent
    .command("capture")
    .description("Capture a single session's trajectory into the forge.")
    .requiredOption("--session-file <path>", "Path to the session JSONL")
    .requiredOption("--session-id <id>", "Session id (matches the trajectory filename)")
    .requiredOption("--workspace-dir <dir>", "Workspace directory associated with the session")
    .action(async (opts) => {
      const result = await actionCaptureSingle({
        sessionFile: String(opts.sessionFile),
        sessionId: String(opts.sessionId),
        workspaceDir: String(opts.workspaceDir),
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== "captured") {
        process.exitCode = 1;
      }
    });
}

function registerCaptureDirCommand(parent: Command): void {
  parent
    .command("capture-dir")
    .description(
      "Auto-discover *.trajectory.jsonl files in <dir>, recover session metadata, capture each.",
    )
    .argument("[dir]", "Directory to scan (defaults to ~/.openclaw/agents/main/sessions)")
    .action(async (dirArg) => {
      const dir = typeof dirArg === "string" && dirArg ? dirArg : defaultDaemonScanDir();
      const report = await actionCaptureDir({ dir });
      console.log(`Scanning ${report.scannedTrajectories} trajectory file(s) in ${dir}`);
      for (const ok of report.captured) {
        console.log(`  ok   ${ok.sessionId} -> ${ok.outputDir}`);
      }
      for (const skip of report.skipped) {
        console.log(`  skip ${skip.name} (${skip.reason})`);
      }
      console.log(`Done. captured=${report.captured.length} skipped=${report.skipped.length}`);
    });
}

function registerPipelineCommand(parent: Command): void {
  parent
    .command("pipeline")
    .description("Run detector → distiller → gate → promoter across captured sessions.")
    .option(
      "--no-llm",
      "Skip LLM distillation; use the heuristic body only (faster, no model calls).",
    )
    .option(
      "--with-embedding",
      "Also run the semantic-embedding lane (requires memory.embedding configured in openclaw.json).",
      false,
    )
    .option(
      "--with-llm-replay",
      "Run an LLM-as-judge gate on each drafted skill before promotion; rejects UNSAFE_OR_HARMFUL.",
      false,
    )
    .option("--agent <id>", "Override the agent whose default model is used for LLM distillation.")
    .action(async (opts) => {
      const useLlm = opts.llm !== false;
      const useEmbedding = opts.withEmbedding === true;
      const useLlmReplay = opts.withLlmReplay === true;
      const agentId = typeof opts.agent === "string" && opts.agent ? opts.agent : undefined;
      const result = await actionPipeline({ useLlm, useEmbedding, useLlmReplay, agentId });
      if (result.embedding && result.embedding.status !== "disabled") {
        if (result.embedding.status === "ran") {
          console.log(
            `embedding lane: ${result.embedding.providerId}/${result.embedding.model} — embedded=${result.embedding.report.embeddedCaptures} skipped=${result.embedding.report.skippedCaptures.length} candidates=${result.embedding.report.candidates.length}`,
          );
        } else {
          console.log(`embedding lane: skipped (${result.embedding.reason})`);
        }
      }
      if (result.llmReplay?.status === "ran") {
        for (const j of result.llmReplay.judged) {
          if (j.gate.status === "ran") {
            console.log(`llm-replay judge ${j.name}: ${j.gate.verdict} — ${j.gate.rationale}`);
          } else {
            console.log(`llm-replay judge ${j.name}: ${j.gate.status} (${j.gate.reason})`);
          }
        }
      }
      console.log("=== pipeline result ===");
      console.log(`scannedCaptureDirs: ${result.scannedCaptureDirs}`);
      console.log(`candidates: ${result.candidates.length}`);
      for (const candidate of result.candidates) {
        console.log(`  [${candidate.lane}] ${candidate.candidateId}`);
      }
      console.log(`drafted: ${result.drafted.length}`);
      for (const draft of result.drafted) {
        const distilledBy =
          draft.distilledBy.kind === "llm"
            ? `${draft.distilledBy.provider}/${draft.distilledBy.modelId}`
            : draft.distilledBy.kind === "llm-fallback"
              ? `heuristic (LLM fallback: ${draft.distilledBy.reason})`
              : "heuristic";
        console.log(`  ${draft.name} [${distilledBy}] -> ${draft.skillMdPath}`);
      }
      console.log(`promotions: ${result.promotions.length}`);
      for (const promotion of result.promotions) {
        if (promotion.status === "promoted") {
          console.log(`  promoted: ${promotion.name} -> ${promotion.promotedDir}`);
        } else {
          console.log(
            `  rejected: ${promotion.name} (reasons: ${promotion.verdict.reasons.join("; ")})`,
          );
        }
      }
    });
}

function registerLsCommand(parent: Command): void {
  parent
    .command("ls")
    .description("List forge state on disk (captures, candidates, staged/promoted/retired).")
    .action(async () => {
      const report = await actionListForge();
      console.log(`forge root: ${report.root}`);
      for (const sub of report.subdirs) {
        if (sub.entries.length === 0) {
          console.log(`  ${sub.sub}/ (empty or missing)`);
          continue;
        }
        console.log(`  ${sub.sub}/ (${sub.entries.length})`);
        for (const entry of sub.entries.slice(0, 20)) {
          console.log(`    ${entry}`);
        }
        if (sub.entries.length > 20) {
          console.log(`    ...and ${sub.entries.length - 20} more`);
        }
      }
      if (report.telemetry.length > 0) {
        console.log("telemetry entries:");
        for (const entry of report.telemetry) {
          console.log(
            `  ${entry.name}: status=${entry.status} usage=${entry.usageCount} createdAt=${entry.createdAt}`,
          );
        }
      }
    });
}

function registerDecayCommand(parent: Command): void {
  parent
    .command("decay")
    .description(
      "Run the decay sweep: demote promoted skills that are unused beyond the threshold.",
    )
    .option("--max-unused-days <n>", "Threshold in days (default 30)")
    .action(async (opts) => {
      const maxUnusedDays = opts.maxUnusedDays ? Number(opts.maxUnusedDays) : undefined;
      const demoted = await actionDecay({ maxUnusedDays });
      console.log(`demoted: ${demoted.length}`);
      for (const entry of demoted) {
        console.log(`  ${entry.name} (${entry.reason})`);
      }
    });
}

function registerResetCommand(parent: Command): void {
  parent
    .command("reset")
    .description("Wipe ~/.openclaw/skill-forge/ for a clean demo.")
    .action(async () => {
      const result = await actionReset();
      console.log(`removed ${result.removed}`);
    });
}

function registerVerifyDiscoveryCommand(parent: Command): void {
  parent
    .command("verify-discovery")
    .description("Prove the running binary's skill loader picks up promoted forge skills.")
    .argument("[workspace-dir]", "Workspace directory (defaults to cwd)")
    .action((workspaceArg) => {
      const workspaceDir =
        typeof workspaceArg === "string" && workspaceArg ? workspaceArg : process.cwd();
      const report = actionVerifyDiscovery(workspaceDir);
      console.log(`workspaceDir: ${report.workspaceDir}`);
      console.log(`total skills discovered: ${report.totalDiscovered}`);
      console.log(`skill-forge sourced: ${report.forgeSourced.length}`);
      for (const skill of report.forgeSourced) {
        const truncated =
          skill.description.length > 100
            ? `${skill.description.slice(0, 100)}...`
            : skill.description;
        console.log(`  ${skill.name}`);
        console.log(`    filePath: ${skill.filePath}`);
        console.log(`    description: ${truncated}`);
      }
    });
}

function registerDaemonCommand(parent: Command): void {
  parent
    .command("daemon")
    .description(
      "Sidecar auto-capture loop. Polls trajectory dir for ended sessions, captures, runs pipeline.",
    )
    .option("--once", "Run a single scan + pipeline pass and exit (cron-friendly)", false)
    .option("--scan-dir <dir>", "Trajectory directory to watch (defaults to main agent's)")
    .option(
      "--scan-interval <seconds>",
      `Seconds between scans (default ${DEFAULT_DAEMON_SCAN_INTERVAL_SEC}, min ${MIN_DAEMON_SCAN_INTERVAL_SEC})`,
    )
    .option(
      "--pipeline-interval <seconds>",
      `Seconds between pipeline runs (default ${DEFAULT_DAEMON_PIPELINE_INTERVAL_SEC}, min ${MIN_DAEMON_PIPELINE_INTERVAL_SEC})`,
    )
    .option(
      "--no-llm",
      "Skip LLM distillation in pipeline runs (heuristic body only, no model calls).",
    )
    .option(
      "--with-embedding",
      "Also run the semantic-embedding lane (requires memory.embedding configured).",
      false,
    )
    .option(
      "--with-llm-replay",
      "Run the LLM-as-judge gate on each drafted skill in daemon pipeline runs.",
      false,
    )
    .option("--agent <id>", "Agent whose default model is used for LLM distillation.")
    .action(async (opts) => {
      const scanDir =
        typeof opts.scanDir === "string" && opts.scanDir ? opts.scanDir : defaultDaemonScanDir();
      const scanIntervalSec = parseSecondsOption(
        opts.scanInterval,
        DEFAULT_DAEMON_SCAN_INTERVAL_SEC,
        MIN_DAEMON_SCAN_INTERVAL_SEC,
      );
      const pipelineIntervalSec = parseSecondsOption(
        opts.pipelineInterval,
        DEFAULT_DAEMON_PIPELINE_INTERVAL_SEC,
        MIN_DAEMON_PIPELINE_INTERVAL_SEC,
      );
      const daemonUseLlm = opts.llm !== false;
      const daemonUseEmbedding = opts.withEmbedding === true;
      const daemonUseLlmReplay = opts.withLlmReplay === true;
      const daemonAgentId = typeof opts.agent === "string" && opts.agent ? opts.agent : undefined;
      console.log(`skill-forge daemon`);
      console.log(`  scanDir: ${scanDir}`);
      console.log(`  once: ${Boolean(opts.once)}`);
      if (!opts.once) {
        console.log(`  scanInterval: ${scanIntervalSec}s`);
        console.log(`  pipelineInterval: ${pipelineIntervalSec}s`);
      }

      const runOnePass = async (alwaysRunPipeline: boolean): Promise<void> => {
        const scan = await actionDaemonScan({ scanDir });
        for (const sessionId of scan.capturedSessionIds) {
          console.log(`[${nowIso()}] captured ${sessionId}`);
        }
        if (alwaysRunPipeline || scan.capturedSessionIds.length > 0) {
          const result = await actionPipeline({
            useLlm: daemonUseLlm,
            useEmbedding: daemonUseEmbedding,
            useLlmReplay: daemonUseLlmReplay,
            agentId: daemonAgentId,
          });
          const promoted = result.promotions.filter((p) => p.status === "promoted").length;
          const rejected = result.promotions.filter((p) => p.status === "rejected").length;
          console.log(
            `[${nowIso()}] pipeline: candidates=${result.candidates.length} promoted=${promoted} rejected=${rejected}`,
          );
          if (result.embedding && result.embedding.status === "ran") {
            console.log(
              `[${nowIso()}] embedding: ${result.embedding.providerId}/${result.embedding.model} embedded=${result.embedding.report.embeddedCaptures} skipped=${result.embedding.report.skippedCaptures.length}`,
            );
          } else if (result.embedding && result.embedding.status === "unavailable") {
            console.log(`[${nowIso()}] embedding: skipped (${result.embedding.reason})`);
          }
          if (result.llmReplay?.status === "ran") {
            for (const j of result.llmReplay.judged) {
              if (j.gate.status === "ran") {
                console.log(
                  `[${nowIso()}] judge ${j.name}: ${j.gate.verdict} — ${j.gate.rationale}`,
                );
              } else {
                console.log(`[${nowIso()}] judge ${j.name}: ${j.gate.status} (${j.gate.reason})`);
              }
            }
          }
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
        console.log(`[${nowIso()}] received ${signal}, stopping`);
      };
      process.on("SIGINT", () => stop("SIGINT"));
      process.on("SIGTERM", () => stop("SIGTERM"));

      await runOnePass(true);
      let lastPipelineAt = Date.now();
      while (!state.stopping) {
        await new Promise((resolve) => setTimeout(resolve, scanIntervalSec * 1000));
        if (state.stopping) {
          break;
        }
        const runPipelineToo = Date.now() - lastPipelineAt >= pipelineIntervalSec * 1000;
        await runOnePass(runPipelineToo);
        if (runPipelineToo) {
          lastPipelineAt = Date.now();
        }
      }
    });
}

function registerInstallCronCommand(parent: Command): void {
  parent
    .command("install-cron")
    .description(
      "Install autostart: schedule `openclaw skill-forge daemon --once` via launchd (macOS). Linux/Windows: not yet implemented.",
    )
    .option("--interval <minutes>", "Minutes between runs (default 5, minimum 1)", "5")
    .option(
      "--no-llm",
      "Bake `--no-llm` into the cron job (heuristic-only distillation, no model calls).",
    )
    .option(
      "--with-embedding",
      "Bake `--with-embedding` into the cron job (semantic clustering via memory.embedding provider).",
      false,
    )
    .option(
      "--with-llm-replay",
      "Bake `--with-llm-replay` into the cron job (LLM-as-judge gate before promotion).",
      false,
    )
    .option(
      "--agent <id>",
      "Bake `--agent <id>` into the cron job (overrides which agent's default model is used).",
    )
    .action(async (opts) => {
      const intervalMinutes = Math.max(1, Number(opts.interval ?? 5));
      const noLlm = opts.llm === false;
      const withEmbedding = opts.withEmbedding === true;
      const withLlmReplay = opts.withLlmReplay === true;
      const agentId = typeof opts.agent === "string" && opts.agent ? opts.agent : undefined;
      try {
        const result = await actionInstallAutostart({
          intervalMinutes,
          noLlm,
          withEmbedding,
          withLlmReplay,
          agentId,
        });
        console.log("autostart installed");
        console.log(`  platform: ${result.platform}`);
        console.log(`  label: ${result.label}`);
        if (result.plistPath) {
          console.log(`  plist: ${result.plistPath}`);
        }
        console.log(`  interval: ${result.intervalSeconds}s`);
        const bakedFlags = [
          noLlm ? "--no-llm" : null,
          withEmbedding ? "--with-embedding" : null,
          withLlmReplay ? "--with-llm-replay" : null,
          agentId ? `--agent ${agentId}` : null,
        ].filter(Boolean);
        if (bakedFlags.length > 0) {
          console.log(`  flags: ${bakedFlags.join(" ")}`);
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      }
    });
}

function registerUninstallCronCommand(parent: Command): void {
  parent
    .command("uninstall-cron")
    .description("Remove the skill-forge autostart job and plist.")
    .action(async () => {
      const result = await actionUninstallAutostart();
      console.log(`platform: ${result.platform}`);
      console.log(`plist removed: ${result.removed}`);
      console.log(`launchd unloaded: ${result.loadedRemoved}`);
    });
}

function registerCronStatusCommand(parent: Command): void {
  parent
    .command("cron-status")
    .description("Show whether skill-forge autostart is installed and loaded.")
    .action(async () => {
      const status = await actionAutostartStatus();
      console.log(`platform: ${status.platform}`);
      console.log(`installed: ${status.installed}`);
      if (status.plistPath) {
        console.log(`plist: ${status.plistPath}`);
      }
      if (status.intervalSeconds !== undefined) {
        console.log(`interval: ${status.intervalSeconds}s`);
      }
      if (status.loaded !== undefined) {
        console.log(`loaded: ${status.loaded}`);
      }
    });
}

export function registerSkillForgeCli(program: Command): void {
  const root = program
    .command("skill-forge")
    .description(
      "Autonomous skill-forge pipeline: capture sessions, detect workflows, distill SKILL.md drafts, promote.",
    );

  registerCaptureCommand(root);
  registerCaptureDirCommand(root);
  registerPipelineCommand(root);
  registerLsCommand(root);
  registerDecayCommand(root);
  registerResetCommand(root);
  registerVerifyDiscoveryCommand(root);
  registerDaemonCommand(root);
  registerInstallCronCommand(root);
  registerUninstallCronCommand(root);
  registerCronStatusCommand(root);

  applyParentDefaultHelpAction(root);
}
