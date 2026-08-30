import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import {
  AGENTS_RULES_EXEC_POLICY_CHECK_ID,
  classifyRuleAgainstExecPolicy,
  collectAgentsRulesExecPolicyFindings,
  commandMatchesAllowlistPattern,
  extractImperativeRules,
  extractRuleCommands,
  type ExecPolicySurfaceSummary,
  type ImperativeRule,
} from "./doctor-agents-rules-exec-policy.js";

function rule(overrides: Partial<ImperativeRule> = {}): ImperativeRule {
  return {
    file: "AGENTS.md",
    line: 1,
    marker: "never",
    text: "Never run `pnpm build`.",
    commands: ["pnpm build"],
    ...overrides,
  };
}

describe("extractImperativeRules", () => {
  it("finds imperative lines with markers and line numbers", () => {
    const rules = extractImperativeRules(
      ["# Notes", "", "Never run destructive commands.", "Always prefer `trash` over rm."].join(
        "\n",
      ),
      "AGENTS.md",
    );
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ file: "AGENTS.md", line: 3, marker: "never" });
    expect(rules[1]).toMatchObject({ line: 4, marker: "always" });
    expect(rules[1].commands).toEqual(["rm", "trash"]);
  });

  it("skips fenced code blocks", () => {
    const markdown = ["Never do X outside.", "```", "never run this example", "```"].join("\n");
    const rules = extractImperativeRules(markdown, "AGENTS.md");
    expect(rules).toHaveLength(1);
    expect(rules[0].line).toBe(1);
  });

  it("captures multi-word backticked command spans", () => {
    const rules = extractImperativeRules("Do not run `pnpm build` here.", "USER.md");
    expect(rules[0].commands).toContain("pnpm build");
  });

  it("does not match markers inside words", () => {
    const rules = extractImperativeRules("However neversomething is not a rule.", "AGENTS.md");
    expect(rules).toHaveLength(0);
  });
});

describe("extractRuleCommands", () => {
  it("returns sorted unique lowercase tokens", () => {
    expect(extractRuleCommands("never run git or GIT push")).toEqual(["git"]);
  });

  it("ignores non-command backticked spans", () => {
    expect(extractRuleCommands("always respect `the workspace` rules")).toEqual([]);
  });
});

describe("commandMatchesAllowlistPattern", () => {
  it("glob-matches multi-word commands", () => {
    expect(commandMatchesAllowlistPattern("pnpm build", "pnpm *")).toBe(true);
    expect(commandMatchesAllowlistPattern("pnpm build", "pnpm test:*")).toBe(false);
  });

  it("first-word matches single-word commands", () => {
    expect(commandMatchesAllowlistPattern("rm", "rm -rf *")).toBe(true);
    expect(commandMatchesAllowlistPattern("rm", "git *")).toBe(false);
  });
});

describe("classifyRuleAgainstExecPolicy", () => {
  const allowlistSurface: ExecPolicySurfaceSummary = {
    effectiveSecurity: "allowlist",
    allowlistPatterns: ["pnpm *"],
    source: "tools.exec.security",
  };

  it("marks rules without commands as non-exec", () => {
    expect(classifyRuleAgainstExecPolicy(rule({ commands: [] }), allowlistSurface)).toEqual({
      kind: "non-exec",
    });
  });

  it("deny security enforces everything", () => {
    const verdict = classifyRuleAgainstExecPolicy(rule(), {
      ...allowlistSurface,
      effectiveSecurity: "deny",
    });
    expect(verdict.kind).toBe("enforced");
  });

  it("full security makes exec rules advisory", () => {
    const verdict = classifyRuleAgainstExecPolicy(rule(), {
      ...allowlistSurface,
      effectiveSecurity: "full",
      allowlistPatterns: [],
    });
    expect(verdict.kind).toBe("advisory");
  });

  it("allowlisted command is drift", () => {
    const verdict = classifyRuleAgainstExecPolicy(rule(), allowlistSurface);
    expect(verdict.kind).toBe("drift");
  });

  it("non-allowlisted command is enforced under allowlist mode", () => {
    const verdict = classifyRuleAgainstExecPolicy(
      rule({ commands: ["openclaw"] }),
      allowlistSurface,
    );
    expect(verdict.kind).toBe("enforced");
  });
});

describe("collectAgentsRulesExecPolicyFindings", () => {
  const emptyCfg = {} as OpenClawConfig;

  function approvalsFile(allowlist: string[]): ExecApprovalsFile {
    // Key under DEFAULT_AGENT_ID ("main") — normalization migrates the legacy
    // "default" key onto "main", so that is the live shape.
    return {
      version: 1,
      agents: {
        main: {
          allowlist: allowlist.map((pattern) => ({ pattern })),
        },
      },
    };
  }

  it("returns no findings when no workspace files exist", async () => {
    const findings = await collectAgentsRulesExecPolicyFindings({
      cfg: emptyCfg,
      deps: {
        readWorkspaceFile: () => null,
        loadApprovals: () => approvalsFile([]),
      },
    });
    expect(findings).toEqual([]);
  });

  it("skips with an info finding when approvals cannot be read", async () => {
    const findings = await collectAgentsRulesExecPolicyFindings({
      cfg: emptyCfg,
      deps: {
        readWorkspaceFile: (p) => (p.endsWith("AGENTS.md") ? "Never run `rm`." : null),
        loadApprovals: () => {
          throw new Error("store unavailable");
        },
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: AGENTS_RULES_EXEC_POLICY_CHECK_ID,
      severity: "info",
    });
    expect(findings[0].message).toContain("skipped");
  });

  it("reports an info summary under full security (default)", async () => {
    const findings = await collectAgentsRulesExecPolicyFindings({
      cfg: emptyCfg,
      deps: {
        readWorkspaceFile: (p) =>
          p.endsWith("AGENTS.md") ? "Never run `pnpm build`.\nAlways ask first." : null,
        loadApprovals: () => approvalsFile([]),
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].message).toContain("advisory-only");
    expect(findings[0].message).toContain("full");
  });

  it("reports warning drift findings with file and line", async () => {
    const findings = await collectAgentsRulesExecPolicyFindings({
      cfg: { tools: { exec: { security: "allowlist" } } } as unknown as OpenClawConfig,
      deps: {
        readWorkspaceFile: (p) =>
          p.endsWith("AGENTS.md") ? "# Rules\n\nNever run `pnpm build` in this workspace." : null,
        loadApprovals: () => approvalsFile(["pnpm *"]),
      },
    });
    const drift = findings.filter((f) => f.severity === "warning");
    expect(drift).toHaveLength(1);
    expect(drift[0].message).toContain("pnpm build");
    expect(drift[0].message).toContain("pnpm *");
    expect(drift[0].path).toBe("AGENTS.md");
    expect(drift[0].line).toBe(3);
    expect(drift[0].fixHint).toContain("never auto-fixes");
    const summary = findings.find((f) => f.severity === "info");
    expect(summary?.message).toContain("allowlist drift");
  });
});
