/**
 * Bash-command discipline guard for agent exec.
 *
 * Adapted from the behavior-enforcement hooks: blocks low-value / high-backtrack
 * shell patterns at the bash tool boundary so the model self-corrects toward the
 * right tool. Tokenizes and matches the base command (not raw substrings) so a
 * filename like `run-vitest.mjs` or a `serve`/`--watch` token inside a search
 * argument is never mistaken for a process launch. Four rules, each independently
 * toggleable, on by default:
 *   - ast-grep:     recursive/codebase grep|rg → use ast-grep
 *   - background:   foreground dev/serve/watch/follow/large-sleep → background:true
 *   - prefer-read:  bare cat/sed/head/tail file reads → the read tool
 *   - git:          force-push, reset --hard, clean -fd
 *
 * Pure and synchronous: every rule decides from the command string (+ the
 * background flag) alone, so it runs inline in the exec guard with no I/O.
 */
import type { BashDisciplineConfig } from "../config/types.tools.js";
import { splitShellArgs } from "../utils/shell-argv.js";

export type { BashDisciplineConfig };

export type BashDisciplineRule = "ast-grep" | "background" | "prefer-read" | "git";

export type BashDisciplineViolation = { rule: BashDisciplineRule; reason: string };

const CODE_EXT = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".vue",
  ".svelte",
  ".mjs",
  ".cjs",
];
const TEXT_HINT = [
  ".log",
  ".txt",
  ".csv",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".env",
  ".lock",
  ".xml",
  ".html",
  "/var/log",
  "package.json",
];
const GREP_BASES = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep"]);
const READER_BASES = new Set(["cat", "head", "tail", "sed"]);

// Search/read/print tools never launch a long-running process, so the background
// rule must never touch them — ast-grep especially, which this guard promotes.
const NON_PROCESS_BASES = new Set([
  "ast-grep",
  "sg",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ripgrep",
  "find",
  "ls",
  "echo",
  "printf",
]);
// Base commands that are always long-running dev/serve processes.
const LONGRUN_BASES = new Set([
  "nodemon",
  "serve",
  "http-server",
  "uvicorn",
  "gunicorn",
  "webpack-dev-server",
]);

const ASTGREP_REASON =
  "Blocked: use ast-grep for codebase searches, not grep/rg.\n" +
  "  ✅ ast-grep --pattern 'function $NAME($$$) { $$$ }' src/\n" +
  "grep/rg is fine for non-code text or a single known file (grep -n pat file). " +
  "Disable with tools.bashDiscipline.astGrep: false.";
const BACKGROUND_REASON =
  "Blocked: this looks like a long-running process (dev server / watcher / follow / build). " +
  "Run it in the background — set background: true on the exec call. " +
  "For waiting on a condition, poll in a loop, not foreground sleep. " +
  "Disable with tools.bashDiscipline.background: false.";
const PREFER_READ_REASON =
  "Blocked: read files with the read tool, not cat/sed/head/tail shell reads " +
  "(it handles offsets, large files, and images). " +
  "Shell text tools are fine in pipelines/redirects/heredocs. " +
  "Disable with tools.bashDiscipline.preferRead: false.";

/** Tokenize a single segment; null on a quoting error (caller treats as non-match). */
function tokenize(segment: string): string[] | null {
  return splitShellArgs(segment.trim());
}

function baseCommand(token: string): string {
  const slash = token.lastIndexOf("/");
  return slash >= 0 ? token.slice(slash + 1) : token;
}

/** Split on shell separators, dropping them (|| && | ;). */
function splitSegments(command: string): string[] {
  return command.split(/\|\||&&|[|;]/u);
}

// Bare single-segment names that read as source roots (a whole tree), not files.
const KNOWN_SOURCE_DIRS = new Set(["src", "lib", "app"]);

type GrepOperand = "text" | "file" | "scoped" | "broad-dir";

/**
 * Classify a grep path operand. `recursive` is the tiebreaker for a bare
 * extensionless single name (`Makefile` vs a real directory `components`):
 * without `-r` it is a concrete file (allow), with `-r` it is a tree (block).
 */
function classifyGrepOperand(p: string, recursive: boolean): GrepOperand {
  if (TEXT_HINT.some((h) => p.includes(h))) {
    return "text";
  }
  if (CODE_EXT.some((e) => p.endsWith(e))) {
    return "file";
  }
  if (p === ".") {
    return "broad-dir";
  }
  const segments = p.split("/").filter(Boolean);
  if (segments.length > 1) {
    return "scoped"; // deep path → scoped search, allow
  }
  if (p.endsWith("/") || KNOWN_SOURCE_DIRS.has(p)) {
    return "broad-dir";
  }
  if (baseCommand(p).includes(".")) {
    return "file"; // e.g. package.json, config.yaml — a concrete file
  }
  // Bare extensionless single name: a file unless the command recurses.
  return recursive ? "broad-dir" : "file";
}

function isRecursiveCodeGrep(segment: string): boolean {
  const toks = tokenize(segment) ?? segment.trim().split(/\s+/u).filter(Boolean);
  if (toks.length === 0) {
    return false;
  }
  const base = baseCommand(toks[0]!);
  if (!GREP_BASES.has(base)) {
    return false;
  }
  const flags = toks.slice(1).filter((t) => t.startsWith("-"));
  const args = toks.slice(1).filter((t) => !t.startsWith("-"));
  // Recursion signal: rg/ripgrep recurse by default; for grep look only at
  // short-flag clusters (`-rn`) and `--recursive`, never at any long flag that
  // merely contains an "r" (e.g. `--color` must not read as recursive).
  const shortFlagChars = flags
    .filter((f) => f.startsWith("-") && !f.startsWith("--"))
    .map((f) => f.slice(1))
    .join("");
  const recursive =
    base === "rg" ||
    base === "ripgrep" ||
    shortFlagChars.includes("r") ||
    shortFlagChars.includes("R") ||
    flags.includes("--recursive");
  // The first non-flag arg is the pattern; the rest are path operands.
  const operands = args.slice(1);
  const classes = operands.map((p) => classifyGrepOperand(p, recursive));
  // An explicit text/log target anywhere → allow (reading logs/config, not code).
  if (classes.includes("text")) {
    return false;
  }
  // No path operand: rg and `grep -r` both walk the cwd recursively → redirect.
  if (operands.length === 0) {
    return recursive || base === "rg" || base === "ripgrep";
  }
  // A broad directory target (cwd, top-level source root, trailing slash) is the
  // codebase-wide search the rule exists to redirect. Concrete files and scoped
  // deep paths stay allowed.
  return classes.includes("broad-dir");
}

function checkAstGrep(command: string): string | null {
  const segments = splitSegments(command);
  const hasPipe = command.includes("|");
  for (let i = 0; i < segments.length; i += 1) {
    // Mirror the source heuristic: when the command pipes, only the first
    // segment is a real command; later segments are downstream filters.
    if (i > 0 && hasPipe) {
      continue;
    }
    if (isRecursiveCodeGrep(segments[i]!)) {
      return ASTGREP_REASON;
    }
  }
  return null;
}

/**
 * Decide if one segment launches a long-running process. Token/base-command
 * aware (not a raw substring scan) so a filename like `run-vitest.mjs` or a
 * `--watch` / `serve` token inside a search argument is never mistaken for a
 * watcher — the original substring patterns wrongly blocked both.
 */
function isLongRunningSegment(segment: string): boolean {
  const toks = tokenize(segment);
  if (!toks || toks.length === 0) {
    return false;
  }
  const base = baseCommand(toks[0]!);
  if (NON_PROCESS_BASES.has(base)) {
    return false;
  }
  const rest = toks.slice(1);
  if (base === "sleep") {
    return rest.length > 0 && Number(rest[0]) >= 10;
  }
  if (base === "tail") {
    return rest.includes("-f") || rest.includes("-F");
  }
  if (base === "journalctl") {
    return rest.includes("-f");
  }
  if (base === "watch" || LONGRUN_BASES.has(base)) {
    return true;
  }
  if (base === "vite") {
    return !rest.includes("build");
  }
  if (base === "vitest") {
    return !rest.includes("run");
  }
  if (base === "next" || base === "nuxt") {
    return rest[0] === "dev";
  }
  if (base === "flask") {
    return rest[0] === "run";
  }
  if (base === "rails") {
    return rest[0] === "server" || rest[0] === "s";
  }
  if (base === "python" || base === "python3") {
    return rest.includes("-m") && rest.includes("http.server");
  }
  if (base === "docker") {
    return rest[0] === "compose" && rest.includes("up") && !rest.includes("-d");
  }
  if (base === "docker-compose") {
    return rest.includes("up") && !rest.includes("-d");
  }
  // Package-runner dev scripts: npm run dev / yarn dev / pnpm dev / bun [run] dev / dev:*.
  if (base === "npm" || base === "yarn" || base === "pnpm" || base === "bun") {
    const script = rest.filter((t) => t !== "run")[0] ?? "";
    return script === "dev" || script.startsWith("dev:");
  }
  // A genuine --watch flag on any other launcher (search/read tools already exempt).
  return rest.some((t) => t === "--watch" || t.startsWith("--watch="));
}

function checkBackground(command: string, background: boolean): string | null {
  if (background) {
    return null;
  }
  return splitSegments(command).some(isLongRunningSegment) ? BACKGROUND_REASON : null;
}

function looksLikeFile(token: string): boolean {
  return (token.includes("/") || token.includes(".")) && !token.startsWith("-");
}

function isBareFileRead(segment: string): boolean {
  const s = segment.trim();
  // Heredoc / redirect / command-substitution → allow (writing or composing, not reading).
  if (
    !s ||
    s.includes("<<") ||
    s.includes(">") ||
    s.includes("<") ||
    s.includes("$(") ||
    s.includes("`")
  ) {
    return false;
  }
  const toks = tokenize(s);
  if (!toks || toks.length === 0) {
    return false;
  }
  const base = baseCommand(toks[0]!);
  if (!READER_BASES.has(base)) {
    return false;
  }
  const rest = toks.slice(1);
  if (base === "tail" && (rest.includes("-f") || rest.includes("-F"))) {
    return false; // follow mode is the background guard's job
  }
  if (base === "sed") {
    // Only the read idiom: sed -n '<range>p' FILE (not in-place -i).
    if (rest.includes("-i") || !rest.some((t) => /\d*,?\d*p/u.test(t))) {
      return false;
    }
  }
  // Only redirect SOURCE-file reads to the read tool; reading logs/config
  // (package.json, *.log, .env, plain text) via cat/tail stays allowed.
  return rest.some((t) => looksLikeFile(t) && CODE_EXT.some((e) => t.endsWith(e)));
}

function checkPreferRead(command: string): string | null {
  // Keep separators so a reader adjacent to a pipe (filter / data feed) is allowed.
  const parts = command.split(/(\|\||&&|;|\|)/u);
  for (let i = 0; i < parts.length; i += 2) {
    const prevSep = i > 0 ? parts[i - 1] : "";
    const nextSep = i + 1 < parts.length ? parts[i + 1] : "";
    if (prevSep === "|" || nextSep === "|") {
      continue;
    }
    if (isBareFileRead(parts[i]!)) {
      return PREFER_READ_REASON;
    }
  }
  return null;
}

/** True when `git <sub>` appears as a command (not separated by a pipe/;&). */
function hasGitSub(command: string, sub: string): boolean {
  if (!/\bgit\b/u.test(command)) {
    return false;
  }
  return new RegExp(`\\bgit\\b[^|;&]*\\b${sub}\\b`, "u").test(command);
}

function checkGit(command: string): string | null {
  if (!command.includes("git")) {
    return null;
  }
  // Pure string checks only — deliberately NOT ported from the source hook:
  // push-from-main (needs a live `git rev-parse`, and OpenClaw's main IS the
  // deploy trunk so pushing it is legitimate) and the commit-footer rule (that
  // footer is Claude-Code-specific; OpenClaw commits via scripts/committer with
  // no such requirement). Do not "restore parity" with those.
  if (hasGitSub(command, "push") && /--force\b|--force-with-lease\b|(?<!\w)-f\b/u.test(command)) {
    return (
      "Blocked: force-push rewrites shared history and is a frequent backtrack source. " +
      "Disable with tools.bashDiscipline.git: false."
    );
  }
  if (hasGitSub(command, "reset") && command.includes("--hard")) {
    return (
      "Blocked: `git reset --hard` discards work irreversibly. Use a softer reset/stash. " +
      "Disable with tools.bashDiscipline.git: false."
    );
  }
  if (hasGitSub(command, "clean") && /-[a-z]*f[a-z]*d|-[a-z]*d[a-z]*f/u.test(command)) {
    return (
      "Blocked: `git clean -fd` deletes untracked files irreversibly. Review with `git clean -nd` first. " +
      "Disable with tools.bashDiscipline.git: false."
    );
  }
  return null;
}

/**
 * Evaluate every enabled discipline rule against a pending bash command.
 * Returns the first violation, or null when the command is allowed.
 */
export function checkBashCommandDiscipline(input: {
  command: string;
  background?: boolean;
  config?: BashDisciplineConfig;
}): BashDisciplineViolation | null {
  const { command, config } = input;
  if (!command.trim() || config?.enabled === false) {
    return null;
  }
  const enabled = (rule: keyof BashDisciplineConfig): boolean => config?.[rule] !== false;

  if (enabled("astGrep")) {
    const reason = checkAstGrep(command);
    if (reason) {
      return { rule: "ast-grep", reason };
    }
  }
  if (enabled("background")) {
    const reason = checkBackground(command, input.background === true);
    if (reason) {
      return { rule: "background", reason };
    }
  }
  if (enabled("preferRead")) {
    const reason = checkPreferRead(command);
    if (reason) {
      return { rule: "prefer-read", reason };
    }
  }
  if (enabled("git")) {
    const reason = checkGit(command);
    if (reason) {
      return { rule: "git", reason };
    }
  }
  return null;
}
