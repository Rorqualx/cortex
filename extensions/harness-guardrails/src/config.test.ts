import { describe, expect, it } from "vitest";
import { resolveGuardrailsConfig } from "./config.js";

describe("resolveGuardrailsConfig", () => {
  it("defaults every gate OFF and scopes to cron", () => {
    const cfg = resolveGuardrailsConfig(undefined);
    expect(cfg.qualityCheck.enabled).toBe(false);
    expect(cfg.plan.mode).toBe("off");
    expect(cfg.applyTo.triggers).toEqual(["cron"]);
    expect(cfg.applyTo.agents).toBeUndefined();
    expect(cfg.qualityCheck.command).toEqual(["pnpm", "check:changed"]);
    expect(cfg.qualityCheck.env).toEqual({ CI: "1" });
    expect(cfg.qualityCheck.extraArgs).toEqual(["--config.verify-deps-before-run=false"]);
    expect(cfg.qualityCheck.onlyWhenCodeChanged).toBe(true);
    expect(cfg.qualityCheck.timeoutMs).toBeGreaterThanOrEqual(1_000);
  });

  it("passes through provided values", () => {
    const cfg = resolveGuardrailsConfig({
      applyTo: { triggers: ["cron", "heartbeat"], agents: ["main"] },
      qualityCheck: {
        enabled: true,
        command: ["pnpm", "lint"],
        env: { CI: "1", FOO: "bar" },
        extraArgs: [],
        timeoutMs: 30_000,
        onlyWhenCodeChanged: false,
      },
      plan: { mode: "prompt" },
    });
    expect(cfg.applyTo).toEqual({ triggers: ["cron", "heartbeat"], agents: ["main"] });
    expect(cfg.qualityCheck).toEqual({
      enabled: true,
      command: ["pnpm", "lint"],
      env: { CI: "1", FOO: "bar" },
      extraArgs: [],
      timeoutMs: 30_000,
      onlyWhenCodeChanged: false,
    });
    expect(cfg.plan.mode).toBe("prompt");
  });

  it("rejects unknown keys and invalid values", () => {
    expect(() => resolveGuardrailsConfig({ nope: true })).toThrow(/Invalid harness-guardrails/);
    expect(() => resolveGuardrailsConfig({ qualityCheck: { timeoutMs: 5 } })).toThrow(
      /Invalid harness-guardrails/,
    );
    expect(() => resolveGuardrailsConfig({ plan: { mode: "approval" } })).toThrow(
      /Invalid harness-guardrails/,
    );
    expect(() => resolveGuardrailsConfig({ qualityCheck: { command: [] } })).toThrow(
      /Invalid harness-guardrails/,
    );
  });
});
