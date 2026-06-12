// Approval policy for skill_forge lifecycle mutations (promote/retire).
// Lives beside the workshop service because both read skills.workshop config.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookBeforeToolCallResult } from "../../plugins/types.js";
import { resolveSkillWorkshopConfig } from "./config.js";

// Only promote/retire mutate the live skill set directly; pipeline runs are
// covered by the forge validation gate, and the remaining actions are reads.
const SKILL_FORGE_LIFECYCLE_ACTIONS = new Set(["promote", "retire"]);

type SkillForgeLifecycleAction = "promote" | "retire";

function readLifecycleAction(params: unknown): SkillForgeLifecycleAction | undefined {
  const action = asNullableRecord(params)?.action;
  if (typeof action !== "string" || !SKILL_FORGE_LIFECYCLE_ACTIONS.has(action)) {
    return undefined;
  }
  return action as SkillForgeLifecycleAction;
}

function lifecycleApprovalText(action: SkillForgeLifecycleAction): {
  title: string;
  description: string;
  severity: "info" | "warning";
} {
  if (action === "promote") {
    return {
      title: "Promote staged skill",
      description: "Promote a staged Skill Forge skill into the live skills directory.",
      severity: "warning",
    };
  }
  return {
    title: "Retire skill",
    description: "Retire a promoted Skill Forge skill (or run a decay sweep).",
    severity: "info",
  };
}

/** Returns approval policy for skill_forge lifecycle tool calls. */
export function resolveSkillForgeToolApproval(params: {
  toolName: string;
  toolParams: unknown;
  config?: OpenClawConfig;
}): PluginHookBeforeToolCallResult | undefined {
  if (params.toolName !== "skill_forge") {
    return undefined;
  }
  const action = readLifecycleAction(params.toolParams);
  if (!action) {
    return undefined;
  }
  const config = resolveSkillWorkshopConfig(params.config);
  if (config.approvalPolicy === "auto") {
    return undefined;
  }
  const text = lifecycleApprovalText(action);
  return {
    requireApproval: {
      ...text,
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}
