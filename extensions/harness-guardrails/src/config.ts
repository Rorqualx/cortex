// Config schema + resolver for the harness-guardrails plugin.
//
// One `harness-guardrails` plugin namespace. The plugin is bundled and activates
// for every install, so every gate defaults OFF: the hooks register but no-op
// until an operator opts in. This keeps existing installs' behavior unchanged.
import { buildPluginConfigSchema, type OpenClawPluginConfigSchema } from "openclaw/plugin-sdk/core";
import {
  formatPluginConfigIssue,
  mapPluginConfigIssues,
} from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";

export type PlanMode = "off" | "prompt";

export type ResolvedGuardrailsConfig = {
  applyTo: {
    // EmbeddedRunTrigger values that the gate applies to. Default ["cron"] so
    // interactive (user/manual) turns are never gated. ctx.trigger is a raw
    // string, so this stays a string[] and is compared literally.
    triggers: string[];
    agents?: string[];
  };
  qualityCheck: {
    enabled: boolean;
    command: string[];
    // Injected into the child env. CI=1 forces `check:changed` to run local lanes
    // instead of delegating to remote Testbox (which would hang a gateway subprocess).
    env: Record<string, string>;
    extraArgs: string[];
    timeoutMs: number;
    onlyWhenCodeChanged: boolean;
  };
  plan: {
    mode: PlanMode;
  };
};

const DEFAULT_TRIGGERS = ["cron"] as const;
const DEFAULT_QUALITY_COMMAND = ["pnpm", "check:changed"] as const;
const DEFAULT_QUALITY_ENV: Record<string, string> = { CI: "1" };
const DEFAULT_QUALITY_EXTRA_ARGS = ["--config.verify-deps-before-run=false"] as const;
const DEFAULT_QUALITY_TIMEOUT_MS = 600_000;

const nonEmptyString = (message: string) =>
  z.string({ error: message }).trim().min(1, { error: message });

const GuardrailsConfigSchema = z.strictObject({
  applyTo: z
    .strictObject({
      triggers: z
        .array(nonEmptyString("applyTo.triggers entries must be non-empty strings"))
        .optional(),
      agents: z
        .array(nonEmptyString("applyTo.agents entries must be non-empty strings"))
        .optional(),
    })
    .optional(),
  qualityCheck: z
    .strictObject({
      enabled: z.boolean({ error: "qualityCheck.enabled must be a boolean" }).optional(),
      command: z
        .array(nonEmptyString("qualityCheck.command entries must be non-empty strings"))
        .min(1, { error: "qualityCheck.command must have at least one entry" })
        .optional(),
      env: z.record(z.string(), z.string()).optional(),
      extraArgs: z
        .array(nonEmptyString("qualityCheck.extraArgs entries must be non-empty strings"))
        .optional(),
      timeoutMs: z
        .number({ error: "qualityCheck.timeoutMs must be a number" })
        .int({ error: "qualityCheck.timeoutMs must be an integer" })
        .min(1_000, { error: "qualityCheck.timeoutMs must be >= 1000" })
        .optional(),
      onlyWhenCodeChanged: z
        .boolean({ error: "qualityCheck.onlyWhenCodeChanged must be a boolean" })
        .optional(),
    })
    .optional(),
  plan: z
    .strictObject({
      mode: z.enum(["off", "prompt"], { error: "plan.mode must be one of off, prompt" }).optional(),
    })
    .optional(),
});

export function createGuardrailsConfigSchema(): OpenClawPluginConfigSchema {
  return buildPluginConfigSchema(GuardrailsConfigSchema, {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      const parsed = GuardrailsConfigSchema.safeParse(value);
      if (parsed.success) {
        return { success: true, data: parsed.data };
      }
      return { success: false, error: { issues: mapPluginConfigIssues(parsed.error.issues) } };
    },
  });
}

export function resolveGuardrailsConfig(value: unknown): ResolvedGuardrailsConfig {
  const parsed = GuardrailsConfigSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const message = formatPluginConfigIssue(parsed.error.issues[0]);
    throw new Error(`Invalid harness-guardrails plugin config: ${message}`);
  }
  const cfg = parsed.data;
  const qc = cfg.qualityCheck ?? {};
  return {
    applyTo: {
      triggers: cfg.applyTo?.triggers ?? [...DEFAULT_TRIGGERS],
      agents: cfg.applyTo?.agents,
    },
    qualityCheck: {
      enabled: qc.enabled ?? false,
      command: qc.command ?? [...DEFAULT_QUALITY_COMMAND],
      env: qc.env ?? { ...DEFAULT_QUALITY_ENV },
      extraArgs: qc.extraArgs ?? [...DEFAULT_QUALITY_EXTRA_ARGS],
      timeoutMs: qc.timeoutMs ?? DEFAULT_QUALITY_TIMEOUT_MS,
      onlyWhenCodeChanged: qc.onlyWhenCodeChanged ?? true,
    },
    plan: { mode: cfg.plan?.mode ?? "off" },
  };
}
