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
import { readToolResultDetails, readToolResultStatus } from "../../tool-result-error.js";

const FORGE_SKILL_SOURCE = "openclaw-skill-forge";
const RECOVERY_NAME_PREFIX = "forge-recover-";

// Result statuses that mean the tool GENUINELY failed in a way a recovery skill
// could address. Deliberately narrower than isToolResultError(): we exclude
// non-zero exitCode (a successful grep/diff/test exits non-zero), and user/policy
// outcomes (aborted/cancelled/blocked/denied/disabled) where retrying via another
// tool would not help. Tool throws are surfaced by the tool adapter as
// details.status "error" + details.error, so those are caught here.
const RECOVERABLE_FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "timeout",
  "timed_out",
]);

/** Whether a tool RESULT represents a genuine, recovery-worthy failure (no throw needed). */
function isRecoverableToolFailure(result: unknown): boolean {
  const details = readToolResultDetails(result);
  if (!details) {
    return false;
  }
  if (details.ok === false || details.success === false) {
    return true;
  }
  if (typeof details.error === "string" && details.error.length > 0) {
    return true;
  }
  const status = readToolResultStatus(result);
  return status !== undefined && RECOVERABLE_FAILURE_STATUSES.has(status);
}

/**
 * A command that ran to completion but merely exited non-zero (grep no-match, a
 * failing test, a ping to a down host). Upstream isToolResultError flags these
 * isError=true, but they are NOT recovery-worthy: re-running a deterministic
 * non-zero exit just repeats it. Identified by a non-zero exitCode with no
 * structured-failure signal (no details.error / ok=false / failure status) — a
 * genuine throw or structured failure keeps those fields and still recovers.
 */
function isCompletedNonZeroExit(result: unknown): boolean {
  const details = readToolResultDetails(result);
  if (!details) {
    return false;
  }
  const exitCode = details.exitCode;
  const nonZeroExit = typeof exitCode === "number" && Number.isFinite(exitCode) && exitCode !== 0;
  if (!nonZeroExit) {
    return false;
  }
  // A watchdog timeout is recovery-worthy (isToolResultError treats timedOut as a
  // failure signal, and "timeout"/"timed_out" are recoverable statuses), so a
  // timed-out non-zero exit is NOT a benign completed exit — let recovery fire.
  if (details.timedOut === true) {
    return false;
  }
  if (details.ok === false || details.success === false) {
    return false;
  }
  if (typeof details.error === "string" && details.error.length > 0) {
    return false;
  }
  const status = readToolResultStatus(result);
  return status === undefined || !RECOVERABLE_FAILURE_STATUSES.has(status);
}
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
  return (match?.[1] ?? content).trim();
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
      // skills that are actually firing. Invoke-time only: each call snapshots
      // the skill-pool size for the precision-vs-pool-size curve. Post-run
      // outcomes (taskSucceeded / invocationOutcome) are stamped separately via
      // recordSkillUsageOutcome once the run result is known — never here.
      // Best-effort: never block the result.
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
    // OpenClaw tools surface most failures as a structured error RESULT
    // (details.status "error", details.error) without throwing, so isError can
    // read false there — isRecoverableToolFailure catches those. The broad
    // isError flag (context or upstream hook) also fires for a command that ran
    // to completion but merely exited non-zero (isToolResultError treats any
    // non-zero exit as error); recovery must NOT fire for those, since
    // re-running a deterministic non-zero exit just repeats it. So honor the
    // broad signal only when the result is not a completed non-zero exit.
    const broadIsError = context.isError || hookResult?.isError === true;
    const failed =
      isRecoverableToolFailure(context.result) ||
      (broadIsError && !isCompletedNonZeroExit(context.result));
    if (!failed) {
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
