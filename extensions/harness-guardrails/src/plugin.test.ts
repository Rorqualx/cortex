import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import guardrailsEntry from "../index.js";

type AnyHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

function setup(pluginConfig: unknown, runCommand = vi.fn()) {
  const handlers = new Map<string, AnyHandler>();
  const api = createTestPluginApi({
    registrationMode: "full",
    pluginConfig,
    runtime: { system: { runCommandWithTimeout: runCommand } },
    on: (name: string, handler: AnyHandler) => {
      handlers.set(name, handler);
    },
  } as never);
  guardrailsEntry.register(api);
  return { handlers, runCommand };
}

const exited = (code: number, stdout = "", stderr = "") => ({
  stdout,
  stderr,
  code,
  termination: "exit",
  signal: null,
  killed: false,
});

const cronCtx = { trigger: "cron", agentId: "main", workspaceDir: "/repo" };

// git status returns changed unless told otherwise; the check command returns `check`.
function runner(check: unknown, opts: { changed?: boolean } = {}) {
  return vi.fn(async (argv: string[]) => {
    if (argv.includes("status")) {
      return exited(0, opts.changed === false ? "" : " M file.ts\n");
    }
    return check;
  });
}

describe("harness-guardrails register", () => {
  it("registers no hooks when everything is disabled (default)", () => {
    expect(setup(undefined).handlers.size).toBe(0);
  });

  it("registers only the finalize hook when the quality gate is enabled", () => {
    const { handlers } = setup({ qualityCheck: { enabled: true } });
    expect([...handlers.keys()]).toEqual(["before_agent_finalize"]);
  });

  it("registers only the prompt hook when plan.mode is prompt", () => {
    const { handlers } = setup({ plan: { mode: "prompt" } });
    expect([...handlers.keys()]).toEqual(["before_prompt_build"]);
  });
});

describe("harness-guardrails quality gate", () => {
  it("passes through interactive (user) turns without running anything", async () => {
    const run = runner(exited(1, "", "boom"));
    const { handlers } = setup({ qualityCheck: { enabled: true } }, run);
    const result = await handlers.get("before_agent_finalize")!(
      { cwd: "/repo" },
      { trigger: "user", agentId: "main", workspaceDir: "/repo" },
    );
    expect(result).toEqual({ action: "continue" });
    expect(run).not.toHaveBeenCalled();
  });

  it("skips the check when the working tree is clean", async () => {
    const run = runner(exited(1, "", "boom"), { changed: false });
    const { handlers } = setup({ qualityCheck: { enabled: true } }, run);
    const result = await handlers.get("before_agent_finalize")!({ cwd: "/repo" }, cronCtx);
    expect(result).toEqual({ action: "continue" });
    // Only `git status` ran; the quality command was never invoked.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toContain("status");
  });

  it("continues when the check passes", async () => {
    const run = runner(exited(0, "all good"));
    const { handlers } = setup({ qualityCheck: { enabled: true } }, run);
    const result = await handlers.get("before_agent_finalize")!({ cwd: "/repo" }, cronCtx);
    expect(result).toEqual({ action: "continue" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("revises with the failure summary when the check fails", async () => {
    const run = runner(exited(1, "3 tests failed", "lint: unused var"));
    const { handlers } = setup({ qualityCheck: { enabled: true } }, run);
    const result = (await handlers.get("before_agent_finalize")!({ cwd: "/repo" }, cronCtx)) as {
      action: string;
      reason: string;
      retry: { instruction: string; idempotencyKey: string; maxAttempts: number };
    };
    expect(result.action).toBe("revise");
    expect(result.reason).toContain("lint: unused var");
    expect(result.retry.instruction).toContain("3 tests failed");
    expect(result.retry.idempotencyKey).toMatch(/^harness-guardrails:qc:[a-f0-9]{12}$/);
    expect(result.retry.maxAttempts).toBe(2);
  });

  it("fails open (continue) when the check times out", async () => {
    const run = runner({
      stdout: "",
      stderr: "",
      code: null,
      termination: "timeout",
      signal: null,
      killed: true,
    });
    const { handlers } = setup({ qualityCheck: { enabled: true } }, run);
    const result = await handlers.get("before_agent_finalize")!({ cwd: "/repo" }, cronCtx);
    expect(result).toEqual({ action: "continue" });
  });

  it("runs the check regardless of git when onlyWhenCodeChanged is false", async () => {
    const run = runner(exited(1, "fail"));
    const { handlers } = setup(
      { qualityCheck: { enabled: true, onlyWhenCodeChanged: false } },
      run,
    );
    const result = (await handlers.get("before_agent_finalize")!({ cwd: "/repo" }, cronCtx)) as {
      action: string;
    };
    expect(result.action).toBe("revise");
    // No git status call — went straight to the check.
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).not.toContain("status");
  });

  it("falls back to ctx.workspaceDir when event.cwd is absent", async () => {
    const run = runner(exited(0, "ok"));
    const { handlers } = setup({ qualityCheck: { enabled: true } }, run);
    const result = await handlers.get("before_agent_finalize")!({}, cronCtx);
    expect(result).toEqual({ action: "continue" });
    expect(run.mock.calls[0]![0]).toEqual(["git", "-C", "/repo", "status", "--porcelain"]);
  });

  it("is out of scope for agents not on the allowlist", async () => {
    const run = runner(exited(1, "fail"));
    const { handlers } = setup(
      { qualityCheck: { enabled: true }, applyTo: { triggers: ["cron"], agents: ["other"] } },
      run,
    );
    const result = await handlers.get("before_agent_finalize")!({ cwd: "/repo" }, cronCtx);
    expect(result).toEqual({ action: "continue" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("harness-guardrails plan directive", () => {
  it("injects guidance for in-scope turns and nothing for interactive turns", async () => {
    const { handlers } = setup({ plan: { mode: "prompt" } });
    const inScope = (await handlers.get("before_prompt_build")!({}, cronCtx)) as {
      prependSystemContext: string;
    };
    expect(inScope.prependSystemContext).toContain("plan");
    const interactive = await handlers.get("before_prompt_build")!(
      {},
      { trigger: "user", agentId: "main" },
    );
    expect(interactive).toBeUndefined();
  });
});
