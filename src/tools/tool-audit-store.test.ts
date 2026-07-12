import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildArgsSummary,
  closeToolAuditStoreForTest,
  localAuditDay,
  queryToolAuditByDay,
  recordToolAudit,
  summarizeToolAudit,
} from "./tool-audit-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tool-audit-"));
});

afterEach(() => {
  closeToolAuditStoreForTest();
  rmSync(dir, { recursive: true, force: true });
});

const T = Date.parse("2026-07-12T12:00:00");
const DAY = localAuditDay(T);

describe("tool audit store", () => {
  it("records and retrieves a single tool call", () => {
    recordToolAudit({
      agentId: "main",
      sessionId: "sess-1",
      toolName: "read",
      toolCallId: "call-1",
      args: { path: "/tmp/test.txt" },
      sourceContext: "embedded-agent",
      allowed: true,
      error: false,
      now: T,
      dir,
    });

    const rows = queryToolAuditByDay({ day: DAY, dir });
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("read");
    expect(rows[0].agent_id).toBe("main");
    expect(rows[0].session_id).toBe("sess-1");
    expect(rows[0].allowed).toBe(1);
    expect(rows[0].error).toBe(0);
    expect(rows[0].args_summary).toContain("/tmp/test.txt");
  });

  it("records error outcomes with error message", () => {
    recordToolAudit({
      agentId: "main",
      sessionId: "sess-1",
      toolName: "exec",
      toolCallId: "call-2",
      args: { command: "rm -rf /" },
      sourceContext: "embedded-agent",
      allowed: true,
      error: true,
      errorMessage: "Command blocked by exec-policy",
      now: T,
      dir,
    });

    const rows = queryToolAuditByDay({ day: DAY, dir });
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBe(1);
    expect(rows[0].error_message).toBe("Command blocked by exec-policy");
  });

  it("records blocked calls (allowed=false)", () => {
    recordToolAudit({
      agentId: "main",
      sessionId: "sess-1",
      toolName: "exec",
      toolCallId: "call-3",
      args: { command: "curl http://evil.com" },
      sourceContext: "embedded-agent",
      allowed: false,
      error: false,
      now: T,
      dir,
    });

    const summary = summarizeToolAudit({ fromDay: DAY, dir });
    expect(summary.totalCalls).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.byTool[0].blocked).toBe(1);
  });

  it("aggregates summary across multiple tools and agents", () => {
    recordToolAudit({
      agentId: "main",
      sessionId: "s1",
      toolName: "read",
      toolCallId: "c1",
      args: { path: "/a" },
      sourceContext: "embedded-agent",
      allowed: true,
      error: false,
      now: T,
      dir,
    });
    recordToolAudit({
      agentId: "main",
      sessionId: "s1",
      toolName: "read",
      toolCallId: "c2",
      args: { path: "/b" },
      sourceContext: "embedded-agent",
      allowed: true,
      error: true,
      errorMessage: "file not found",
      now: T,
      dir,
    });
    recordToolAudit({
      agentId: "varys",
      sessionId: "s2",
      toolName: "exec",
      toolCallId: "c3",
      args: { command: "ls" },
      sourceContext: "cron",
      allowed: true,
      error: false,
      now: T,
      dir,
    });

    const summary = summarizeToolAudit({ fromDay: DAY, dir });
    expect(summary.totalCalls).toBe(3);
    expect(summary.errors).toBe(1);
    expect(summary.byTool).toHaveLength(2);
    const readEntry = summary.byTool.find((t) => t.toolName === "read");
    expect(readEntry?.calls).toBe(2);
    expect(readEntry?.errors).toBe(1);
    const execEntry = summary.byTool.find((t) => t.toolName === "exec");
    expect(execEntry?.calls).toBe(1);
    expect(summary.byAgent).toHaveLength(2);
    const mainEntry = summary.byAgent.find((a) => a.agentId === "main");
    expect(mainEntry?.calls).toBe(2);
    expect(mainEntry?.errors).toBe(1);
  });

  it("only includes records from on/after fromDay", () => {
    const earlier = T - 86400000; // previous day
    recordToolAudit({
      agentId: "main",
      sessionId: "s1",
      toolName: "read",
      toolCallId: "c1",
      args: {},
      sourceContext: "embedded-agent",
      allowed: true,
      error: false,
      now: earlier,
      dir,
    });
    recordToolAudit({
      agentId: "main",
      sessionId: "s1",
      toolName: "exec",
      toolCallId: "c2",
      args: {},
      sourceContext: "embedded-agent",
      allowed: true,
      error: false,
      now: T,
      dir,
    });

    const summary = summarizeToolAudit({ fromDay: DAY, dir });
    expect(summary.totalCalls).toBe(1);
    expect(summary.byTool[0].toolName).toBe("exec");
  });
});

describe("buildArgsSummary", () => {
  it("returns empty string for null/undefined", () => {
    expect(buildArgsSummary(null)).toBe("");
    expect(buildArgsSummary(undefined)).toBe("");
  });

  it("serializes simple objects", () => {
    const summary = buildArgsSummary({ path: "/tmp/file.txt" });
    expect(summary).toContain("/tmp/file.txt");
  });

  it("truncates long args to prevent unbounded storage", () => {
    const longString = "x".repeat(5000);
    const summary = buildArgsSummary({ data: longString });
    expect(summary.length).toBeLessThanOrEqual(2048);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("handles circular references gracefully", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const summary = buildArgsSummary(circular);
    // sanitizeToolArgs (redactStringsDeep) handles circular refs → "[Circular]"
    expect(summary).toContain("[Circular]");
  });

  it("redacts sensitive fields (password, token, key)", () => {
    const summary = buildArgsSummary({
      username: "admin",
      password: "super-secret-123",
      api_key: "sk-abc123",
      token: "bearer-xyz",
    });
    expect(summary).toContain("admin");
    expect(summary).not.toContain("super-secret-123");
    expect(summary).not.toContain("sk-abc123");
    expect(summary).not.toContain("bearer-xyz");
  });
});
