import fsp from "node:fs/promises";
import path from "node:path";
/**
 * Skill Forge built-in tool.
 *
 * Exposes the autonomous skill-forge pipeline to agents: status, capture,
 * run pipeline, promote/retire skills, and telemetry.
 */
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureSessionToForge } from "../../skill-forge/capture.js";
import {
  resolveSkillForgeSkillsRoot,
  resolveSkillForgeStagedSkillsDir,
  resolveSkillForgeRetiredSkillsDir,
} from "../../skill-forge/paths.js";
import { runForgePipeline, type PipelineRunResult } from "../../skill-forge/pipeline.js";
import {
  promoteStagedSkill,
  runDecaySweep,
  type PromotionResult,
  DEFAULT_DECAY_POLICY,
} from "../../skill-forge/promoter.js";
import { listTelemetryEntries, type SkillTelemetryEntry } from "../../skill-forge/telemetry.js";
import { recordSkillDemotion } from "../../skill-forge/telemetry.js";
import type { CaptureResult } from "../../skill-forge/types.js";
import { stringEnum } from "../schema/typebox.js";
import {
  asToolParamsRecord,
  readStringParam,
  ToolInputError,
  type AnyAgentTool,
} from "./common.js";

const SKILL_FORGE_ACTIONS = ["status", "capture", "run", "promote", "retire", "telemetry"] as const;

const SkillForgeToolSchema = Type.Object(
  {
    action: stringEnum(SKILL_FORGE_ACTIONS, {
      description:
        "status for pipeline overview, capture to capture a session, run to execute the pipeline, promote to promote a staged skill, retire to demote a skill, telemetry for per-skill usage stats.",
    }),
    session_id: Type.Optional(
      Type.String({
        description: "Session ID for action=capture.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        description: "Skill name for action=promote or action=retire.",
      }),
    ),
    reason: Type.Optional(
      Type.String({
        description: "Reason for action=retire.",
      }),
    ),
    max_unused_days: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Max unused days for decay sweep in action=retire. Defaults to 30.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type SkillForgeToolOptions = {
  workspaceDir: string;
  config?: OpenClawConfig;
  agentId?: string;
};

/** Create the Skill Forge tool for autonomous skill pipeline operations. */
export function createSkillForgeTool(options: SkillForgeToolOptions): AnyAgentTool {
  return {
    label: "Skill Forge",
    name: "skill_forge",
    displaySummary: "Run the autonomous skill pipeline",
    description:
      "Inspect, capture, run, promote, retire, and query telemetry for the Skill Forge autonomous skill pipeline.",
    parameters: SkillForgeToolSchema,
    execute: async (_toolCallId, args) => {
      const params = asToolParamsRecord(args);
      const action = readStringParam(params, "action", { required: true });

      if (action === "status") {
        return await handleStatus();
      }

      if (action === "capture") {
        return await handleCapture(params);
      }

      if (action === "run") {
        return await handleRun();
      }

      if (action === "promote") {
        return await handlePromote(params);
      }

      if (action === "retire") {
        return await handleRetire(params);
      }

      if (action === "telemetry") {
        return await handleTelemetry();
      }

      throw new ToolInputError(`action must be one of ${SKILL_FORGE_ACTIONS.join(", ")}`);
    },
  };

  async function handleStatus() {
    const [telemetry, promotedDirs, stagedDirs, retiredDirs] = await Promise.all([
      listTelemetryEntries().catch(() => [] as SkillTelemetryEntry[]),
      listDirs(resolveSkillForgeSkillsRoot()),
      listDirs(resolveSkillForgeStagedSkillsDir()),
      listDirs(resolveSkillForgeRetiredSkillsDir()),
    ]);

    const promoted = promotedDirs.filter((d) => d !== "_staging" && d !== "_retired");

    // Read descriptions
    const promotedRoot = resolveSkillForgeSkillsRoot();
    const stagedRoot = resolveSkillForgeStagedSkillsDir();
    const retiredRoot = resolveSkillForgeRetiredSkillsDir();
    const [promotedDescs, stagedDescs, retiredDescs] = await Promise.all([
      Promise.all(promoted.map((n) => readSkillDesc(path.join(promotedRoot, n)))),
      Promise.all(stagedDirs.map((n) => readSkillDesc(path.join(stagedRoot, n)))),
      Promise.all(retiredDirs.map((n) => readSkillDesc(path.join(retiredRoot, n)))),
    ]);

    const status = {
      promoted: promoted.length,
      staged: stagedDirs.length,
      retired: retiredDirs.length,
      telemetry: telemetry.length,
      skills: {
        promoted: promoted.map((name, i) => {
          const tel = telemetry.find((t) => t.name === name);
          return {
            name,
            description: promotedDescs[i],
            status: tel?.status ?? "promoted",
            usageCount: tel?.usageCount ?? 0,
            lastUsedAt: tel?.lastUsedAt,
            promotedAt: tel?.promotedAt,
          };
        }),
        staged: stagedDirs.map((name, i) => {
          const tel = telemetry.find((t) => t.name === name);
          return {
            name,
            description: stagedDescs[i],
            status: tel?.status ?? "staged",
            createdAt: tel?.createdAt,
          };
        }),
        retired: retiredDirs.map((name, i) => {
          const tel = telemetry.find((t) => t.name === name);
          return {
            name,
            description: retiredDescs[i],
            status: "retired",
            retiredAt: tel?.retiredAt,
            retiredReason: tel?.retiredReason,
          };
        }),
      },
    };

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Skill Forge Status`,
            `  Promoted: ${status.promoted}`,
            `  Staged:   ${status.staged}`,
            `  Retired:  ${status.retired}`,
            `  Telemetry entries: ${status.telemetry}`,
            "",
            ...status.skills.promoted.map(
              (s) =>
                `  ✓ ${s.name}${s.description ? ` — ${s.description}` : ""} (used ${s.usageCount}x, ${s.lastUsedAt ?? "never"})`,
            ),
            ...status.skills.staged.map(
              (s) => `  ○ ${s.name}${s.description ? ` — ${s.description}` : ""} (${s.status})`,
            ),
            ...status.skills.retired.map(
              (s) =>
                `  ✗ ${s.name} (retired ${s.retiredAt ?? "unknown"}${s.retiredReason ? `: ${s.retiredReason}` : ""})`,
            ),
          ].join("\n"),
        },
      ],
      details: status,
    };
  }

  async function handleCapture(params: Record<string, unknown>) {
    const sessionId = readStringParam(params, "session_id", {
      required: true,
      label: "session_id",
    });
    const result: CaptureResult = await captureSessionToForge({
      sessionId,
      sessionFile: sessionId,
      workspaceDir: options.workspaceDir,
      trigger: "manual",
    });
    if (result.status === "skipped") {
      return {
        content: [{ type: "text" as const, text: `Capture skipped: ${result.reason}` }],
        details: { status: "skipped", reason: result.reason },
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Captured session ${sessionId} → ${result.outputDir} (${result.manifest.eventCount} events, trigger: ${result.manifest.trigger})`,
        },
      ],
      details: {
        status: "captured",
        outputDir: result.outputDir,
        eventCount: result.manifest.eventCount,
        trigger: result.manifest.trigger,
      },
    };
  }

  async function handleRun() {
    const result: PipelineRunResult = await runForgePipeline();
    const lines = [
      `Forge pipeline complete.`,
      `  Scanned:   ${result.scannedCaptureDirs} sessions`,
      `  Detected:  ${result.candidates.length} candidates`,
      `  Drafted:   ${result.drafted.length} skills`,
      `  Promoted:  ${result.promotions.filter((p) => p.status === "promoted").length}`,
    ];
    for (const draft of result.drafted) {
      lines.push(`  → ${draft.name} (${draft.skillDir})`);
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: {
        scannedCaptureDirs: result.scannedCaptureDirs,
        candidateCount: result.candidates.length,
        draftedCount: result.drafted.length,
        promotedCount: result.promotions.filter((p) => p.status === "promoted").length,
        promotions: result.promotions,
      },
    };
  }

  async function handlePromote(params: Record<string, unknown>) {
    const name = readStringParam(params, "name", { required: true });
    const result: PromotionResult = await promoteStagedSkill({ name });
    if (result.status === "rejected") {
      return {
        content: [
          {
            type: "text" as const,
            text: `Promotion rejected: ${result.verdict.reasons.join("; ") ?? "gate check failed"}`,
          },
        ],
        details: { status: "rejected", name, reason: result.verdict.reasons.join("; ") },
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: `Promoted skill "${name}" → ${result.promotedDir}`,
        },
      ],
      details: { status: "promoted", name, promotedDir: result.promotedDir },
    };
  }

  async function handleRetire(params: Record<string, unknown>) {
    const name = readStringParam(params, "name");
    const maxUnusedDays = readMaxUnusedDaysParam(params) ?? DEFAULT_DECAY_POLICY.maxUnusedDays;

    if (name) {
      const reason = readStringParam(params, "reason") ?? "manual retirement";
      const entry = await recordSkillDemotion({ name, reason });
      return {
        content: [
          {
            type: "text" as const,
            text: `Retired skill "${name}": ${reason}`,
          },
        ],
        details: { status: "retired", name, reason, entry },
      };
    }

    // Run decay sweep
    const retired = await runDecaySweep({ policy: { maxUnusedDays } });
    return {
      content: [
        {
          type: "text" as const,
          text: `Decay sweep complete (>${maxUnusedDays}d unused): ${retired.length} skills retired.`,
        },
      ],
      details: { retiredCount: retired.length, retired },
    };
  }

  async function handleTelemetry() {
    const entries = await listTelemetryEntries();
    const lines = [`Skill Forge Telemetry (${entries.length} entries)`];
    for (const entry of entries) {
      lines.push(
        `  ${entry.name} [${entry.status}] used=${entry.usageCount} last=${entry.lastUsedAt ?? "never"}`,
      );
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { entries },
    };
  }
}

function readMaxUnusedDaysParam(params: Record<string, unknown>): number | undefined {
  const val = params.max_unused_days;
  if (val === undefined || val === null) {
    return undefined;
  }
  const parsed = Number(val);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }
  return Math.floor(parsed);
}

async function listDirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dirPath);
    const dirs: string[] = [];
    for (const entry of entries) {
      try {
        const stat = await fsp.stat(path.join(dirPath, entry));
        if (stat.isDirectory()) {
          dirs.push(entry);
        }
      } catch {
        // skip
      }
    }
    return dirs;
  } catch {
    return [];
  }
}

async function readSkillDesc(skillDir: string): Promise<string> {
  try {
    const content = await fsp.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/)?.[1];
    if (!frontmatter) {
      return "";
    }
    const descMatch = frontmatter.match(/^description:\s*['"]?(.+?)['"]?\s*$/m);
    return descMatch?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}
