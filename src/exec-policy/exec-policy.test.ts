import { describe, it, expect } from "vitest";
import { buildDefaultPolicy } from "./defaults.js";
import {
  tokenizeCommand,
  matchesPrefix,
  evaluatePolicy,
  effectiveDecision,
  parseAlternatives,
} from "./matcher.js";
import { parsePolicyToml, indexRules } from "./parser.js";
import type { PrefixRule } from "./types.js";

// Build a rule helper for test brevity
function rule(decision: "allow" | "prompt" | "forbidden", patternLength: number): PrefixRule {
  return { pattern: Array.from({ length: patternLength }, () => ["x"]), decision };
}

describe("tokenizeCommand", () => {
  it("splits simple commands", () => {
    expect(tokenizeCommand("git status")).toEqual(["git", "status"]);
  });

  it("handles extra whitespace", () => {
    expect(tokenizeCommand("  git   status  ")).toEqual(["git", "status"]);
  });

  it("respects single quotes", () => {
    expect(tokenizeCommand("echo 'hello world'")).toEqual(["echo", "hello world"]);
  });

  it("respects double quotes", () => {
    expect(tokenizeCommand('echo "hello world"')).toEqual(["echo", "hello world"]);
  });

  it("handles backslash escapes", () => {
    expect(tokenizeCommand("echo hello\\ world")).toEqual(["echo", "hello world"]);
  });

  it("handles flags", () => {
    expect(tokenizeCommand("git log --oneline -n 10")).toEqual([
      "git",
      "log",
      "--oneline",
      "-n",
      "10",
    ]);
  });

  it("returns empty for empty string", () => {
    expect(tokenizeCommand("")).toEqual([]);
  });
});

describe("matchesPrefix", () => {
  it("matches exact prefix", () => {
    expect(matchesPrefix(["git", "status"], [["git"], ["status"]])).toBe(true);
  });

  it("matches with alternatives", () => {
    expect(matchesPrefix(["git", "diff"], [["git"], ["status", "diff"]])).toBe(true);
    expect(matchesPrefix(["git", "log"], [["git"], ["status", "diff"]])).toBe(false);
  });

  it("matches first-token alternatives", () => {
    expect(matchesPrefix(["npm", "install"], [["npm", "pnpm", "yarn"], ["install"]])).toBe(true);
    expect(matchesPrefix(["yarn", "install"], [["npm", "pnpm", "yarn"], ["install"]])).toBe(true);
  });

  it("matches prefix of longer command", () => {
    expect(matchesPrefix(["git", "status", "--short"], [["git"], ["status"]])).toBe(true);
  });

  it("rejects shorter command", () => {
    expect(matchesPrefix(["git"], [["git"], ["status"]])).toBe(false);
  });

  it("rejects empty pattern", () => {
    expect(matchesPrefix(["git"], [])).toBe(false);
  });
});

describe("parseAlternatives", () => {
  it("parses string to single alternative", () => {
    expect(parseAlternatives("git")).toEqual([["git"]]);
  });

  it("parses string array to single-element alternatives", () => {
    expect(parseAlternatives(["git", "status"])).toEqual([["git"], ["status"]]);
  });

  it("parses mixed array with alternatives", () => {
    expect(parseAlternatives([["npm", "pnpm"], "install"])).toEqual([["npm", "pnpm"], ["install"]]);
  });
});

describe("effectiveDecision", () => {
  it("forbidden wins at same specificity", () => {
    expect(effectiveDecision([rule("allow", 2), rule("forbidden", 2), rule("prompt", 2)])).toBe(
      "forbidden",
    );
  });

  it("prompt beats allow at same specificity", () => {
    expect(effectiveDecision([rule("allow", 2), rule("prompt", 2)])).toBe("prompt");
  });

  it("all allow at same specificity", () => {
    expect(effectiveDecision([rule("allow", 2), rule("allow", 2)])).toBe("allow");
  });

  it("longer (more specific) match overrides shorter", () => {
    // docker ps (length 2, allow) should beat docker (length 1, prompt)
    expect(
      effectiveDecision([
        { pattern: [["docker"]], decision: "prompt" as const },
        { pattern: [["docker"], ["ps"]], decision: "allow" as const },
      ]),
    ).toBe("allow");
  });
});

describe("evaluatePolicy", () => {
  const policy = buildDefaultPolicy();

  it("allows safe git commands", () => {
    const r = evaluatePolicy("git status", policy);
    expect(r.decision).toBe("allow");
    expect(r.matched).toBe(true);
  });

  it("allows git diff", () => {
    const r = evaluatePolicy("git diff", policy);
    expect(r.decision).toBe("allow");
  });

  it("allows git log", () => {
    const r = evaluatePolicy("git log --oneline", policy);
    expect(r.decision).toBe("allow");
  });

  it("prompts for git push", () => {
    const r = evaluatePolicy("git push origin main", policy);
    expect(r.decision).toBe("prompt");
  });

  it("forbids rm", () => {
    const r = evaluatePolicy("rm -rf /tmp/test", policy);
    expect(r.decision).toBe("forbidden");
  });

  it("forbids sudo", () => {
    const r = evaluatePolicy("sudo apt install foo", policy);
    expect(r.decision).toBe("forbidden");
  });

  it("forbids inline eval", () => {
    expect(evaluatePolicy("bash -c 'echo hello'", policy).decision).toBe("forbidden");
    expect(evaluatePolicy("python -c 'print(1)'", policy).decision).toBe("forbidden");
    expect(evaluatePolicy("node -e 'console.log(1)'", policy).decision).toBe("forbidden");
  });

  it("allows safe read-only tools", () => {
    expect(evaluatePolicy("ls -la", policy).decision).toBe("allow");
    expect(evaluatePolicy("cat file.txt", policy).decision).toBe("allow");
    expect(evaluatePolicy("grep pattern file", policy).decision).toBe("allow");
    expect(evaluatePolicy("find . -name '*.ts'", policy).decision).toBe("allow");
    expect(evaluatePolicy("rg 'TODO' src/", policy).decision).toBe("allow");
  });

  it("allows package installs", () => {
    expect(evaluatePolicy("npm install", policy).decision).toBe("allow");
    expect(evaluatePolicy("pnpm install", policy).decision).toBe("allow");
    expect(evaluatePolicy("yarn install", policy).decision).toBe("allow");
  });

  it("prompts for npm run", () => {
    expect(evaluatePolicy("npm run build", policy).decision).toBe("prompt");
  });

  it("allows trash", () => {
    expect(evaluatePolicy("trash file.txt", policy).decision).toBe("allow");
  });

  it("allows docker ps", () => {
    expect(evaluatePolicy("docker ps", policy).decision).toBe("allow");
  });

  it("prompts for docker run", () => {
    expect(evaluatePolicy("docker run -it ubuntu", policy).decision).toBe("prompt");
  });

  it("allows development tools", () => {
    expect(evaluatePolicy("tsc --noEmit", policy).decision).toBe("allow");
    expect(evaluatePolicy("eslint src/", policy).decision).toBe("allow");
    expect(evaluatePolicy("jest", policy).decision).toBe("allow");
  });

  it("allows cargo test", () => {
    expect(evaluatePolicy("cargo test", policy).decision).toBe("allow");
  });

  it("prompts for unknown commands", () => {
    const r = evaluatePolicy("some-random-binary --flag", policy);
    expect(r.decision).toBe("prompt");
    expect(r.matched).toBe(false);
  });

  it("returns prompt for empty string", () => {
    const r = evaluatePolicy("", policy);
    expect(r.decision).toBe("prompt");
    expect(r.matched).toBe(false);
  });
});

describe("parsePolicyToml", () => {
  it("parses a basic rule", () => {
    const toml = `
[[rule]]
pattern = ["git", "status"]
decision = "allow"
justification = "Safe"
`;
    const result = parsePolicyToml(toml);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.decision).toBe("allow");
    expect(result.rules[0]!.pattern).toEqual([["git"], ["status"]]);
  });

  it("parses rules with alternatives", () => {
    const toml = `
[[rule]]
pattern = [["npm", "pnpm"], "install"]
decision = "allow"
`;
    const result = parsePolicyToml(toml);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]!.pattern).toEqual([["npm", "pnpm"], ["install"]]);
  });

  it("parses banned prefixes", () => {
    const toml = `
[[banned]]
pattern = ["sudo", "rm"]
justification = "Dangerous"
`;
    const result = parsePolicyToml(toml);
    expect(result.banned).toHaveLength(1);
    expect(result.banned[0]!.pattern).toEqual(["sudo", "rm"]);
  });

  it("handles empty TOML", () => {
    const result = parsePolicyToml("");
    expect(result.rules).toHaveLength(0);
    expect(result.banned).toHaveLength(0);
  });

  it("defaults unknown decision to prompt", () => {
    const toml = `
[[rule]]
pattern = ["foo"]
decision = "unknown_value"
`;
    const result = parsePolicyToml(toml);
    expect(result.rules[0]?.decision).toBe("prompt");
  });
});

describe("indexRules", () => {
  it("indexes by first token", () => {
    const rules: PrefixRule[] = [
      { pattern: [["git"], ["status"]], decision: "allow" },
      { pattern: [["git"], ["push"]], decision: "prompt" },
      { pattern: [["npm"], ["install"]], decision: "allow" },
    ];
    const index = indexRules(rules);
    expect(index.get("git")).toHaveLength(2);
    expect(index.get("npm")).toHaveLength(1);
    expect(index.has("unknown")).toBe(false);
  });

  it("indexes alternatives", () => {
    const rules: PrefixRule[] = [
      { pattern: [["npm", "pnpm", "yarn"], ["install"]], decision: "allow" },
    ];
    const index = indexRules(rules);
    expect(index.get("npm")).toHaveLength(1);
    expect(index.get("pnpm")).toHaveLength(1);
    expect(index.get("yarn")).toHaveLength(1);
  });
});
