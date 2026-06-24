import fsp from "node:fs/promises";
import path from "node:path";
import { resolveSkillForgePromotedSkillDir, resolveSkillForgeRetiredSkillDir } from "./paths.js";

export const LLM_REPLAY_TODO =
  "Phase 4 LLM-replay gate (leave-one-out re-run with the candidate skill loaded) requires an LLM provider; defer until provider chosen.";

const MIN_BODY_CHARS = 200;
const CLEAN_SESSION_MIN_BODY_CHARS = 100;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export type GateVerdict = {
  status: "pass" | "fail";
  reasons: string[];
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

/** Per-skill suppression file — one pattern per line (# comments allowed). */
const SUPPRESSION_FILE = ".skill-lint-suppressions";

const SECURITY_PATTERNS: Array<{
  id: string;
  severity: "critical" | "warning";
  regex: RegExp;
  message: string;
}> = [
  // ── Existing baseline (5 patterns) ──
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
  // ── SkillSpector: MCP tool poisoning (non-standard tool invocations) ──
  {
    id: "mcp-tool-poison",
    severity: "critical",
    regex:
      /\b(?:mcp_call|invoke_tool|exec_tool)\s*\(\s*["'](?!read|write|edit|exec|grep|glob|search|list|run|bash|fetch|web_search|memory|session)[a-z_]+/giu,
    message: "Suspicious MCP tool invocation (non-standard tool name)",
  },
  {
    id: "mcp-dynamic-tool",
    severity: "warning",
    regex: /(?:mcp|tool)\s*\[\s*\$\{|\$\{[^}]*\}\s*(?:tools?|call|invoke)/giu,
    message: "Dynamic/interpolated MCP tool name (potential injection vector)",
  },
  {
    id: "tool-name-eval",
    severity: "critical",
    regex: /\b(?:eval|Function|setTimeout|setInterval)\s*\(\s*tool\s*(?:name|\[)/giu,
    message: "Tool name constructed via eval/Function (code injection)",
  },
  // ── SkillSpector: memory poisoning ──
  {
    id: "memory-poison-write",
    severity: "critical",
    regex:
      /\b(?:write|writeFile|write_file|fs\.write|fsp?\.write)\s*\(\s*["'][^"']*(?:memory\/|\.openclaw\/workspace\/memory\/|\.openclaw\/workspace\/MEMORY\.md|\/MEMORY\.md)[^"']*["']/giu,
    message: "Direct write to memory/ workspace (memory poisoning)",
  },
  {
    id: "memory-poison-append",
    severity: "warning",
    regex:
      /\b(?:appendFile|append_file|fs\.append)\s*\(\s*["'][^"']*(?:memory\/|\.openclaw\/workspace\/memory\/)/giu,
    message: "Append to memory/ workspace (potential poisoning)",
  },
  {
    id: "memory-rm",
    severity: "critical",
    regex:
      /\b(?:rm|unlink|del|delete)\s*\(?\s*["'][^"']*(?:memory\/l\d|memory\/\.dreams|memory\/\.l\d)/giu,
    message: "Delete of L3/L2/dream-memory files (memory tampering)",
  },
  // ── SkillSpector: privilege escalation ──
  {
    id: "priv-esc-sudo",
    severity: "critical",
    regex: /\b(?:sudo|su\s+-|pkexec|doas)\b/giu,
    message: "Privilege escalation via sudo/su/pkexec/doas",
  },
  {
    id: "priv-esc-chown",
    severity: "warning",
    regex: /\b(?:chown|chmod\s+[0-7]*[67][0-7]*|setfacl|setuid|chattr\s+\+[isu])\b/giu,
    message: "File permission elevation (chown/chmod 7xx/setuid)",
  },
  {
    id: "priv-esc-container",
    severity: "critical",
    regex: /\b(?:docker\s+run\s+.*--privileged|kubectl\s+exec\s+.*-it|nsenter|unshare)\b/giu,
    message: "Container escape / privileged container launch",
  },
  // ── SkillSpector: data exfiltration ──
  {
    id: "exfil-curl-post",
    severity: "critical",
    regex:
      /\b(?:curl|wget)\s+.*\s+(?:-X\s*(?:POST|PUT|PATCH)|--data|--data-binary|--data-raw|-d\s|--upload-file)\b.*\s+(?:https?:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|api\.openai|api\.anthropic|generativelanguage\.googleapis|api\.mistral|api\.together|api\.deepseek|api\.z\.ai|api\.x\.ai|api\.groq|api\.cohere|api\.replicate|huggingface\.co)\b))/giu,
    message: "Data exfiltration: curl/wget POST/PUT to non-LLM external URL",
  },
  {
    id: "exfil-scp-rsync",
    severity: "critical",
    regex: /\b(?:scp|rsync|sftp)\s+.*\s+(?:\w+@\w+|\w+:\/\/)\S+/giu,
    message: "Data exfiltration: scp/rsync/sftp to remote host",
  },
  {
    id: "exfil-nc-pipe",
    severity: "warning",
    regex: /\b(?:nc|netcat|ncat)\s+.*\s*[<>|]\s*\S+/giu,
    message: "Data exfiltration: netcat pipe/redirect to remote",
  },
  // ── SkillSpector: MCP least privilege (wildcard access) ──
  {
    id: "mcp-wildcard-files",
    severity: "warning",
    regex: /access.*["'](?:\*|\/\*|\*\*)["']|(?:allow|deny)list.*["'](?:\*|\/\*)["']/giu,
    message: "Overly broad file access pattern (wildcard glob in MCP tool)",
  },
  // ── SkillSpector: path traversal ──
  {
    id: "path-traversal",
    severity: "critical",
    regex: /(?:\/|\\)\.\.(?:\/|\\)|(?:\/|\\)\.\.$/g,
    message: "Path traversal (../) detected",
  },
  // ── SkillSpector: network bind / reverse shell ──
  {
    id: "reverse-shell",
    severity: "critical",
    regex:
      /\b(?:bash\s+-i\s+>&|python\s+-c\s+["'].*socket|perl\s+-e\s+["'].*socket|ruby\s+-e\s+["'].*TCPSocket|php\s+-r\s+["'].*fsockopen)/giu,
    message: "Reverse shell / bind shell pattern",
  },
];

/**
 * Read per-skill suppression file. One suppression rule per line.
 * Lines starting with # are comments, blank lines are ignored.
 * A suppression matches a finding when its rule-ID appears on its own line.
 */
async function loadSuppressions(skillDir: string): Promise<Set<string>> {
  const suppressions = new Set<string>();
  try {
    const raw = await fsp.readFile(path.join(skillDir, SUPPRESSION_FILE), "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      suppressions.add(trimmed);
    }
  } catch {
    // No suppression file — treat as empty.
  }
  return suppressions;
}

function scanContent(content: string, fileName: string): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split("\n");
  for (const pattern of SECURITY_PATTERNS) {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
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

  // Apply per-skill suppressions if present
  const suppressions = await loadSuppressions(skillDir);
  const filtered =
    suppressions.size > 0 ? findings.filter((f) => !suppressions.has(f.id)) : findings;

  const criticalCount = filtered.filter((f) => f.severity === "critical").length;
  return {
    status: criticalCount > 0 ? "fail" : "pass",
    findings: filtered,
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
  return {
    name: nameMatch ? unquote(nameMatch[1]) : undefined,
    description: descriptionMatch ? unquote(descriptionMatch[1]) : undefined,
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

export async function evaluateGate(params: {
  skillDir: string;
  name: string;
  successScore?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<GateVerdict> {
  const security = await staticSecurityScan(params.skillDir);
  if (security.status === "fail") {
    const criticalFindings = security.findings.filter((f) => f.severity === "critical");
    if (criticalFindings.length > 0) {
      return {
        status: "fail",
        reasons: criticalFindings.map(
          (f) => `[security] ${f.message} (${f.id} at ${f.file}${f.line ? `:${f.line}` : ""})`,
        ),
      };
    }
  }
  const validation = await validateSkillDir(params.skillDir, params.successScore);
  if (validation.status === "fail") {
    return validation;
  }
  const collision = await nameCollisionCheck({ name: params.name, env: params.env });
  if (collision.status === "fail") {
    return collision;
  }
  return { status: "pass", reasons: [] };
}
