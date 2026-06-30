import { describe, expect, it } from "vitest";
import type { ClaudeConnectFactoryContext } from "./tools.js";
import { resolveCwd, resolveIdleTimeout } from "./tools.js";

function ctx(config: Record<string, unknown>, workspaceDir?: string): ClaudeConnectFactoryContext {
  return {
    api: {} as ClaudeConnectFactoryContext["api"],
    config,
    toolContext: { workspaceDir } as ClaudeConnectFactoryContext["toolContext"],
  };
}

describe("resolveCwd", () => {
  it("prefers an explicit cwd, then config.defaultCwd", () => {
    expect(resolveCwd(ctx({ defaultCwd: "/cfg" }), "/explicit", "task")).toBe("/explicit");
    expect(resolveCwd(ctx({ defaultCwd: "/cfg" }), undefined, "task")).toBe("/cfg");
  });

  it("refuses to default task mode to the gateway working directory", () => {
    expect(() => resolveCwd(ctx({}, "/workspace"), undefined, "task")).toThrow(
      /task mode requires an explicit cwd/,
    );
  });

  it("lets research mode fall back to the workspace", () => {
    expect(resolveCwd(ctx({}, "/workspace"), undefined, "research")).toBe("/workspace");
  });
});

describe("resolveIdleTimeout", () => {
  it("uses the default when unset or negative", () => {
    expect(resolveIdleTimeout({})).toBe(120_000);
    expect(resolveIdleTimeout({ idleTurnTimeoutMs: -5 })).toBe(120_000);
  });

  it("honors a positive override", () => {
    expect(resolveIdleTimeout({ idleTurnTimeoutMs: 5_000 })).toBe(5_000);
  });

  it("treats 0 as disabled", () => {
    expect(resolveIdleTimeout({ idleTurnTimeoutMs: 0 })).toBe(0);
  });
});
