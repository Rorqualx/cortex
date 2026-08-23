import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSkillForgePromotedSkillDir, resolveSkillForgeRetiredSkillDir } from "./paths.js";

export const LLM_REPLAY_TODO =
  "Phase 4 LLM-replay gate (leave-one-out re-run with the candidate skill loaded) requires an LLM provider; defer until provider chosen.";

/*
 * CONTROLLED-BUDGET EVALUATION PROTOCOL (openclaw-analysis-2026-07-19, Finding #6)
 *
 * When implementing the LLM-replay lane, structure it as a controlled-budget
 * evaluation to prevent promoting skills that are just "extra compute in disguise":
 *
 * 1. Run N parallel samples WITHOUT the candidate skill (baseline condition).
 * 2. Run N parallel samples WITH the candidate skill (treatment condition).
 * 3. Both conditions use the SAME per-sample token budget.
 * 4. Promotion gate: treatment success rate must exceed baseline by > Δ%
 *    (configurable via ParallelSamplingBaseline.promotionThresholdDelta,
 *    suggest 10% default).
 * 5. Skills that don't beat baseline are rejected — they're not adding
 *    capability, just burning more tokens.
 *
 * The ParallelSamplingBaseline type in pipeline.ts defines the result shape.
 */

const MIN_BODY_CHARS = 200;
const CLEAN_SESSION_MIN_BODY_CHARS = 100;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export type QualityFacets = {
  /** Session-success-score mapped to 0-1. Higher = more useful in practice. */
  utility: number;
  /** Replay-gate pass rate across N samples (0-1). Measures cross-session reliability. */
  robustness: number;
  /** Safety score from security scan (0-1). 1.0 = no findings, scores down from criticals. */
  safety: number;
};

export type GateVerdict = {
  status: "pass" | "fail";
  reasons: string[];
  /**
   * Tri-facet quality scores computed from available signals during gating.
   * utility ← session-success-score, robustness ← replay-gate pass rate,
   * safety ← security scan findings. Present even when status is "pass"
   * so callers can still read the scores.
   */
  qualityFacets?: QualityFacets;
};

export type SecurityFinding = {
  id: string;
  severity: "critical" | "warning";
  message: string;
  file: string;
  line?: number;
};

export type SecurityScanResult = {
  status: "pass" | "fail";
  findings: SecurityFinding[];
};

const SECURITY_PATTERNS: Array<{
  id: string;
  severity: "critical" | "warning";
  regex: RegExp;
  message: string;
}> = [
  {
    id: "env-harvest",
    severity: "critical",
    regex: /\b(?:process\.env\b|os\.environ\b|process\.env\.[A-Z_]+)\b/gu,
    message: "Environment variable harvesting detected",
  },
  {
    id: "disk-wipe",
    severity: "critical",
    regex: /(?:rm\s+-rf\s+\/|dd\s+if=|mkfs\.|>\s*\/dev\/(?:sd|hd|nvme|disk)|shred\s+-|wiperam)/giu,
    message: "Disk-destructive command detected",
  },
  {
    id: "prompt-injection",
    severity: "critical",
    regex:
      /\b(?:ignore previous|ignore the above|ignore all previous|system prompt|you are now|override previous|disregard earlier)\b/giu,
    message: "Prompt override instruction detected",
  },
  {
    id: "unpinned-install",
    severity: "warning",
    regex: /\bcurl\s+(?:[^|]|\S)*\|\s*(?:bash|sh|zsh)\b/giu,
    message: "Unpinned curl-pipe installation detected",
  },
  {
    id: "hardcoded-key",
    severity: "critical",
    regex:
      /\b(?:sk-[a-zA-Z0-9]{24,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36,}|ssh-rsa\s+AAAA[0-9A-Z+/=]{32,}|eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*|api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9]{16,})\b/gu,
    message: "Hardcoded credential or API key detected",
  },
];

function scanContent(content: string, fileName: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split("\n");
  for (const pattern of SECURITY_PATTERNS) {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line === undefined) {
        continue;
      }
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(line)) {
        findings.push({
          id: pattern.id,
          severity: pattern.severity,
          message: pattern.message,
          file: fileName,
          line: lineIndex + 1,
        });
      }
    }
  }
  return findings;
}

export async function staticSecurityScan(skillDir: string): Promise<SecurityScanResult> {
  const findings: SecurityFinding[] = [];

  // Scan SKILL.md
  const skillMdPath = path.join(skillDir, "SKILL.md");
  let skillMdContent: string;
  try {
    skillMdContent = await fsp.readFile(skillMdPath, "utf8");
  } catch {
    return {
      status: "fail",
      findings: [
        {
          id: "missing-skill",
          severity: "critical",
          message: "SKILL.md missing",
          file: "SKILL.md",
        },
      ],
    };
  }
  findings.push(...scanContent(skillMdContent, "SKILL.md"));

  // Scan any script files in the directory
  const entries = await fsp.readdir(skillDir).catch(() => [] as string[]);
  const scriptExts = new Set([".js", ".ts", ".mjs", ".cjs", ".sh", ".py", ".rb"]);
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (scriptExts.has(ext)) {
      const filePath = path.join(skillDir, entry);
      try {
        const content = await fsp.readFile(filePath, "utf8");
        findings.push(...scanContent(content, entry));
      } catch {
        // Skip unreadable files
      }
    }
  }

  const criticalCount = findings.filter((f) => f.severity === "critical").length;
  return {
    status: criticalCount > 0 ? "fail" : "pass",
    findings,
  };
}

function frontmatterFields(frontmatter: string): { name?: string; description?: string } {
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/mu);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/mu);
  const unquote = (raw: string): string => {
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
    }
    return trimmed;
  };
  const name = nameMatch?.[1];
  const description = descriptionMatch?.[1];
  return {
    name: name !== undefined ? unquote(name) : undefined,
    description: description !== undefined ? unquote(description) : undefined,
  };
}

export async function validateSkillDir(
  skillDir: string,
  successScore?: number,
): Promise<GateVerdict> {
  const skillMdPath = path.join(skillDir, "SKILL.md");
  let content: string;
  try {
    content = await fsp.readFile(skillMdPath, "utf8");
  } catch {
    return { status: "fail", reasons: ["SKILL.md missing"] };
  }
  const frontmatterMatch = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/u);
  if (!frontmatterMatch) {
    return { status: "fail", reasons: ["Frontmatter missing or malformed"] };
  }
  const [, frontmatter, body] = frontmatterMatch;
  if (frontmatter === undefined || body === undefined) {
    return { status: "fail", reasons: ["Frontmatter missing or malformed"] };
  }
  const { name, description } = frontmatterFields(frontmatter);
  const reasons: string[] = [];
  if (!name || name.length === 0) {
    reasons.push("name field missing or empty");
  } else if (!NAME_PATTERN.test(name)) {
    reasons.push(`name '${name}' does not match lowercase-hyphen schema`);
  }
  if (!description || description.length === 0) {
    reasons.push("description field missing or empty");
  }
  const bodyTrim = body.trim();
  // Skills distilled from fully clean sessions (successScore 1.0) earn a
  // relaxed body minimum; unknown or tainted sessions keep the strict bar.
  const minBody = (successScore ?? 0) >= 1 ? CLEAN_SESSION_MIN_BODY_CHARS : MIN_BODY_CHARS;
  if (bodyTrim.length < minBody) {
    reasons.push(`body is too short (${bodyTrim.length} chars; minimum ${minBody})`);
  }
  try {
    const scriptsStat = await fsp.stat(path.join(skillDir, "scripts"));
    if (scriptsStat.isDirectory()) {
      reasons.push(
        "scripts/ directory present (auto-promoted skills must be prose-only per AGENTS.md)",
      );
    }
  } catch {
    // No scripts/ — good.
  }
  return reasons.length === 0 ? { status: "pass", reasons: [] } : { status: "fail", reasons };
}

export async function nameCollisionCheck(params: {
  name: string;
  env?: NodeJS.ProcessEnv;
}): Promise<GateVerdict> {
  const env = params.env ?? process.env;
  const reasons: string[] = [];
  const targets: Array<[string, string]> = [
    ["promoted", resolveSkillForgePromotedSkillDir({ name: params.name, env })],
    ["retired", resolveSkillForgeRetiredSkillDir({ name: params.name, env })],
  ];
  for (const [label, dir] of targets) {
    try {
      const stat = await fsp.stat(dir);
      if (stat.isDirectory()) {
        reasons.push(`name '${params.name}' collides with existing ${label} skill at ${dir}`);
      }
    } catch {
      // Not present — good.
    }
  }
  return reasons.length === 0 ? { status: "pass", reasons: [] } : { status: "fail", reasons };
}

export function llmReplayGateStub(): never {
  throw new Error(LLM_REPLAY_TODO);
}

/** Clamp to [0,1]; guards facet inputs sourced from external signals. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export async function evaluateGate(params: {
  skillDir: string;
  name: string;
  successScore?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Replay-gate pass rate (0-1) from the multi-run agreement judge
   * (judgeSkillCandidateWithLlmAgreement). Omitted → neutral 0.5 so legacy
   * callers keep the pre-integration default.
   */
  robustness?: number;
  /**
   * Optional per-facet minimum thresholds. When any computed facet falls below
   * its threshold, the gate fails even when all other checks pass. Omit to
   * run the legacy gate (security + validation + collision only).
   */
  minFacets?: Partial<QualityFacets>;
}): Promise<GateVerdict> {
  const security = await staticSecurityScan(params.skillDir);
  const hasCriticalFindings = security.findings.some((f) => f.severity === "critical");

  // Compute quality facets from available signals.
  const facets: QualityFacets = {
    // Utility: session-success-score mapped to 0-1. When no score is available,
    // default to 0.5 (neutral). Sanity-cap at 1.0 since success scores above 1
    // are clamped for the facet.
    utility: Math.min(1, params.successScore ?? 0.5),
    // Robustness: replay-gate pass rate across k judge runs (multi-run
    // agreement). Neutral 0.5 when no replay data is threaded in.
    robustness: clamp01(params.robustness ?? 0.5),
    // Safety: 1.0 when no critical findings; scales down as criticals increase.
    // Each critical finding subtracts 0.25, floor at 0.
    safety: hasCriticalFindings
      ? Math.max(0, 1 - security.findings.filter((f) => f.severity === "critical").length * 0.25)
      : 1,
  };

  if (security.status === "fail") {
    const criticalFindings = security.findings.filter((f) => f.severity === "critical");
    if (criticalFindings.length > 0) {
      return {
        status: "fail",
        reasons: criticalFindings.map(
          (f) => `[security] ${f.message} (${f.id} at ${f.file}${f.line ? `:${f.line}` : ""})`,
        ),
        qualityFacets: facets,
      };
    }
  }

  const validation = await validateSkillDir(params.skillDir, params.successScore);
  if (validation.status === "fail") {
    return { ...validation, qualityFacets: facets };
  }

  const collision = await nameCollisionCheck({ name: params.name, env: params.env });
  if (collision.status === "fail") {
    return { ...collision, qualityFacets: facets };
  }

  // If minFacets thresholds are specified, check each facet.
  const reasons: string[] = [];
  if (params.minFacets) {
    if (params.minFacets.utility !== undefined && facets.utility < params.minFacets.utility) {
      reasons.push(
        `quality facet utility=${facets.utility.toFixed(2)} below threshold ${params.minFacets.utility}`,
      );
    }
    if (
      params.minFacets.robustness !== undefined &&
      facets.robustness < params.minFacets.robustness
    ) {
      reasons.push(
        `quality facet robustness=${facets.robustness.toFixed(2)} below threshold ${params.minFacets.robustness}`,
      );
    }
    if (params.minFacets.safety !== undefined && facets.safety < params.minFacets.safety) {
      reasons.push(
        `quality facet safety=${facets.safety.toFixed(2)} below threshold ${params.minFacets.safety}`,
      );
    }
  }

  return {
    status: reasons.length === 0 ? "pass" : "fail",
    reasons,
    qualityFacets: facets,
  };
}
