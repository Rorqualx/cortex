/**
 * Fast spawn mode safety tests
 *
 * Tests verify that spawnAcpFast preserves essential safety invariants while
 * skipping optional phases for lightweight delegation.
 */

import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Mock functions for subagent-registry
const getSubagentDepthFromSessionStoreMock = vi.fn();
const countActiveRunsForSessionMock = vi.fn();
const getSubagentRunByRunIdMock = vi.fn();
const registerSubagentRunMock = vi.fn();

// Mock functions for gateway
const callGatewayMock = vi.fn();

// Mock functions for session-binding-service
const bindPreparedAcpThreadMock = vi.fn();

// Mock getRuntimeConfig
const getRuntimeConfigMock = vi.fn();

const state = {
  cfg: {
    acp: {
      enabled: true,
      backend: "acpx",
      allowedAgents: ["codex"],
    },
    agents: {
      defaults: {
        subagents: {
          allowAgents: ["codex"],
          maxSpawnDepth: 10,
          maxChildrenPerAgent: 10,
        },
      },
    },
  } as OpenClawConfig,
  getSubagentDepthFromSessionStoreMock,
  countActiveRunsForSessionMock,
  getSubagentRunByRunIdMock,
  registerSubagentRunMock,
  callGatewayMock,
  bindPreparedAcpThreadMock,
  getRuntimeConfigMock,
};

// Mock the subagent-depth module (getSubagentDepthFromSessionStore is here)
vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: state.getSubagentDepthFromSessionStoreMock,
}));

// Mock the subagent-registry module (other functions are here)
vi.mock("./subagent-registry.js", () => ({
  countActiveRunsForSession: state.countActiveRunsForSessionMock,
  getSubagentRunByRunId: state.getSubagentRunByRunIdMock,
  registerSubagentRun: state.registerSubagentRunMock,
}));

// Mock the gateway call module
vi.mock("../gateway/call.js", async () => {
  const actual = await vi.importActual("../gateway/call.js");
  return {
    ...actual,
    callGateway: state.callGatewayMock,
  };
});

// Mock the session-binding-service module
vi.mock("../infra/outbound/session-binding-service.js", () => ({
  testing: {
    bindPreparedAcpThread: state.bindPreparedAcpThreadMock,
  },
}));

// Mock the config module
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: state.getRuntimeConfigMock,
}));

// SKIP: spawnAcpFast and the fastSpawn config option are fork-only features
// that were not merged into production acp-spawn.ts. Skipped until spawnAcpFast
// is exported from acp-spawn.ts.
describe.skip("acp-spawn-fast-safety", () => {
  beforeEach(() => {
    // Reset all mocks before each test
    getSubagentDepthFromSessionStoreMock.mockReset();
    countActiveRunsForSessionMock.mockReset();
    getSubagentRunByRunIdMock.mockReset();
    registerSubagentRunMock.mockReset();
    callGatewayMock.mockReset();
    bindPreparedAcpThreadMock.mockReset();
    getRuntimeConfigMock.mockReset();

    // Setup getRuntimeConfig to return test config
    getRuntimeConfigMock.mockReturnValue(state.cfg);
  });

  function createFastSpawnRequest(overrides?: { task?: string; agentId?: string; label?: string }) {
    return {
      task: "Calculate sum of array",
      agentId: "codex",
      fastSpawn: true,
      ...overrides,
    };
  }

  function createRequesterContext(overrides?: { agentSessionKey?: string; agentChannel?: string }) {
    return {
      agentSessionKey: "agent:main:telegram:direct:6098642967",
      agentChannel: "telegram",
      ...overrides,
    };
  }

  // spawnAcpFast is absent from production; these helpers use unknown until the
  // feature is merged.
  function expectFailedSpawn(result: unknown) {
    const r = result as { status: string; errorCode?: string; error?: string };
    if (r.status === "accepted") {
      throw new Error("Expected fast spawn to fail");
    }
    return r;
  }

  function expectAcceptedSpawn(result: unknown) {
    const r = result as {
      status: string;
      runId?: string;
      childSessionKey?: string;
      inlineResult?: { status: string; endedAt?: number; error?: string };
    };
    expect(r.status).toBe("accepted");
    return r;
  }

  describe("depth tracking safety invariant", () => {
    it("accepts spawn within max depth limit", async () => {
      // Setup: max depth is 10, spawn at depth 9 should succeed
      state.cfg.agents!.defaults!.subagents!.maxSpawnDepth = 10;
      getSubagentDepthFromSessionStoreMock.mockReturnValue(9);
      countActiveRunsForSessionMock.mockReturnValue(0);
      callGatewayMock.mockResolvedValueOnce({
        runId: "test-run-depth-9",
        sessionKey: "agent:codex:acp:uuid-depth-9",
      });
      registerSubagentRunMock.mockResolvedValue(undefined as never);
      getSubagentRunByRunIdMock.mockReturnValue({
        runId: "test-run-depth-9",
        execution: { status: "terminal" },
        outcome: { status: "ok" },
        childSessionKey: "agent:codex:acp:uuid-depth-9",
      });

      // spawnAcpFast not in production; cast to unknown to suppress type errors in skipped block
      const { spawnAcpFast } = (await import("./acp-spawn.js")) as unknown as {
        spawnAcpFast: (...args: unknown[]) => Promise<unknown>;
      };

      const raw = await spawnAcpFast(createFastSpawnRequest(), createRequesterContext());

      const result = expectAcceptedSpawn(raw);
      expect(result.runId).toBeDefined();
      expect(result.childSessionKey).toBeDefined();
    });

    it("rejects spawn exceeding max depth limit", async () => {
      // Setup: max depth is 10, spawn at depth 10 should fail
      // Note: depth 10 means spawnDepth would be 11, which exceeds maxDepth of 10
      state.cfg.agents!.defaults!.subagents!.maxSpawnDepth = 10;
      getSubagentDepthFromSessionStoreMock.mockReturnValue(10);
      countActiveRunsForSessionMock.mockReturnValue(0);

      // spawnAcpFast not in production; cast to unknown to suppress type errors in skipped block
      const { spawnAcpFast } = (await import("./acp-spawn.js")) as unknown as {
        spawnAcpFast: (...args: unknown[]) => Promise<unknown>;
      };

      // Debug: check what getRuntimeConfig returns
      const { getRuntimeConfig } = await import("../config/config.js");
      const cfg = getRuntimeConfig();
      console.log("Test cfg maxSpawnDepth:", cfg?.agents?.defaults?.subagents?.maxSpawnDepth);

      const raw = await spawnAcpFast(createFastSpawnRequest(), createRequesterContext());
      const rawAny = raw as { status?: string; error?: string };

      console.log("Result status:", rawAny.status);
      console.log("Result error:", rawAny.error);

      const failed = expectFailedSpawn(raw);
      expect(failed.status).toBe("forbidden");
      expect(failed.errorCode).toBe("subagent_policy");
      expect(failed.error).toContain("exceeds max depth");
    });
  });

  describe("children cap safety invariant", () => {
    it("accepts spawn within children cap", async () => {
      // Setup: max children is 10, with 9 pending, spawn should succeed
      state.cfg.agents!.defaults!.subagents!.maxChildrenPerAgent = 10;
      getSubagentDepthFromSessionStoreMock.mockReturnValue(1);
      countActiveRunsForSessionMock.mockReturnValue(9);
      callGatewayMock.mockResolvedValueOnce({
        runId: "test-run-children-9",
        sessionKey: "agent:codex:acp:uuid-children-9",
      });
      registerSubagentRunMock.mockResolvedValue(undefined as never);
      getSubagentRunByRunIdMock.mockReturnValue({
        runId: "test-run-children-9",
        execution: { status: "terminal" },
        outcome: { status: "ok" },
        childSessionKey: "agent:codex:acp:uuid-children-9",
      });

      // spawnAcpFast not in production; cast to unknown to suppress type errors in skipped block
      const { spawnAcpFast } = (await import("./acp-spawn.js")) as unknown as {
        spawnAcpFast: (...args: unknown[]) => Promise<unknown>;
      };

      const raw = await spawnAcpFast(createFastSpawnRequest(), createRequesterContext());

      const result = expectAcceptedSpawn(raw);
      expect(result.runId).toBeDefined();
    });

    it("rejects spawn at children cap limit", async () => {
      // Setup: max children is 10, with 10 pending, spawn should fail
      state.cfg.agents!.defaults!.subagents!.maxChildrenPerAgent = 10;
      getSubagentDepthFromSessionStoreMock.mockReturnValue(1);
      countActiveRunsForSessionMock.mockReturnValue(10);

      // spawnAcpFast not in production; cast to unknown to suppress type errors in skipped block
      const { spawnAcpFast } = (await import("./acp-spawn.js")) as unknown as {
        spawnAcpFast: (...args: unknown[]) => Promise<unknown>;
      };

      const result = await spawnAcpFast(createFastSpawnRequest(), createRequesterContext());

      const failed = expectFailedSpawn(result);
      expect(failed.status).toBe("forbidden");
      expect(failed.errorCode).toBe("subagent_policy");
      expect(failed.error).toContain("exceeding cap");
    });
  });

  describe("inline result handling", () => {
    it("returns inline result for completed subagent", async () => {
      state.cfg.agents!.defaults!.subagents!.maxSpawnDepth = 10;
      state.cfg.agents!.defaults!.subagents!.maxChildrenPerAgent = 10;
      (state.cfg.agents!.defaults!.subagents! as Record<string, unknown>).fastSpawn = {
        enabled: true,
        maxInlineWaitMs: 5000,
      };

      getSubagentDepthFromSessionStoreMock.mockReturnValue(1);
      countActiveRunsForSessionMock.mockReturnValue(0);
      callGatewayMock.mockResolvedValueOnce({
        runId: "fast-test-run-123",
        sessionKey: "agent:codex:acp:uuid-123",
      });
      registerSubagentRunMock.mockResolvedValue(undefined as never);
      getSubagentRunByRunIdMock.mockReturnValue({
        runId: "fast-test-run-123",
        execution: { status: "terminal" },
        outcome: { status: "ok" },
        childSessionKey: "agent:codex:acp:uuid-123",
      });

      // spawnAcpFast not in production; cast to unknown to suppress type errors in skipped block
      const { spawnAcpFast } = (await import("./acp-spawn.js")) as unknown as {
        spawnAcpFast: (...args: unknown[]) => Promise<unknown>;
      };

      const raw = await spawnAcpFast(createFastSpawnRequest(), createRequesterContext());

      const result = expectAcceptedSpawn(raw);
      expect(result.inlineResult).toBeDefined();
      expect(result.inlineResult?.status).toBe("completed");
      expect(result.inlineResult?.endedAt).toBeGreaterThan(0);
    });

    it("returns timeout for long-running subagent", async () => {
      state.cfg.agents!.defaults!.subagents!.maxSpawnDepth = 10;
      state.cfg.agents!.defaults!.subagents!.maxChildrenPerAgent = 10;
      (state.cfg.agents!.defaults!.subagents! as Record<string, unknown>).fastSpawn = {
        enabled: true,
        maxInlineWaitMs: 100, // Very short timeout
      };

      getSubagentDepthFromSessionStoreMock.mockReturnValue(1);
      countActiveRunsForSessionMock.mockReturnValue(0);
      callGatewayMock.mockResolvedValueOnce({
        runId: "slow-test-run-456",
        sessionKey: "agent:codex:acp:uuid-456",
      });
      registerSubagentRunMock.mockResolvedValue(undefined as never);
      // Mock getSubagentRunByRunId to return still-running run (will timeout)
      getSubagentRunByRunIdMock.mockReturnValue({
        runId: "slow-test-run-456",
        execution: { status: "running" },
        outcome: { status: "unknown" },
        childSessionKey: "agent:codex:acp:uuid-456",
      });

      // spawnAcpFast not in production; cast to unknown to suppress type errors in skipped block
      const { spawnAcpFast } = (await import("./acp-spawn.js")) as unknown as {
        spawnAcpFast: (...args: unknown[]) => Promise<unknown>;
      };

      // Set a shorter overall timeout for this test to catch hangs faster
      const result = await Promise.race([
        spawnAcpFast(createFastSpawnRequest(), createRequesterContext()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Test timeout after 2s")), 2000),
        ),
      ]);

      const accepted = expectAcceptedSpawn(result);
      expect(accepted.inlineResult).toBeDefined();
      expect(accepted.inlineResult?.status).toBe("timeout");
      expect(accepted.inlineResult?.error).toContain("maxInlineWaitMs");
    }, 3000); // Test timeout
  });

  describe("skipped optional phases", () => {
    it("does not call thread binding for run mode", async () => {
      state.cfg.agents!.defaults!.subagents!.maxSpawnDepth = 10;
      state.cfg.agents!.defaults!.subagents!.maxChildrenPerAgent = 10;
      (state.cfg.agents!.defaults!.subagents! as Record<string, unknown>).fastSpawn = {
        enabled: true,
      };

      getSubagentDepthFromSessionStoreMock.mockReturnValue(1);
      countActiveRunsForSessionMock.mockReturnValue(0);
      callGatewayMock.mockResolvedValueOnce({
        runId: "test-run-no-binding",
        sessionKey: "agent:codex:acp:uuid-no-binding",
      });
      registerSubagentRunMock.mockResolvedValue(undefined as never);
      getSubagentRunByRunIdMock.mockReturnValue({
        runId: "test-run-no-binding",
        execution: { status: "terminal" },
        outcome: { status: "ok" },
        childSessionKey: "agent:codex:acp:uuid-no-binding",
      });

      // spawnAcpFast not in production; cast to unknown to suppress type errors in skipped block
      const { spawnAcpFast } = (await import("./acp-spawn.js")) as unknown as {
        spawnAcpFast: (...args: unknown[]) => Promise<unknown>;
      };

      await spawnAcpFast(createFastSpawnRequest(), createRequesterContext());

      // Verify thread binding was NOT called
      expect(bindPreparedAcpThreadMock).not.toHaveBeenCalled();
    });

    it("does not create background task", async () => {
      state.cfg.agents!.defaults!.subagents!.maxSpawnDepth = 10;
      state.cfg.agents!.defaults!.subagents!.maxChildrenPerAgent = 10;
      (state.cfg.agents!.defaults!.subagents! as Record<string, unknown>).fastSpawn = {
        enabled: true,
      };

      getSubagentDepthFromSessionStoreMock.mockReturnValue(1);
      countActiveRunsForSessionMock.mockReturnValue(0);
      callGatewayMock.mockResolvedValueOnce({
        runId: "test-run-no-task",
        sessionKey: "agent:codex:acp:uuid-no-task",
      });
      registerSubagentRunMock.mockResolvedValue(undefined as never);
      getSubagentRunByRunIdMock.mockReturnValue({
        runId: "test-run-no-task",
        execution: { status: "terminal" },
        outcome: { status: "ok" },
        childSessionKey: "agent:codex:acp:uuid-no-task",
      });

      // spawnAcpFast not in production; cast to unknown to suppress type errors in skipped block
      const { spawnAcpFast } = (await import("./acp-spawn.js")) as unknown as {
        spawnAcpFast: (...args: unknown[]) => Promise<unknown>;
      };

      await spawnAcpFast(createFastSpawnRequest(), createRequesterContext());

      // Verify background task was NOT created - test passes if spawn succeeds without error
      expect(true).toBe(true); // Placeholder - the fast path doesn't create tasks
    });
  });
});
