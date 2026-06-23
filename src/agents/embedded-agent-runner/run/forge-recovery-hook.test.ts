import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SkillSnapshot } from "../../../skills/types.js";
import type { AfterToolCallContext, Agent } from "../../runtime/index.js";
import { installForgeRecoveryHook } from "./forge-recovery-hook.js";

type AfterToolCall = NonNullable<Agent["afterToolCall"]>;

function fakeAgent(): { agent: Agent; getHook: () => AfterToolCall | undefined } {
  const agent = { afterToolCall: undefined } as unknown as Agent;
  return { agent, getHook: () => agent.afterToolCall };
}

function errorContext(toolName: string, isError = true): AfterToolCallContext {
  return {
    toolCall: { name: toolName },
    isError,
    result: { content: [{ type: "text", text: "boom" }], details: {} },
  } as unknown as AfterToolCallContext;
}

describe("installForgeRecoveryHook", () => {
  let dir: string;

  async function snapshotWith(name: string, body: string): Promise<SkillSnapshot> {
    const skillDir = path.join(dir, name);
    await fsp.mkdir(skillDir, { recursive: true });
    const filePath = path.join(skillDir, "SKILL.md");
    await fsp.writeFile(filePath, `---\nname: ${name}\ndescription: d\n---\n\n${body}\n`, "utf8");
    return {
      prompt: "",
      skills: [],
      resolvedSkills: [{ name, filePath, baseDir: skillDir, source: "openclaw-skill-forge" }],
    } as unknown as SkillSnapshot;
  }

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "forge-hook-"));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("inlines the recovery skill and records usage on a matching tool error", async () => {
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Run it twice.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const result = await getHook()!(errorContext("exec"));
    const text = result?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
    expect(text).toContain("<system-reminder>");
    expect(text).toContain("forge-recover-exec-via-exec");
    expect(text).toContain("Run it twice.");
    // Original error content is preserved before the injected reminder.
    expect(text).toContain("boom");
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith("forge-recover-exec-via-exec");
  });

  it("fires for a content-encoded error result even when context.isError is false", async () => {
    // OpenClaw tools surface most failures as a structured error RESULT
    // (details.status === "error") without throwing, so agent-core reports
    // context.isError === false. Recovery must still fire via isToolResultError.
    const skills = await snapshotWith("forge-recover-read-via-exec", "Read recovery.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const context = {
      toolCall: { name: "read" },
      isError: false,
      result: { content: [{ type: "text", text: "ENOENT" }], details: { status: "error" } },
    } as unknown as AfterToolCallContext;
    const result = await getHook()!(context);
    const text = result?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
    expect(text).toContain("forge-recover-read-via-exec");
    expect(recordUsage).toHaveBeenCalledExactlyOnceWith("forge-recover-read-via-exec");
  });

  it("does NOT fire on a successful command that merely exits non-zero", async () => {
    // grep with no match / diff with changes / test failures exit non-zero but
    // are status "completed" — not a recovery-worthy failure. Recovery must skip.
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const context = {
      toolCall: { name: "exec" },
      isError: false,
      result: {
        content: [{ type: "text", text: "no match" }],
        details: { status: "completed", exitCode: 1 },
      },
    } as unknown as AfterToolCallContext;
    const result = await getHook()!(context);
    expect(result).toBeUndefined();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("does NOT fire when a non-zero exit is also flagged isError=true", async () => {
    // Production shape: a probe (ssh-wrapped ping to a down host) runs to
    // completion, exits non-zero, and agent-core flags isError=true via
    // isToolResultError. The broad isError signal must not override the
    // non-zero-exit exclusion, or every failing probe injects a "just retry"
    // recovery skill and tells the agent to re-run a deterministic failure.
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const context = {
      toolCall: { name: "exec" },
      isError: true,
      result: {
        content: [{ type: "text", text: "100% packet loss" }],
        details: { status: "completed", exitCode: 1 },
      },
    } as unknown as AfterToolCallContext;
    const result = await getHook()!(context);
    expect(result).toBeUndefined();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("still fires for a non-zero exit that carries a structured error", async () => {
    // A genuine failure (details.error / failure status) must recover even with
    // a non-zero exit — the exclusion is only for bare completed non-zero exits.
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const context = {
      toolCall: { name: "exec" },
      isError: true,
      result: {
        content: [{ type: "text", text: "boom" }],
        details: { status: "error", exitCode: 1, error: "spawn failed" },
      },
    } as unknown as AfterToolCallContext;
    const result = await getHook()!(context);
    const text = result?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
    expect(text).toContain("forge-recover-exec-via-exec");
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it("still fires for a non-zero exit that timed out", async () => {
    // A watchdog-killed command (timedOut=true, exitCode 137, status completed)
    // is recovery-worthy — the non-zero-exit exclusion must not swallow it.
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const context = {
      toolCall: { name: "exec" },
      isError: true,
      result: {
        content: [{ type: "text", text: "killed" }],
        details: { status: "completed", exitCode: 137, timedOut: true },
      },
    } as unknown as AfterToolCallContext;
    const result = await getHook()!(context);
    const text = result?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
    expect(text).toContain("forge-recover-exec-via-exec");
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it("fires at most once per attempt for the same skill", async () => {
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    await getHook()!(errorContext("exec"));
    const second = await getHook()!(errorContext("exec"));
    expect(second).toBeUndefined();
    expect(recordUsage).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a successful tool result", async () => {
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const result = await getHook()!(errorContext("exec", false));
    expect(result).toBeUndefined();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("ignores errors with no matching recovery skill", async () => {
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const result = await getHook()!(errorContext("read"));
    expect(result).toBeUndefined();
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it("matches a tool name whose skill token differs (read_file → read-file)", async () => {
    const skills = await snapshotWith("forge-recover-read-file-via-mkdir", "Recovery body.");
    const recordUsage = vi.fn();
    const { agent, getHook } = fakeAgent();
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage });

    const result = await getHook()!(errorContext("read_file"));
    const text = result?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
    expect(text).toContain("forge-recover-read-file-via-mkdir");
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it("is a no-op when disabled by config", async () => {
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const { agent, getHook } = fakeAgent();
    const config = { skills: { forge: { autoInvoke: false } } } as unknown as OpenClawConfig;
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, config });
    expect(getHook()).toBeUndefined();
  });

  it("preserves a previously installed afterToolCall hook", async () => {
    const skills = await snapshotWith("forge-recover-exec-via-exec", "Recovery body.");
    const previous = vi.fn(async () => ({ content: [{ type: "text" as const, text: "prev" }] }));
    const { agent, getHook } = fakeAgent();
    agent.afterToolCall = previous;
    installForgeRecoveryHook({ agent, skillsSnapshot: skills, recordUsage: vi.fn() });

    const result = await getHook()!(errorContext("exec"));
    const text = result?.content?.map((c) => (c.type === "text" ? c.text : "")).join("") ?? "";
    expect(previous).toHaveBeenCalledOnce();
    // Prior hook's content is kept and the reminder is appended after it.
    expect(text).toContain("prev");
    expect(text).toContain("<system-reminder>");
  });
});
