/**
 * Regression coverage for core tool catalog profile defaults.
 * Verifies built-in profile allowlists include expected core tool groups.
 */
import { describe, expect, it } from "vitest";
import { resolveCoreToolProfilePolicy } from "./tool-catalog.js";

function requireCoreToolProfilePolicy(profile: Parameters<typeof resolveCoreToolProfilePolicy>[0]) {
  const policy = resolveCoreToolProfilePolicy(profile);
  if (!policy) {
    throw new Error(`expected ${profile} tool profile policy`);
  }
  return policy;
}

function requirePolicyAllow(profile: Parameters<typeof resolveCoreToolProfilePolicy>[0]) {
  const allow = requireCoreToolProfilePolicy(profile).allow;
  if (!allow) {
    throw new Error(`expected ${profile} tool profile allow list`);
  }
  return allow;
}

describe("tool-catalog", () => {
  it("includes code_execution, web_search, x_search, web_fetch, and progress_card in the coding profile policy", () => {
    const policy = requireCoreToolProfilePolicy("coding");
    expect(policy.allow).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
      "code_execution",
      "secrets",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
      "memory_reports",
      "sessions",
      "sessions_list",
      "sessions_history",
      "sessions_search",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "sessions_send",
      "sessions_spawn",
      "agents_wait",
      "sessions_yield",
      "subagents",
      "session_status",
      "spawn_task",
      "dismiss_task",
      "session_awareness",
      "screen",
      "dashboard",
      "terminal",
      "automations",
      "workboard_list",
      "workboard_read",
      "workboard_specify",
      "workboard_decompose",
      "workboard_heartbeat",
      "workboard_complete",
      "workboard_block",
      "workboard_research_sync",
      "workboard_research_stage",
      "get_goal",
      "create_goal",
      "update_goal",
      "progress_card",
      "ask_user",
      "skill_forge",
      "skill_workshop",
      "image",
      "image_generate",
      "music_generate",
      "video_generate",
      "delegate_code",
      "delegate_review",
      "delegate_research",
      "delegate_generic",
      "delegate_plan",
      "delegate_vision",
      "delegate_explore",
      "delegate_swarm",
      "delegate_academic",
      "bundle-mcp",
    ]);
  });

  it("includes bundle MCP tools in coding and messaging profile policies", () => {
    expect(requirePolicyAllow("coding").at(-1)).toBe("bundle-mcp");
    expect(requirePolicyAllow("messaging")).toEqual([
      "secrets",
      "sessions",
      "sessions_list",
      "sessions_history",
      "sessions_search",
      "conversations_list",
      "conversations_send",
      "conversations_turn",
      "sessions_send",
      "session_status",
      "message",
      "workboard_list",
      "workboard_read",
      "workboard_specify",
      "workboard_decompose",
      "workboard_heartbeat",
      "workboard_complete",
      "workboard_block",
      "ask_user",
      "bundle-mcp",
    ]);
    expect(requirePolicyAllow("minimal")).toEqual(["session_status"]);
  });

  it("full profile uses wildcard to grant all tools (#76507)", () => {
    const policy = requireCoreToolProfilePolicy("full");
    expect(policy.allow).toEqual(["*"]);
  });
});
