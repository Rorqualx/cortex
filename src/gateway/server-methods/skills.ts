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
import type { SkillLibrarySelection } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope-config.js";
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
        listSkillProposals({ config: resolved.cfg, agentId: resolved.agentId }),
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
          agentId: resolved.agentId,
          config: resolved.cfg,
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
          config: resolved.cfg,
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
          config: resolved.cfg,
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
          config: resolved.cfg,
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
          config: resolved.cfg,
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
          config: resolved.cfg,
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
      agentId: resolved.agentId,
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
