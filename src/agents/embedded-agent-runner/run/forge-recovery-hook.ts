/**
 * Auto-invokes SkillForge recovery skills. When a tool call returns an error and
 * a promoted `forge-recover-<failingTool>-via-<recoverTool>` skill is loaded, the
 * skill's prose is inlined into the failed tool result as a system-reminder and
 * its usage is recorded. Without this the forged recovery skills are never
 * applied, the same tool errors recur every session, and the decay sweep retires
 * the (never-used) skills — the loop this hook breaks.
 */
import fsp from "node:fs/promises";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { recordSkillUsage } from "../../../skill-forge/telemetry.js";
import type { SkillSnapshot } from "../../../skills/types.js";
import type { AfterToolCallContext, AfterToolCallResult, Agent } from "../../runtime/index.js";

const FORGE_SKILL_SOURCE = "openclaw-skill-forge";
const RECOVERY_NAME_PREFIX = "forge-recover-";
// Cap inlined prose so an oversized SKILL.md cannot blow up the tool-result payload.
const MAX_INLINE_BODY_CHARS = 4000;

/** Encode a tool name the same way distiller skill names do (lowercase, non-alnum → hyphen). */
function toNameToken(tool: string): string {
  return tool
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]+?\n---\n([\s\S]*)$/u);
  return (match ? match[1] : content).trim();
}

/**
 * Chain a recovery-skill auto-invocation hook onto the agent's afterToolCall.
 * No-op when disabled by config or when no forge recovery skills are loaded.
 */
export function installForgeRecoveryHook(params: {
  agent: Agent;
  skillsSnapshot?: SkillSnapshot;
  config?: OpenClawConfig;
  /** Injectable usage recorder (tests); defaults to forge telemetry, fire-and-forget. */
  recordUsage?: (name: string) => void;
}): void {
  // Opt-out switch for a hot-path behavior change (default on).
  if (params.config?.skills?.forge?.autoInvoke === false) {
    return;
  }
  const recoverySkills = (params.skillsSnapshot?.resolvedSkills ?? []).filter(
    (skill) => skill.source === FORGE_SKILL_SOURCE && skill.name.startsWith(RECOVERY_NAME_PREFIX),
  );
  if (recoverySkills.length === 0) {
    return;
  }
  const recordUsage =
    params.recordUsage ??
    ((name: string): void => {
      // Inline injection bypasses the SKILL.md read path that normally records
      // usage, so record here; otherwise the decay sweep retires the recovery
      // skills that are actually firing. Best-effort: never block the result.
      void recordSkillUsage({ name }).catch(() => {});
    });

  // Inject + record each matching skill at most once per attempt: repeated
  // identical errors must not re-paste prose or inflate usage counts.
  const fired = new Set<string>();
  const previousAfterToolCall = params.agent.afterToolCall?.bind(params.agent);
  params.agent.afterToolCall = async (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ): Promise<AfterToolCallResult | undefined> => {
    const hookResult = await previousAfterToolCall?.(context, signal);
    if (!context.isError) {
      return hookResult;
    }
    const failingTool = toNameToken(context.toolCall.name);
    if (!failingTool) {
      return hookResult;
    }
    const skill = recoverySkills.find((candidate) =>
      candidate.name.startsWith(`${RECOVERY_NAME_PREFIX}${failingTool}-via-`),
    );
    if (!skill || fired.has(skill.name)) {
      return hookResult;
    }
    fired.add(skill.name);
    let body: string;
    try {
      body = stripFrontmatter(await fsp.readFile(skill.filePath, "utf8"));
    } catch {
      return hookResult;
    }
    if (!body) {
      return hookResult;
    }
    recordUsage(skill.name);
    const inlineBody =
      body.length > MAX_INLINE_BODY_CHARS ? `${body.slice(0, MAX_INLINE_BODY_CHARS)}\n…` : body;
    const reminder =
      `<system-reminder>\nThe \`${context.toolCall.name}\` tool failed. SkillForge recovery ` +
      `skill "${skill.name}" applies here — follow it before retrying:\n\n${inlineBody}\n` +
      `</system-reminder>`;
    const baseContent = hookResult?.content ?? context.result.content;
    return {
      ...hookResult,
      content: [...baseContent, { type: "text" as const, text: reminder }],
    };
  };
}
