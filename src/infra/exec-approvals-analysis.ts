import { splitShellArgs } from "../utils/shell-argv.js";
import type {
  ExecCommandAnalysis,
  ExecCommandSegment,
  ShellChainOperator,
} from "./exec-command-analysis-types.js";
import { resolveCommandResolutionFromArgv } from "./exec-command-resolution.js";
// Shared exec approval analysis types and Windows-only shell enforcement helpers.
import {
  analyzeWindowsShellCommand,
  isWindowsPlatform,
  rebuildWindowsShellCommandFromSource,
  windowsEscapeArg,
} from "./windows-shell-command.js";

export { analyzeArgvCommand } from "./exec-argv-analysis.js";

export {
  matchAllowlist,
  parseExecArgvToken,
  buildCwdBoundHashedArgPattern,
  resolveAllowlistCandidatePath,
  resolveApprovalAuditCandidatePath,
  resolveApprovalAuditTrustPath,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolveExecutionTargetTrustPath,
  resolvePolicyAllowlistCandidatePath,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  resolvePolicyTargetTrustPath,
  resolveExecutableTrustPath,
  type CommandResolution,
  type ExecutableResolution,
  type ExecArgvToken,
} from "./exec-command-resolution.js";

export {
  analyzeWindowsShellCommand,
  isWindowsPlatform,
  tokenizeWindowsSegment,
  windowsEscapeArg,
} from "./windows-shell-command.js";
export type {
  ExecCommandAnalysis,
  ExecCommandSegment,
  ShellChainOperator,
} from "./exec-command-analysis-types.js";

function renderWindowsQuotedArgv(argv: readonly string[]):
  | { ok: true; rendered: string }
  | {
      ok: false;
      reason: string;
    } {
  const parts: string[] = [];
  for (const token of argv) {
    const result = windowsEscapeArg(token);
    if (!result.ok) {
      return { ok: false, reason: `unsafe windows token: ${token}` };
    }
    parts.push(result.escaped);
  }
  return { ok: true, rendered: parts.join(" ") };
}

export function resolvePlannedSegmentArgv(segment: ExecCommandSegment): string[] | null {
  if (segment.resolution?.policyBlocked === true) {
    return null;
  }
  const baseArgv =
    segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0
      ? segment.resolution.effectiveArgv
      : segment.argv;
  if (baseArgv.length === 0) {
    return null;
  }
  const argv = [...baseArgv];
  const execution = segment.resolution?.execution;
  const resolvedExecutable =
    execution?.resolvedRealPath?.trim() ?? execution?.resolvedPath?.trim() ?? "";
  if (resolvedExecutable) {
    argv[0] = resolvedExecutable;
  }
  return argv;
}

export function buildEnforcedShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  platform?: string | null;
}): { ok: boolean; command?: string; reason?: string } {
  if (params.platform !== "win32") {
    return { ok: false, reason: "unsupported platform" };
  }

  const rebuilt = rebuildWindowsShellCommandFromSource({
    command: params.command,
    renderSegment: (_raw, segmentIndex) => {
      const segment = params.segments[segmentIndex];
      if (!segment) {
        return { ok: false, reason: "segment mapping failed" };
      }
      const argv = resolvePlannedSegmentArgv(segment);
      if (!argv) {
        return { ok: false, reason: "segment execution plan unavailable" };
      }
      return renderWindowsQuotedArgv(argv);
    },
  });
  if (!rebuilt.ok) {
    return { ok: false, reason: rebuilt.reason };
  }
  if (rebuilt.segmentCount !== params.segments.length) {
    return { ok: false, reason: "segment count mismatch" };
  }
  return { ok: true, command: rebuilt.command };
}

// --- shell chain/pipeline splitting helpers (restored for analyzeShellCommand) ---

const DOUBLE_QUOTE_ESCAPES = new Set(["$", "`", '"', "\\", "\n"]);

function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

function isShellCommentStart(source: string, index: number): boolean {
  if (source[index] !== "#") {
    return false;
  }
  if (index === 0) {
    return true;
  }
  const prev = source[index - 1];
  return Boolean(prev && /\s/.test(prev));
}

type ShellChainPart = { part: string; opToNext: ShellChainOperator | null };

function splitCommandChainWithOperators(command: string): ShellChainPart[] | null {
  const parts: ShellChainPart[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let foundChain = false;
  let invalidChain = false;

  const pushPart = (opToNext: ShellChainOperator | null) => {
    const trimmed = buf.trim();
    buf = "";
    if (!trimmed) {
      return false;
    }
    parts.push({ part: trimmed, opToNext });
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      buf += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += ch;
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      buf += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }
    if (isShellCommentStart(command, i)) {
      break;
    }
    if (ch === "&" && next === "&") {
      if (!pushPart("&&")) {
        invalidChain = true;
      }
      i += 1;
      foundChain = true;
      continue;
    }
    if (ch === "|" && next === "|") {
      if (!pushPart("||")) {
        invalidChain = true;
      }
      i += 1;
      foundChain = true;
      continue;
    }
    if (ch === ";") {
      if (!pushPart(";")) {
        invalidChain = true;
      }
      foundChain = true;
      continue;
    }
    buf += ch;
  }

  if (!foundChain) {
    return null;
  }
  const trimmed = buf.trim();
  if (!trimmed) {
    return null;
  }
  parts.push({ part: trimmed, opToNext: null });
  if (invalidChain || parts.length === 0) {
    return null;
  }
  return parts;
}

function splitCommandChain(command: string): string[] | null {
  const parts = splitCommandChainWithOperators(command);
  if (!parts) {
    return null;
  }
  return parts.map((p) => p.part);
}

function splitShellPipeline(command: string): { ok: boolean; reason?: string; segments: string[] } {
  // Split on unquoted | (not ||). Bail (ok:false) on heredocs, command
  // substitution, or raw newlines so the caller falls back to a line-by-line
  // scan — those can hide a /approve or interactive-login command on a separate
  // logical line that single-segment pipeline parsing would miss.
  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let unsafe = false;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      buf += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += ch;
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      buf += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }
    // Unquoted constructs that defeat single-segment pipeline analysis — flag
    // so the caller falls back to line-by-line scanning.
    if (ch === "\n" || ch === "\r" || ch === "`") {
      unsafe = true;
    } else if (ch === "$" && next === "(") {
      unsafe = true;
    } else if (ch === "<" && next === "<") {
      unsafe = true;
    }
    // Unquoted | that is not part of || operator
    if (ch === "|" && next !== "|" && command[i - 1] !== "|") {
      const trimmed = buf.trim();
      if (trimmed) {
        segments.push(trimmed);
      }
      buf = "";
      continue;
    }
    buf += ch;
  }
  const trimmed = buf.trim();
  if (trimmed) {
    segments.push(trimmed);
  }
  if (unsafe) {
    return {
      ok: false,
      reason: "heredoc, command substitution, or newline requires line-by-line analysis",
      segments: [],
    };
  }
  if (segments.length === 0) {
    return { ok: false, reason: "empty command", segments: [] };
  }
  return { ok: true, segments };
}

function parseSegmentsFromParts(
  parts: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
  platform?: string | null,
): ExecCommandSegment[] | null {
  const segments: ExecCommandSegment[] = [];
  for (const raw of parts) {
    const argv = splitShellArgs(raw);
    if (!argv || argv.length === 0) {
      return null;
    }
    segments.push({
      raw,
      argv,
      resolution: platform
        ? resolveCommandResolutionFromArgv(argv, cwd, env, platform as NodeJS.Platform)
        : resolveCommandResolutionFromArgv(argv, cwd, env),
    });
  }
  return segments;
}

/** Analyze a shell command string into typed segments with resolution info. */
export function analyzeShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): ExecCommandAnalysis {
  if (isWindowsPlatform(params.platform)) {
    return analyzeWindowsShellCommand(params);
  }
  const chainParts = splitCommandChain(params.command);
  if (chainParts) {
    const chains: ExecCommandSegment[][] = [];
    const allSegments: ExecCommandSegment[] = [];
    for (const part of chainParts) {
      const pipelineSplit = splitShellPipeline(part);
      if (!pipelineSplit.ok) {
        return { ok: false, reason: pipelineSplit.reason, segments: [] };
      }
      const segments = parseSegmentsFromParts(
        pipelineSplit.segments,
        params.cwd,
        params.env,
        params.platform,
      );
      if (!segments) {
        return { ok: false, reason: "unable to parse shell segment", segments: [] };
      }
      chains.push(segments);
      allSegments.push(...segments);
    }
    return { ok: true, segments: allSegments, chains };
  }
  const split = splitShellPipeline(params.command);
  if (!split.ok) {
    return { ok: false, reason: split.reason, segments: [] };
  }
  const segments = parseSegmentsFromParts(split.segments, params.cwd, params.env, params.platform);
  if (!segments) {
    return { ok: false, reason: "unable to parse shell segment", segments: [] };
  }
  return { ok: true, segments };
}
