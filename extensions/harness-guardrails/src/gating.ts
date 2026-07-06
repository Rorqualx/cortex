// Scope + change-detection helpers for the finalize gate.
import type { ResolvedGuardrailsConfig } from "./config.js";

// Minimal view of the hook context we gate on (subset of PluginHookAgentContext).
export type GateContext = {
  trigger?: string;
  agentId?: string;
};

// Subset of api.runtime.system.runCommandWithTimeout's result we depend on.
export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  termination: string;
};

export type CommandRunner = (
  argv: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
) => Promise<CommandResult>;

/**
 * True when this turn's trigger (and agent, if an allowlist is set) is in scope.
 * Interactive turns (`user`/`manual`) are excluded by the default `["cron"]`.
 */
export function isInScope(cfg: ResolvedGuardrailsConfig, ctx: GateContext): boolean {
  const trigger = typeof ctx.trigger === "string" ? ctx.trigger : "";
  if (!cfg.applyTo.triggers.includes(trigger)) {
    return false;
  }
  if (cfg.applyTo.agents) {
    const agentId = typeof ctx.agentId === "string" ? ctx.agentId : "";
    if (!cfg.applyTo.agents.includes(agentId)) {
      return false;
    }
  }
  return true;
}

/**
 * True when the working tree has uncommitted changes. The finalize event carries
 * no touched-file list, so we ask git directly. Fail-open: any non-clean git
 * result (non-zero, timeout) returns false so we don't gate on an ambiguous state.
 */
export async function workingTreeHasChanges(
  runCommand: CommandRunner,
  cwd: string,
): Promise<boolean> {
  try {
    const result = await runCommand(["git", "-C", cwd, "status", "--porcelain"], {
      cwd,
      timeoutMs: 5_000,
    });
    return result.termination === "exit" && result.code === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
