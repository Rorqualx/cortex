import { createPhaseTracker } from "../infra/agent-execution-events.js";
import { filterToolsByPolicy } from "./agent-tools.policy.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { emitToolDenied } from "./event-ledger-helper.js";
import { isKnownCoreToolId } from "./tool-catalog.js";
import { auditToolPolicyFilter, type ToolPolicyAuditLogLevel } from "./tool-policy-audit.js";
import {
  analyzeAllowlistByToolType,
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  type ToolPolicyLike,
} from "./tool-policy.js";

const MAX_TOOL_POLICY_WARNING_CACHE = 256;
const seenToolPolicyWarnings = new Set<string>();
const toolPolicyWarningOrder: string[] = [];

function rememberToolPolicyWarning(warning: string): boolean {
  if (seenToolPolicyWarnings.has(warning)) {
    return false;
  }
  if (seenToolPolicyWarnings.size >= MAX_TOOL_POLICY_WARNING_CACHE) {
    const oldest = toolPolicyWarningOrder.shift();
    if (oldest) {
      seenToolPolicyWarnings.delete(oldest);
    }
  }
  seenToolPolicyWarnings.add(warning);
  toolPolicyWarningOrder.push(warning);
  return true;
}

export type ToolPolicyPipelineStep = {
  policy: ToolPolicyLike | undefined;
  label: string;
  stripPluginOnlyAllowlist?: boolean;
  suppressUnavailableCoreToolWarning?: boolean;
  suppressUnavailableCoreToolWarningAllowlist?: string[];
  unavailableCoreToolReason?: string;
};

export function buildDefaultToolPolicyPipelineSteps(params: {
  profilePolicy?: ToolPolicyLike;
  profile?: string;
  profileUnavailableCoreWarningAllowlist?: string[];
  providerProfilePolicy?: ToolPolicyLike;
  providerProfile?: string;
  providerProfileUnavailableCoreWarningAllowlist?: string[];
  globalPolicy?: ToolPolicyLike;
  globalProviderPolicy?: ToolPolicyLike;
  agentPolicy?: ToolPolicyLike;
  agentProviderPolicy?: ToolPolicyLike;
  groupPolicy?: ToolPolicyLike;
  senderPolicy?: ToolPolicyLike;
  agentId?: string;
  unavailableCoreToolReason?: string;
}): ToolPolicyPipelineStep[] {
  const agentId = params.agentId?.trim();
  const profile = params.profile?.trim();
  const providerProfile = params.providerProfile?.trim();
  const unavailableCoreToolReason = params.unavailableCoreToolReason?.trim();
  return [
    {
      policy: params.profilePolicy,
      label: profile ? `tools.profile (${profile})` : "tools.profile",
      stripPluginOnlyAllowlist: true,
      suppressUnavailableCoreToolWarningAllowlist: params.profileUnavailableCoreWarningAllowlist,
      unavailableCoreToolReason,
    },
    {
      policy: params.providerProfilePolicy,
      label: providerProfile
        ? `tools.byProvider.profile (${providerProfile})`
        : "tools.byProvider.profile",
      stripPluginOnlyAllowlist: true,
      suppressUnavailableCoreToolWarningAllowlist:
        params.providerProfileUnavailableCoreWarningAllowlist,
      unavailableCoreToolReason,
    },
    {
      policy: params.globalPolicy,
      label: "tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.globalProviderPolicy,
      label: "tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.agentPolicy,
      label: agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.agentProviderPolicy,
      label: agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.groupPolicy,
      label: "group tools.allow",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
    {
      policy: params.senderPolicy,
      label: "tools.toolsBySender",
      stripPluginOnlyAllowlist: true,
      unavailableCoreToolReason,
    },
  ];
}

export function applyToolPolicyPipeline(params: {
  tools: AnyAgentTool[];
  toolMeta: (tool: AnyAgentTool) => { pluginId: string } | undefined;
  warn: (message: string) => void;
  steps: ToolPolicyPipelineStep[];
  auditLogLevel?: ToolPolicyAuditLogLevel;
  runId?: string;
  sessionKey?: string;
  traceContext?: import("../infra/agent-execution-events.js").W3CTraceContext;
}): AnyAgentTool[] {
  const coreToolNames = new Set(
    params.tools
      .filter((tool) => !params.toolMeta(tool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );

  const pluginGroups = buildPluginToolGroups({
    tools: params.tools,
    toolMeta: params.toolMeta,
  });

  // Create phase tracker for policy check events if runId is provided
  const policyTracker = params.runId
    ? createPhaseTracker<"policy_check">({
        runId: params.runId,
        stream: "policy_check",
        sessionKey: params.sessionKey,
        traceContext: params.traceContext,
      })
    : null;

  let filtered = params.tools;

  // Emit policy pipeline start event
  if (policyTracker) {
    policyTracker.start("deny_list_start");
  }

  for (const step of params.steps) {
    if (!step.policy) {
      continue;
    }

    // Emit policy step start event if tracking enabled
    if (policyTracker) {
      const stepPhase = step.label.includes("profile")
        ? ("capability_start" as const)
        : step.label.includes("group")
          ? ("permission_start" as const)
          : step.label.includes("sandbox")
            ? ("sandbox_start" as const)
            : step.label.includes("subagent")
              ? ("rate_limit_start" as const)
              : ("deny_list_start" as const);
      policyTracker.start(stepPhase);
    }

    let policy: ToolPolicyLike | undefined = step.policy;
    if (step.stripPluginOnlyAllowlist) {
      const resolved = analyzeAllowlistByToolType(policy, pluginGroups, coreToolNames);
      if (resolved.unknownAllowlist.length > 0) {
        const unavailableCoreWarningAllowlist = new Set(
          (step.suppressUnavailableCoreToolWarningAllowlist ?? []).map((entry) =>
            normalizeToolName(entry),
          ),
        );
        const gatedCoreEntries = resolved.unknownAllowlist.filter((entry) =>
          isKnownCoreToolId(entry),
        );
        const warnableGatedCoreEntries = step.suppressUnavailableCoreToolWarning
          ? []
          : gatedCoreEntries.filter((entry) => !unavailableCoreWarningAllowlist.has(entry));
        const otherEntries = resolved.unknownAllowlist.filter(
          (entry) => !isKnownCoreToolId(entry) && !unavailableCoreWarningAllowlist.has(entry),
        );
        const warningEntries = [...warnableGatedCoreEntries, ...otherEntries];
        if (
          shouldWarnAboutUnknownAllowlist({
            hasGatedCoreEntries: warnableGatedCoreEntries.length > 0,
            hasOtherEntries: otherEntries.length > 0,
          })
        ) {
          const entries = warningEntries.join(", ");
          const suffix = describeUnknownAllowlistSuffix({
            pluginOnlyAllowlist: resolved.pluginOnlyAllowlist,
            hasGatedCoreEntries: warnableGatedCoreEntries.length > 0,
            hasOtherEntries: otherEntries.length > 0,
            unavailableCoreToolReason: step.unavailableCoreToolReason,
          });
          const warning = `tools: ${step.label} allowlist contains unknown entries (${entries}). ${suffix}`;
          if (rememberToolPolicyWarning(warning)) {
            params.warn(warning);
          }
        }
      }
      policy = resolved.policy;
    }

    const expanded = expandPolicyWithPluginGroups(policy, pluginGroups);
    if (!expanded) {
      continue;
    }
    const before = filtered;
    filtered = filterToolsByPolicy(before, expanded);
    auditToolPolicyFilter({
      stepLabel: step.label,
      policy: expanded,
      before,
      after: filtered,
      logLevel: params.auditLogLevel,
    });

    // Emit policy decision events for denied tools
    const denied = new Set(before.map((t) => t.name));
    for (const allowed of filtered) {
      denied.delete(allowed.name);
    }
    for (const toolName of denied) {
      void emitToolDenied({
        toolName,
        denyReason: step.label,
      });
    }

    // Emit policy step complete event if tracking enabled
    if (policyTracker) {
      const stepPhase = step.label.includes("profile")
        ? ("capability_complete" as const)
        : step.label.includes("group")
          ? ("permission_complete" as const)
          : step.label.includes("sandbox")
            ? ("sandbox_complete" as const)
            : step.label.includes("subagent")
              ? ("rate_limit_complete" as const)
              : ("deny_list_complete" as const);
      policyTracker.complete(stepPhase, {
        stepLabel: step.label,
        beforeCount: before.length,
        afterCount: filtered.length,
        deniedCount: denied.size,
      });
    }
  }
  // Emit policy pipeline complete event if tracking enabled
  if (policyTracker) {
    policyTracker.complete("deny_list_complete", {
      finalToolCount: filtered.length,
      initialToolCount: params.tools.length,
      stepsProcessed: params.steps.length,
    });
  }
  return filtered;
}

function shouldWarnAboutUnknownAllowlist(params: {
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
}): boolean {
  return params.hasGatedCoreEntries || params.hasOtherEntries;
}

function describeUnknownAllowlistSuffix(params: {
  pluginOnlyAllowlist: boolean;
  hasGatedCoreEntries: boolean;
  hasOtherEntries: boolean;
  unavailableCoreToolReason?: string;
}): string {
  const preface = params.pluginOnlyAllowlist
    ? "Allowlist contains only plugin entries; core tools will not be available."
    : "";
  const unavailableCoreToolReason = params.unavailableCoreToolReason?.trim();
  const unavailableCoreDetail = unavailableCoreToolReason
    ? `These entries are shipped core tools but unavailable here: ${unavailableCoreToolReason}.`
    : "These entries are shipped core tools but unavailable in the current runtime/provider/model/config.";
  const mixedUnavailableCoreDetail = unavailableCoreToolReason
    ? `Some entries are shipped core tools but unavailable here: ${unavailableCoreToolReason}; other entries won't match any tool unless the plugin is enabled.`
    : "Some entries are shipped core tools but unavailable in the current runtime/provider/model/config; other entries won't match any tool unless the plugin is enabled.";
  const detail =
    params.hasGatedCoreEntries && params.hasOtherEntries
      ? mixedUnavailableCoreDetail
      : params.hasGatedCoreEntries
        ? unavailableCoreDetail
        : "These entries won't match any tool unless the plugin is enabled.";
  return preface ? `${preface} ${detail}` : detail;
}

export function resetToolPolicyWarningCacheForTest(): void {
  seenToolPolicyWarnings.clear();
  toolPolicyWarningOrder.length = 0;
}
