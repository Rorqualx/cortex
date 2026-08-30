/**
 * QW-B (2026-08-30): report-only lint of workspace imperative rules against the
 * effective exec policy.
 *
 * Workspace AGENTS.md/USER.md routinely carry imperative rules ("never run X",
 * "do not Y", "always Z"). Only a subset of those rules has an enforceable
 * counterpart in the exec-policy surface (tools.exec + persisted exec
 * approvals); the rest are honored by model good will alone. This check makes
 * that split visible: it extracts imperative lines, tags the ones that mention
 * shell commands, and classifies each against the effective security mode and
 * the exec allowlist.
 *
 * The prose→policy mapping is deliberately heuristic (word/first-token
 * matching, no NLP). Because of that this check is strictly report-only — it
 * never registers a repair. False positives are surfaced as low-severity
 * findings, never as failures.
 */
import * as fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, tryResolveSoleAgentId } from "../agents/agent-scope.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_USER_FILENAME } from "../agents/workspace.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { matchesExecAllowlistPattern } from "../infra/exec-allowlist-pattern.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals-core.js";
import { resolveExecPolicyScopeSnapshot } from "../infra/exec-approvals-effective.js";
import {
  loadExecApprovalsReadOnly,
  resolveExecApprovalsFromFile,
} from "../infra/exec-approvals.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import type { HealthFinding } from "./health-checks.js";

export const AGENTS_RULES_EXEC_POLICY_CHECK_ID = "core/doctor/agents-rules-exec-policy";

/** Hard cap so a pathological workspace file cannot flood doctor output. */
const MAX_RULES_PER_FILE = 200;

/** Imperative markers scanned for, longest-first so "must never" wins over "never". */
const IMPERATIVE_MARKERS = [
  "must never",
  "must not",
  "do not ever",
  "do not",
  "don't",
  "don’t",
  "never",
  "always",
] as const;

const IMPERATIVE_MARKER_PATTERNS: ReadonlyArray<{ marker: string; pattern: RegExp }> =
  IMPERATIVE_MARKERS.map((marker) => ({
    marker,
    pattern: new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}\\b`, "i"),
  }));

/**
 * Common shell commands used to decide whether an imperative rule is about
 * host execution at all. Lowercase; matched on word boundaries.
 */
const SHELL_COMMAND_VOCABULARY: ReadonlySet<string> = new Set([
  "apt",
  "brew",
  "bun",
  "cargo",
  "chmod",
  "chown",
  "cp",
  "crontab",
  "curl",
  "dd",
  "defaults",
  "docker",
  "ffmpeg",
  "git",
  "kill",
  "kubectl",
  "launchctl",
  "make",
  "mkfs",
  "mv",
  "mysql",
  "node",
  "npm",
  "openclaw",
  "osascript",
  "pip",
  "pip3",
  "pm2",
  "pnpm",
  "psql",
  "pkill",
  "python",
  "python3",
  "reboot",
  "redis-cli",
  "rm",
  "rmdir",
  "rsync",
  "ruby",
  "rustup",
  "scp",
  "shutdown",
  "sqlite3",
  "ssh",
  "sudo",
  "systemctl",
  "tar",
  "trash",
  "unzip",
  "wget",
  "yarn",
  "yt-dlp",
  "nginx",
  "systemd",
]);

export type ImperativeRule = {
  /** Workspace-relative file the rule came from (AGENTS.md / USER.md). */
  readonly file: string;
  /** 1-based line number within the file. */
  readonly line: number;
  /** Matched imperative marker, e.g. "never". */
  readonly marker: string;
  /** Trimmed source line. */
  readonly text: string;
  /** Command tokens the rule references (lowercase, deduped, sorted). */
  readonly commands: readonly string[];
};

export type ExecPolicySurfaceSummary = {
  readonly effectiveSecurity: "allowlist" | "full" | "deny";
  readonly allowlistPatterns: readonly string[];
  /** Human-readable source of the effective security value. */
  readonly source: string;
};

export type RuleEnforcement =
  | { readonly kind: "non-exec" }
  | { readonly kind: "enforced"; readonly reason: string }
  | { readonly kind: "advisory"; readonly reason: string }
  | {
      readonly kind: "drift";
      readonly pattern: string;
      readonly reason: string;
    };

function findImperativeMarker(line: string): string | null {
  for (const { marker, pattern } of IMPERATIVE_MARKER_PATTERNS) {
    if (pattern.test(line)) {
      return marker;
    }
  }
  return null;
}

function extractBacktickedCommandSpans(line: string): string[] {
  const spans: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf("`", cursor);
    if (start === -1) {
      break;
    }
    const end = line.indexOf("`", start + 1);
    if (end === -1) {
      break;
    }
    const span = line.slice(start + 1, end).trim();
    if (span) {
      spans.push(span);
    }
    cursor = end + 1;
  }
  return spans;
}

function isShellCommandWord(word: string): boolean {
  return SHELL_COMMAND_VOCABULARY.has(word);
}

/** Extract the command tokens an imperative rule refers to. */
export function extractRuleCommands(line: string): string[] {
  const found = new Set<string>();
  // Backticked spans are the strongest signal: `pnpm build` → ["pnpm build"].
  // Only spans whose first word is a known shell command count — prose spans
  // like `the workspace` are not commands.
  for (const span of extractBacktickedCommandSpans(line)) {
    const firstWord = span.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (firstWord && isShellCommandWord(firstWord)) {
      found.add(span.toLowerCase());
    }
  }
  // Bare vocabulary words catch unquoted mentions ("trash > rm").
  for (const rawWord of line.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const word = rawWord.replace(/[.,;:!?'")+]+$/g, "");
    if (isShellCommandWord(word)) {
      found.add(word);
    }
  }
  return [...found].sort();
}

/**
 * Extract imperative rules from workspace markdown. Fenced code blocks are
 * skipped (they are examples, not rules). Pure and linear in input size.
 */
export function extractImperativeRules(markdown: string, file: string): readonly ImperativeRule[] {
  const rules: ImperativeRule[] = [];
  let inFence = false;
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed) {
      continue;
    }
    const marker = findImperativeMarker(trimmed);
    if (!marker) {
      continue;
    }
    const commands = extractRuleCommands(trimmed);
    rules.push({ file, line: index + 1, marker, text: trimmed, commands });
    if (rules.length >= MAX_RULES_PER_FILE) {
      break;
    }
  }
  return rules;
}

/**
 * Heuristic: does the exec allowlist pattern cover the command the rule
 * mentions? Multi-word commands use the real glob matcher; single-word
 * commands also match patterns whose first word is that command.
 */
export function commandMatchesAllowlistPattern(command: string, pattern: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  const commandLower = command.toLowerCase();
  if (matchesExecAllowlistPattern(trimmed, commandLower)) {
    return true;
  }
  const firstWord = trimmed.toLowerCase().split(/\s+/)[0] ?? "";
  return firstWord === commandLower;
}

/** Classify one imperative rule against the effective exec-policy surface. */
export function classifyRuleAgainstExecPolicy(
  rule: ImperativeRule,
  surface: ExecPolicySurfaceSummary,
): RuleEnforcement {
  if (rule.commands.length === 0) {
    return { kind: "non-exec" };
  }
  if (surface.effectiveSecurity === "deny") {
    return {
      kind: "enforced",
      reason: "effective exec security is deny — host execution requires approval",
    };
  }
  if (surface.effectiveSecurity === "full") {
    return {
      kind: "advisory",
      reason: "effective exec security is full — nothing blocks the command",
    };
  }
  for (const command of rule.commands) {
    for (const pattern of surface.allowlistPatterns) {
      if (commandMatchesAllowlistPattern(command, pattern)) {
        return {
          kind: "drift",
          pattern,
          reason: `"${command}" is permitted by allowlist entry "${pattern}" — the prose rule has no enforced counterpart`,
        };
      }
    }
  }
  return {
    kind: "enforced",
    reason: `"${rule.commands.join('", "')}" not on the exec allowlist — running it requires approval`,
  };
}

/** Summarize the effective exec policy for the default agent scope. */
export function summarizeExecPolicySurface(params: {
  cfg: OpenClawConfig;
  approvals: ExecApprovalsFile;
}): ExecPolicySurfaceSummary | null {
  const snapshot = resolveExecPolicyScopeSnapshot({
    approvals: params.approvals,
    scopeExecConfig: params.cfg.tools?.exec,
    configPath: "tools.exec",
    scopeLabel: "tools.exec",
  });
  // Resolve the DEFAULT_AGENT_ID scope: normalizeExecApprovalsInternal migrates
  // the legacy "default" key onto DEFAULT_AGENT_ID ("main"), so resolving
  // without an agent id yields an empty allowlist.
  const resolved = resolveExecApprovalsFromFile({
    file: params.approvals,
    agentId: DEFAULT_AGENT_ID,
  });
  return {
    effectiveSecurity: snapshot.security.effective,
    allowlistPatterns: resolved.allowlist
      .map((entry) => entry.pattern)
      .filter((pattern): pattern is string => typeof pattern === "string" && pattern.length > 0),
    source: snapshot.security.note,
  };
}

export type AgentsRulesExecPolicyLintDeps = {
  /** Reads a workspace file; returns null when missing. Injectable for tests. */
  readWorkspaceFile?: (filePath: string) => string | null;
  /** Loads persisted exec approvals read-only. Injectable for tests. */
  loadApprovals?: () => ExecApprovalsFile;
};

function readWorkspaceFileDefault(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Collect doctor findings for the workspace rules ↔ exec-policy lint.
 * Report-only: returns info/warning findings, never errors, never repairs.
 */
export async function collectAgentsRulesExecPolicyFindings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  deps?: AgentsRulesExecPolicyLintDeps;
}): Promise<readonly HealthFinding[]> {
  const deps = params.deps ?? {};
  const readFile = deps.readWorkspaceFile ?? readWorkspaceFileDefault;
  const loadApprovals = deps.loadApprovals ?? loadExecApprovalsReadOnly;

  const agentId = tryResolveSoleAgentId(params.cfg) ?? DEFAULT_AGENT_ID;
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId, params.env ?? process.env);

  const files: Array<{ name: string; content: string }> = [];
  for (const name of [DEFAULT_AGENTS_FILENAME, DEFAULT_USER_FILENAME]) {
    const content = readFile(path.join(workspaceDir, name));
    if (content !== null && content.trim()) {
      files.push({ name, content });
    }
  }
  if (files.length === 0) {
    return [];
  }

  let approvals: ExecApprovalsFile;
  try {
    approvals = loadApprovals();
  } catch {
    return [
      {
        checkId: AGENTS_RULES_EXEC_POLICY_CHECK_ID,
        severity: "info",
        message:
          "AGENTS.md exec-policy lint skipped: exec approvals state could not be read read-only.",
      },
    ];
  }
  const surface = summarizeExecPolicySurface({ cfg: params.cfg, approvals });
  if (!surface) {
    return [];
  }

  const findings: HealthFinding[] = [];
  let execRules = 0;
  let enforced = 0;
  let advisory = 0;
  const drift: Array<{ rule: ImperativeRule; pattern: string; reason: string }> = [];

  for (const file of files) {
    for (const rule of extractImperativeRules(file.content, file.name)) {
      const verdict = classifyRuleAgainstExecPolicy(rule, surface);
      if (verdict.kind === "non-exec") {
        continue;
      }
      execRules++;
      if (verdict.kind === "enforced") {
        enforced++;
      } else if (verdict.kind === "advisory") {
        advisory++;
      } else {
        drift.push({ rule, pattern: verdict.pattern, reason: verdict.reason });
      }
    }
  }

  if (execRules === 0) {
    return [];
  }

  findings.push({
    checkId: AGENTS_RULES_EXEC_POLICY_CHECK_ID,
    severity: "info",
    message: `Workspace exec-policy lint: ${execRules} imperative rule${
      execRules === 1 ? "" : "s"
    } mention shell commands; effective exec security is ${surface.effectiveSecurity} (${surface.source}) → ${enforced} enforced, ${advisory} advisory-only${
      drift.length > 0 ? `, ${drift.length} allowlist drift` : ""
    }. Heuristic, report-only.`,
  });

  for (const hit of drift) {
    findings.push({
      checkId: AGENTS_RULES_EXEC_POLICY_CHECK_ID,
      severity: "warning",
      message: `Advisory rule with no enforceable counterpart: ${hit.rule.file}:${
        hit.rule.line
      } "${truncateRuleText(hit.rule.text)}" — ${hit.reason}.`,
      path: hit.rule.file,
      line: hit.rule.line,
      fixHint:
        "Tighten the exec allowlist entry or reword the workspace rule; this lint never auto-fixes.",
    });
  }
  return findings;
}

function truncateRuleText(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
