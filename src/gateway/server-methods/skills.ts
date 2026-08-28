// Gateway RPC handlers for skill discovery, install/update, and proposal workflows.
import fsp from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  validateSkillsBinsParams,
  validateSkillsCuratorActionParams,
  validateSkillsCuratorStatusParams,
  validateSkillsDetailParams,
  validateSkillsInstallParams,
  validateSkillsProposalActionParams,
  validateSkillsProposalCreateParams,
  validateSkillsProposalEvaluateParams,
  validateSkillsProposalEventsListParams,
  validateSkillsProposalInspectParams,
  validateSkillsProposalRequestRevisionParams,
  validateSkillsProposalReviseParams,
  validateSkillsProposalsListParams,
  validateSkillsProposalUpdateParams,
  validateSkillsSearchParams,
  validateSkillsSecurityVerdictsParams,
  validateSkillsSkillCardParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveNodeExecEligibility } from "../../agents/exec-defaults.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { fetchClawHubSkillDetail } from "../../infra/clawhub-skills.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  resolveSkillForgeSkillsRoot,
  resolveSkillForgeStagedSkillsDir,
  resolveSkillForgeRetiredSkillsDir,
  resolveSkillForgeCandidatesDir,
} from "../../skill-forge/paths.js";
import { runForgePipeline, type PipelineRunResult } from "../../skill-forge/pipeline.js";
import {
  promoteStagedSkill,
  runDecaySweep,
  DEFAULT_DECAY_POLICY,
} from "../../skill-forge/promoter.js";
import { listTelemetryEntries, type SkillTelemetryEntry } from "../../skill-forge/telemetry.js";
import { recordSkillDemotion } from "../../skill-forge/telemetry.js";
import { updateSkillConfigEntry } from "../../skills/config/mutations.js";
import { collectSkillBins } from "../../skills/discovery/bins.js";
import { buildWorkspaceSkillStatus } from "../../skills/discovery/status.js";
import {
  installSkillFromClawHub,
  readLocalSkillCardContentSync,
  searchSkillsFromClawHub,
  updateSkillsFromClawHub,
} from "../../skills/lifecycle/clawhub.js";
import { installSkill } from "../../skills/lifecycle/install.js";
import { installUploadedSkillArchive } from "../../skills/lifecycle/upload-install.js";
import { loadWorkspaceSkillEntries } from "../../skills/loading/workspace.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import {
  collectClawHubVerdictTargets,
  fetchOpenClawSkillSecurityVerdicts,
} from "../../skills/security/clawhub-verdicts.js";
import {
  getSkillCuratorStatus,
  SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE,
} from "../../skills/workshop/curator.js";
import {
  applySkillProposal,
  evaluateSkillProposal,
  inspectSkillProposal,
  listSkillProposalEvents,
  listSkillProposals,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  rejectSkillProposal,
  reviseSkillProposal,
} from "../../skills/workshop/service.js";
import { skillProposalHistoryHandlers } from "./skills-proposal-history.js";
import { skillsUploadHandlers } from "./skills-upload.js";
import {
  resolveSkillsAgentWorkspace,
  runSkillsProposalWorkspaceHandler,
  SKILL_PROPOSAL_RESPONSE_HANDLED,
  type ResolvedSkillsWorkspace,
} from "./skills-workspace-handler.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ClawHubInstallResult = Awaited<ReturnType<typeof installSkillFromClawHub>>;
type ClawHubInstallParams = Parameters<typeof installSkillFromClawHub>[0];

const clawHubInstallsInFlight = new Map<string, Promise<ClawHubInstallResult>>();

function installClawHubSkillDeduped(params: ClawHubInstallParams): Promise<ClawHubInstallResult> {
  // A WebSocket can disappear after the request reached the Gateway. Keep one
  // exact install per workspace in flight so a reconnect can safely reattach.
  const key = JSON.stringify([
    params.workspaceDir,
    params.slug,
    params.version ?? null,
    params.force ?? false,
  ]);
  const active = clawHubInstallsInFlight.get(key);
  if (active) {
    return active;
  }
  const install = installSkillFromClawHub(params);
  clawHubInstallsInFlight.set(key, install);
  void install
    .finally(() => {
      if (clawHubInstallsInFlight.get(key) === install) {
        clawHubInstallsInFlight.delete(key);
      }
    })
    .catch(() => undefined);
  return install;
}

function buildRemoteAwareWorkspaceSkillStatus(resolved: ResolvedSkillsWorkspace) {
  // Remote skill availability depends on the agent's executable-node surface,
  // not only the workspace contents, so status reports include live eligibility.
  const nodeSkills = resolveNodeExecEligibility({
    cfg: resolved.cfg,
    agentId: resolved.agentId,
  });
  return buildWorkspaceSkillStatus(resolved.workspaceDir, {
    config: resolved.cfg,
    agentId: resolved.agentId,
    eligibility: {
      nodeSkills,
      remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec }),
    },
  });
}

function respondSkillWorkshopError(respond: RespondFn, err: unknown) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(err)));
}

function respondRetiredSkillCuratorAction(
  { params, respond }: GatewayRequestHandlerOptions,
  method: `skills.curator.${"pin" | "restore" | "unpin"}`,
): void {
  if (!assertValidParams(params, validateSkillsCuratorActionParams, method, respond)) {
    return;
  }
  respondSkillWorkshopError(respond, new Error(SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE));
}

function collectClawHubTrustWarnings(results: Array<{ warning?: string }>): string[] {
  return results
    .map((result) => normalizeOptionalString(result.warning))
    .filter((warning): warning is string => Boolean(warning));
}

function buildRevisionAgentInstruction(
  proposal: Awaited<ReturnType<typeof inspectSkillProposal>>,
  expectedRevisionHash: string,
) {
  if (!proposal) {
    return "";
  }
  return [
    `Revise Skill Workshop proposal \`${proposal.record.id}\` (${proposal.record.target.skillKey}).`,
    "",
    "Use `skill_workshop` with `action=inspect` first, then `action=revise` for that pending proposal.",
    `Pass \`expected_revision_hash=${expectedRevisionHash}\` to reject stale proposal revisions.`,
    "Do not apply, approve, reject, quarantine, or install the proposal.",
    "",
    "Requested changes:",
  ].join("\n");
}

async function forwardSkillWorkshopRevisionToChatSend(
  opts: GatewayRequestHandlerOptions,
  params: {
    agentId: string;
    idempotencyKey: string;
    instructions: string;
    proposal: NonNullable<Awaited<ReturnType<typeof inspectSkillProposal>>>;
    expectedRevisionHash: string;
    sessionId?: string;
    sessionKey: string;
    targetAgentId?: string;
  },
): Promise<void> {
  const { chatHandlers } = await import("./chat.js");
  const chatSend = chatHandlers["chat.send"];
  if (!chatSend) {
    throw new Error("chat.send handler is unavailable");
  }
  const chatParams = {
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId ?? params.agentId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    message: params.instructions,
    deliver: false,
    systemProvenanceReceipt: buildRevisionAgentInstruction(
      params.proposal,
      params.expectedRevisionHash,
    ),
    suppressCommandInterpretation: true,
    idempotencyKey: params.idempotencyKey,
  };
  await chatSend({
    ...opts,
    req: { ...opts.req, method: "chat.send", params: chatParams },
    params: chatParams,
  });
}

/** Gateway request handlers for skill status, catalogs, installs, updates, and workshop proposals. */
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

async function listCandidateFiles(candidatesDir: string): Promise<
  Array<{
    id: string;
    lane: string;
    failingTool: string;
    recoveringTool: string;
    rationale: string;
  }>
> {
  try {
    const entries = await fsp.readdir(candidatesDir);
    const candidates: Array<{
      id: string;
      lane: string;
      failingTool: string;
      recoveringTool: string;
      rationale: string;
    }> = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      try {
        const raw = await fsp.readFile(path.join(candidatesDir, entry), "utf8");
        const data = JSON.parse(raw);
        candidates.push({
          id: data.candidateId ?? entry.replace(".json", ""),
          lane: data.lane ?? "unknown",
          failingTool: data.failingTool ?? "unknown",
          recoveringTool: data.recoveringTool ?? "unknown",
          rationale: data.rationale ?? "",
        });
      } catch {
        // skip malformed
      }
    }
    return candidates;
  } catch {
    return [];
  }
}

async function readSkillDescription(skillDir: string): Promise<string> {
  try {
    const mdPath = path.join(skillDir, "SKILL.md");
    const content = await fsp.readFile(mdPath, "utf8");
    // Parse YAML frontmatter between --- markers
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!match) {
      return "";
    }
    const descMatch = match[1]?.match(/^description:\s*['"]?(.+?)['"]?\s*$/m);
    return descMatch?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

async function buildForgeStatus() {
  const [telemetry, promotedDirs, stagedDirs, retiredDirs, candidateFiles] = await Promise.all([
    listTelemetryEntries().catch(() => [] as SkillTelemetryEntry[]),
    listDirs(resolveSkillForgeSkillsRoot()),
    listDirs(resolveSkillForgeStagedSkillsDir()),
    listDirs(resolveSkillForgeRetiredSkillsDir()),
    listCandidateFiles(resolveSkillForgeCandidatesDir()),
  ]);

  const promoted = promotedDirs.filter((d) => d !== "_staging" && d !== "_retired");

  // Read descriptions from SKILL.md frontmatter
  const promotedSkillsRoot = resolveSkillForgeSkillsRoot();
  const stagedSkillsRoot = resolveSkillForgeStagedSkillsDir();
  const retiredSkillsRoot = resolveSkillForgeRetiredSkillsDir();

  const [promotedDescs, stagedDescs, retiredDescs] = await Promise.all([
    Promise.all(promoted.map((name) => readSkillDescription(path.join(promotedSkillsRoot, name)))),
    Promise.all(stagedDirs.map((name) => readSkillDescription(path.join(stagedSkillsRoot, name)))),
    Promise.all(
      retiredDirs.map((name) => readSkillDescription(path.join(retiredSkillsRoot, name))),
    ),
  ]);

  return {
    schema: "openclaw.skill-forge.status.v1" as const,
    candidates: candidateFiles.length,
    promoted: promoted.length,
    staged: stagedDirs.length,
    retired: retiredDirs.length,
    telemetry: telemetry.length,
    skills: {
      candidates: candidateFiles,
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
}

function respondSkillForgeError(respond: RespondFn, err: unknown) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(err)));
}

export const skillsHandlers: GatewayRequestHandlers = {
  ...skillsUploadHandlers,
  ...skillProposalHistoryHandlers,
  "skills.status": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsStatusParams, "skills.status", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const report = buildRemoteAwareWorkspaceSkillStatus(resolved);
    respond(true, report, undefined);
  },
  "skills.securityVerdicts": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSkillsSecurityVerdictsParams,
        "skills.securityVerdicts",
        respond,
      )
    ) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    try {
      const report = buildRemoteAwareWorkspaceSkillStatus(resolved);
      const targets = collectClawHubVerdictTargets(report);
      if (targets.length === 0) {
        respond(true, { schema: "openclaw.skills.security-verdicts.v1", items: [] }, undefined);
        return;
      }
      const items = await fetchOpenClawSkillSecurityVerdicts(targets);
      respond(true, { schema: "openclaw.skills.security-verdicts.v1", items }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.skillCard": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsSkillCardParams, "skills.skillCard", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const report = buildWorkspaceSkillStatus(resolved.workspaceDir, {
      config: resolved.cfg,
      agentId: resolved.agentId,
    });
    const skill = report.skills.find((candidate) => candidate.skillKey === params.skillKey);
    if (!skill?.skillCard) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `skill card not found for ${params.skillKey}`),
      );
      return;
    }
    const content = readLocalSkillCardContentSync(skill.baseDir);
    if (content === undefined) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `skill card not readable for ${params.skillKey}`),
      );
      return;
    }
    respond(
      true,
      {
        schema: "openclaw.skills.skill-card.v1",
        skillKey: skill.skillKey,
        path: skill.skillCard.path,
        sizeBytes: skill.skillCard.sizeBytes,
        content,
      },
      undefined,
    );
  },
  "skills.bins": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsBinsParams, "skills.bins", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.search": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSkillsSearchParams, "skills.search", respond)) {
      return;
    }
    try {
      const results = await searchSkillsFromClawHub({
        query: (params as { query?: string }).query,
        limit: (params as { limit?: number }).limit,
      });
      respond(true, { results }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.detail": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSkillsDetailParams, "skills.detail", respond)) {
      return;
    }
    try {
      const detail = await fetchClawHubSkillDetail({
        slug: (params as { slug: string }).slug,
      });
      respond(true, detail, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(err)));
    }
  },
  "skills.curator.status": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSkillsCuratorStatusParams,
        "skills.curator.status",
        respond,
      )
    ) {
      return;
    }
    respond(true, getSkillCuratorStatus(), undefined);
  },
  "skills.curator.pin": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.pin"),
  "skills.curator.unpin": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.unpin"),
  "skills.curator.restore": (options) =>
    respondRetiredSkillCuratorAction(options, "skills.curator.restore"),
  "skills.proposals.list": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.list",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalsListParams,
      run: (_parsedParams, resolved) =>
        listSkillProposals({ agentId: resolved.agentId, workspaceDir: resolved.workspaceDir }),
    });
  },
  "skills.proposals.events.list": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.events.list",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalEventsListParams,
      run: async (parsedParams, resolved) =>
        listSkillProposalEvents({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          proposalId: parsedParams.proposalId,
          afterSequence: parsedParams.afterSequence,
          limit: parsedParams.limit,
        }),
    });
  },
  "skills.proposals.inspect": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.inspect",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalInspectParams,
      run: async (parsedParams, resolved) => {
        const proposal = await inspectSkillProposal(parsedParams.proposalId, {
          agentId: resolved.agentId,
          workspaceDir: resolved.workspaceDir,
        });
        if (!proposal) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Skill proposal not found: ${parsedParams.proposalId}`,
            ),
          );
          return SKILL_PROPOSAL_RESPONSE_HANDLED;
        }
        return proposal;
      },
    });
  },
  "skills.proposals.evaluate": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.evaluate",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalEvaluateParams,
      run: (parsedParams, resolved) =>
        evaluateSkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          trigger: "manual",
        }),
    });
  },
  "skills.proposals.create": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.create",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalCreateParams,
      run: (parsedParams, resolved) =>
        proposeCreateSkill({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          name: parsedParams.name,
          description: parsedParams.description,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          createdBy: "gateway",
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }),
    });
  },
  "skills.proposals.update": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.update",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalUpdateParams,
      run: (parsedParams, resolved) =>
        proposeUpdateSkill({
          workspaceDir: resolved.workspaceDir,
          config: resolved.cfg,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          skillName: parsedParams.skillName,
          description: parsedParams.description,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          createdBy: "gateway",
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }),
    });
  },
  "skills.proposals.revise": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.revise",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalReviseParams,
      run: (parsedParams, resolved) =>
        reviseSkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          content: parsedParams.content,
          supportFiles: parsedParams.supportFiles,
          description: parsedParams.description,
          goal: parsedParams.goal,
          evidence: parsedParams.evidence,
        }),
    });
  },
  "skills.proposals.requestRevision": async (opts) => {
    const { params, respond, context } = opts;
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.requestRevision",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalRequestRevisionParams,
      run: async (parsedParams, resolved) => {
        const proposal = await inspectSkillProposal(parsedParams.proposalId, {
          agentId: resolved.agentId,
          workspaceDir: resolved.workspaceDir,
        });
        if (!proposal) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Skill proposal not found: ${parsedParams.proposalId}`,
            ),
          );
          return SKILL_PROPOSAL_RESPONSE_HANDLED;
        }
        if (proposal.record.status !== "pending") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Skill proposal is not pending: ${parsedParams.proposalId}`,
            ),
          );
          return SKILL_PROPOSAL_RESPONSE_HANDLED;
        }
        if (
          parsedParams.expectedRevisionHash &&
          parsedParams.expectedRevisionHash !== proposal.revisionHash
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Skill proposal revision changed: ${parsedParams.proposalId}`,
            ),
          );
          return SKILL_PROPOSAL_RESPONSE_HANDLED;
        }
        await forwardSkillWorkshopRevisionToChatSend(opts, {
          agentId: resolved.agentId,
          expectedRevisionHash: parsedParams.expectedRevisionHash ?? proposal.revisionHash,
          idempotencyKey: parsedParams.idempotencyKey,
          instructions: parsedParams.instructions,
          proposal,
          sessionId: parsedParams.sessionId,
          sessionKey: parsedParams.sessionKey,
          targetAgentId: parsedParams.targetAgentId
            ? normalizeAgentId(parsedParams.targetAgentId)
            : undefined,
        });
        return SKILL_PROPOSAL_RESPONSE_HANDLED;
      },
    });
  },
  "skills.proposals.apply": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.apply",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalActionParams,
      run: (parsedParams, resolved) =>
        applySkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          config: resolved.cfg,
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          reason: parsedParams.reason,
        }),
    });
  },
  "skills.proposals.reject": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.reject",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalActionParams,
      run: (parsedParams, resolved) =>
        rejectSkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          reason: parsedParams.reason,
        }),
    });
  },
  "skills.proposals.quarantine": async ({ params, respond, context }) => {
    await runSkillsProposalWorkspaceHandler({
      method: "skills.proposals.quarantine",
      rawParams: params,
      respond,
      context,
      validate: validateSkillsProposalActionParams,
      run: (parsedParams, resolved) =>
        quarantineSkillProposal({
          workspaceDir: resolved.workspaceDir,
          agentId: resolved.agentId,
          eventActor: { type: "gateway" },
          proposalId: parsedParams.proposalId,
          expectedRevisionHash: parsedParams.expectedRevisionHash,
          correlationId: parsedParams.correlationId,
          reason: parsedParams.reason,
        }),
    });
  },
  "skills.install": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsInstallParams, "skills.install", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const cfg = resolved.cfg;
    const workspaceDirRaw = resolved.workspaceDir;
    // Skill installs are intentionally routed by source; each source owns its
    // validation, provenance checks, and result payload shape.
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug: string;
        version?: string;
        force?: boolean;
      };
      const result = await installClawHubSkillDeduped({
        workspaceDir: workspaceDirRaw,
        slug: p.slug,
        version: p.version,
        force: Boolean(p.force),
        logger: context.logGateway,
        config: cfg,
      });
      const errorDetails = result.ok ? undefined : buildClawHubTrustErrorDetails(result);
      respond(
        result.ok,
        result.ok
          ? {
              ok: true,
              message: `Installed ${result.slug}@${result.version}`,
              stdout: "",
              stderr: "",
              code: 0,
              slug: result.slug,
              version: result.version,
              targetDir: result.targetDir,
              ...(result.warning ? { warning: result.warning } : {}),
            }
          : result,
        result.ok
          ? undefined
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              result.error,
              errorDetails ? { details: errorDetails } : undefined,
            ),
      );
      return;
    }
    if (params && typeof params === "object" && "source" in params && params.source === "upload") {
      const p = params as {
        source: "upload";
        uploadId: string;
        slug: string;
        force?: boolean;
        sha256?: string;
        timeoutMs?: number;
      };
      const result = await installUploadedSkillArchive({
        uploadId: p.uploadId,
        slug: p.slug,
        force: Boolean(p.force),
        sha256: p.sha256,
        timeoutMs: p.timeoutMs,
        workspaceDir: workspaceDirRaw,
        config: cfg,
        log: context.logGateway,
      });
      const errorCode =
        !result.ok && result.errorKind === "invalid-request"
          ? ErrorCodes.INVALID_REQUEST
          : ErrorCodes.UNAVAILABLE;
      const responseResult = result.ok
        ? result
        : {
            ok: false,
            error: result.error,
            errorCode,
          };
      respond(
        result.ok,
        responseResult,
        result.ok ? undefined : errorShape(errorCode, result.error),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSkillsUpdateParams, "skills.update", respond)) {
      return;
    }
    if (params && typeof params === "object" && "source" in params && params.source === "clawhub") {
      const p = params as {
        source: "clawhub";
        slug?: string;
        all?: boolean;
        force?: boolean;
      };
      if (!p.slug && !p.all) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, 'clawhub skills.update requires "slug" or "all"'),
        );
        return;
      }
      if (p.slug && p.all) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            'clawhub skills.update accepts either "slug" or "all", not both',
          ),
        );
        return;
      }
      const resolved = resolveSkillsAgentWorkspace(params, context);
      if (!resolved.ok) {
        respond(false, undefined, resolved.error);
        return;
      }
      const results = await updateSkillsFromClawHub({
        workspaceDir: resolved.workspaceDir,
        slug: p.slug,
        ...(p.force ? { force: true } : {}),
        logger: context.logGateway,
        config: resolved.cfg,
      });
      const errors = results.filter((result) => !result.ok);
      const warnings = collectClawHubTrustWarnings(results);
      respond(
        errors.length === 0,
        {
          ok: errors.length === 0,
          skillKey: p.slug ?? "*",
          config: {
            source: "clawhub",
            results,
          },
        },
        errors.length === 0
          ? undefined
          : errorShape(ErrorCodes.UNAVAILABLE, errors.map((result) => result.error).join("; "), {
              details: {
                results,
                ...(warnings.length > 0 ? { warnings } : {}),
              },
            }),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
    };
    const updated = await updateSkillConfigEntry(p);
    respond(
      true,
      { ok: true, skillKey: p.skillKey, config: redactConfigObject(updated) },
      undefined,
    );
  },
  "skills.forge.status": async ({ respond }) => {
    try {
      const status = await buildForgeStatus();
      respond(true, status, undefined);
    } catch (err) {
      respondSkillForgeError(respond, err);
    }
  },
  "skills.forge.run": async ({ respond }) => {
    try {
      const result: PipelineRunResult = await runForgePipeline();
      respond(
        true,
        {
          schema: "openclaw.skill-forge.run.v1",
          scannedCaptureDirs: result.scannedCaptureDirs,
          candidateCount: result.candidates.length,
          draftedCount: result.drafted.length,
          promotedCount: result.promotions.filter((p) => p.status === "promoted").length,
          drafted: result.drafted.map((d) => ({ name: d.name, skillDir: d.skillDir })),
          promotions: result.promotions,
        },
        undefined,
      );
    } catch (err) {
      respondSkillForgeError(respond, err);
    }
  },
  "skills.forge.promote": async ({ params, respond }) => {
    const name = (params as { name?: string })?.name;
    if (!name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "name is required"));
      return;
    }
    try {
      const result = await promoteStagedSkill({ name });
      if (result.status === "rejected") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            result.verdict.reasons.join("; ") ?? "gate check failed",
          ),
        );
        return;
      }
      respond(
        true,
        {
          schema: "openclaw.skill-forge.promote.v1",
          status: "promoted",
          name: result.name,
          promotedDir: result.promotedDir,
        },
        undefined,
      );
    } catch (err) {
      respondSkillForgeError(respond, err);
    }
  },
  "skills.forge.retire": async ({ params, respond }) => {
    const name = (params as { name?: string })?.name;
    const reason = (params as { reason?: string })?.reason ?? "manual retirement";
    if (!name) {
      // Run decay sweep
      try {
        const retired = await runDecaySweep({ policy: DEFAULT_DECAY_POLICY });
        respond(
          true,
          {
            schema: "openclaw.skill-forge.decay.v1",
            retiredCount: retired.length,
            retired,
          },
          undefined,
        );
      } catch (err) {
        respondSkillForgeError(respond, err);
      }
      return;
    }
    try {
      const entry = await recordSkillDemotion({ name, reason });
      respond(
        true,
        {
          schema: "openclaw.skill-forge.retire.v1",
          status: "retired",
          name,
          reason,
          entry,
        },
        undefined,
      );
    } catch (err) {
      respondSkillForgeError(respond, err);
    }
  },
  "skills.forge.telemetry": async ({ respond }) => {
    try {
      const entries = await listTelemetryEntries();
      respond(
        true,
        {
          schema: "openclaw.skill-forge.telemetry.v1",
          entries,
        },
        undefined,
      );
    } catch (err) {
      respondSkillForgeError(respond, err);
    }
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
