// harness-guardrails registration: wires the finalize quality gate and the
// optional plan-first directive onto existing agent hooks. Everything is gated
// to in-scope (default: cron) turns and defaults OFF, so a normal install is inert.
import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveGuardrailsConfig } from "./config.js";
import {
  isInScope,
  workingTreeHasChanges,
  type CommandRunner,
  type GateContext,
} from "./gating.js";
import { PLAN_FIRST_GUIDANCE } from "./plan-directive.js";
import { runQualityCheck } from "./quality-gate.js";

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

export function registerGuardrails(api: OpenClawPluginApi): void {
  // Skip metadata-only registration passes; only wire runtime behavior on full load.
  if (api.registrationMode !== "full") {
    return;
  }
  const cfg = resolveGuardrailsConfig(api.pluginConfig);

  // Phase 3 (opt-in): nudge in-scope turns to plan first and check before committing.
  if (cfg.plan.mode === "prompt") {
    api.on("before_prompt_build", async (_event, ctx) => {
      if (!isInScope(cfg, ctx as GateContext)) {
        return;
      }
      return { prependSystemContext: PLAN_FIRST_GUIDANCE };
    });
  }

  // Phase 1: deterministic quality gate. Revise the finalize when changed-file
  // checks fail; fail-open and pass-through otherwise. Bounded by the harness's
  // 3-revision cap, and pre-commit only (the harness refuses revision after a
  // deterministic side effect).
  if (cfg.qualityCheck.enabled) {
    const runCommand: CommandRunner = (argv, options) =>
      api.runtime.system.runCommandWithTimeout(argv, {
        timeoutMs: options.timeoutMs ?? cfg.qualityCheck.timeoutMs,
        cwd: options.cwd,
        env: options.env,
      });

    api.on("before_agent_finalize", async (event, ctx) => {
      if (!isInScope(cfg, ctx as GateContext)) {
        return { action: "continue" };
      }
      const cwd = event.cwd ?? ctx.workspaceDir;
      if (typeof cwd !== "string" || cwd.length === 0) {
        return { action: "continue" };
      }
      if (cfg.qualityCheck.onlyWhenCodeChanged && !(await workingTreeHasChanges(runCommand, cwd))) {
        return { action: "continue" };
      }

      const outcome = await runQualityCheck(runCommand, cwd, cfg.qualityCheck);
      if (outcome.status !== "fail") {
        return { action: "continue" };
      }
      return {
        action: "revise",
        reason: `Quality checks failed before finalizing:\n${outcome.summary}`,
        retry: {
          instruction: `The changed-file quality checks failed. Fix these, then stop:\n${outcome.summary}`,
          idempotencyKey: `harness-guardrails:qc:${shortHash(outcome.summary)}`,
          maxAttempts: 2,
        },
      };
    });
  }
}
