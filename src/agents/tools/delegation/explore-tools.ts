// Tools that GLM can call inside the glm__explore ReAct loop.
// Each tool: validates inputs, caps input/output bytes, and returns a string
// the loop can feed back to GLM as a role:"tool" message.
//
// READ-ONLY (6, parallelizable):
//   - 4 fs: list_dir, read_file, glob, grep — gated by
//     MCP_FILE_PATHS_ALLOWED_ROOTS (default $HOME:/tmp).
//   - 2 web: web_fetch (HTTP GET, SSRF-defended, content-type filtered),
//     web_search (proxies Z.ai's web_search_prime via JSON-RPC; reuses
//     ZAI_API_KEY; counts against the monthly MCP quota).
//   All six run in parallel within a batch via Promise.all.
//
// MUTATING (4, sequential):
//   - write_file (with append flag), write_files (batch up to 20),
//     notebook_edit (Jupyter cell-aware: read|replace|insert|delete) —
//     all gated by MCP_FILE_PATHS_WRITE_ROOTS (default /tmp; narrower than
//     read roots, principle of least privilege).
//   - bash: MCP_EXPLORE_BASH_ALLOWLIST (~25 read-only/diagnostic binaries
//     by default) + MCP_EXPLORE_BASH_DENYLIST (rm/sudo/dd/etc; deny wins)
//     + per-arg path denylist (/etc /usr /bin /sbin, network creds,
//     shell-substitution syntax). shell:false direct spawn — no pipes,
//     redirects, or command substitution.
//   All four are excluded from READONLY_TOOL_NAMES so any batch containing
//   one falls into the sequential-dispatch branch (no clobbering, no race).
//
// Principle of least privilege: a model exploit can read your home but writes
// default to /tmp and bash defaults to read-only commands. Operators broaden
// via env vars. v1 does NOT defend symlink traversal on write paths — don't
// broaden write roots to a directory containing untrusted symlinks. Bash uses
// shell:false (direct spawn, no pipes/redirects/$()) — model sequences across
// iterations if needed.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { globIterate } from "glob";

const MAX_RESULT_BYTES = 200_000;
const MAX_WRITE_BYTES = 100_000;
const MAX_WRITE_FILES_PER_CALL = 20;
const PER_TOOL_TIMEOUT_MS = 10_000;
const BASH_TIMEOUT_MS = 30_000;
const BASH_OUTPUT_BYTES = 200_000;

// web_fetch caps. Default 200KB body, hard ceiling 1MB. 30s timeout matches bash.
const WEB_FETCH_DEFAULT_BYTES = 200_000;
const WEB_FETCH_MAX_BYTES = 1_048_576;
const WEB_FETCH_TIMEOUT_MS = 30_000;

// Z.ai hosted MCP tools (web_search_prime, web_reader, zread) all live under one
// host, one sub-path per tool. Verified endpoints:
//   {host}/web_search_prime/mcp  {host}/web_reader/mcp  {host}/zread/mcp
// CN/coding keys still resolve against the global host here — the same limitation
// web_search has always had; revisit if a CN MCP host is ever required.
const ZAI_MCP_TIMEOUT_MS = 30_000;
const ZAI_MCP_HOST = "https://api.z.ai/api/mcp";
function zaiMcpEndpoint(tool: string): string {
  return `${ZAI_MCP_HOST}/${tool}/mcp`;
}

// Accepted Content-Types for web_fetch. Reject binary/PDF/octet-stream.
const ACCEPTED_CONTENT_TYPE_PATTERNS: RegExp[] = [
  /^text\//,
  /^application\/json/,
  /^application\/xml/,
  /^application\/x-yaml/,
  /^application\/yaml/,
  /^application\/javascript/,
  /^application\/typescript/,
];

// SSRF defense — deny fetches to loopback/link-local/private RFC1918.
// String-pattern check on hostname; v1 doesn't resolve DNS to verify the
// behind-the-name IP, so internal hostnames that resolve to private IPs
// would slip through. Operators can tighten via MCP_EXPLORE_WEB_FETCH_DOMAINS
// allowlist for production use.
const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^localhost\./i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^169\.254\./, // link-local + AWS metadata
  /^10\./, // RFC1918 10/8
  /^172\.(1[6-9]|2[0-9]|3[01])\./, // RFC1918 172.16/12
  /^192\.168\./, // RFC1918 192.168/16
  /^::1?$/, // IPv6 loopback
  /^fc/i,
  /^fd/i, // IPv6 unique-local fc00::/7
  /^fe[89ab]/i, // IPv6 link-local fe80::/10
];

// Bash allowlist: binary names that may run via the bash tool. Env override
// is colon-separated (e.g. "ls:cat:git:bun"). Default leans read-only and
// diagnostic — operators opt in to anything mutating via the env var.
const BASH_DEFAULT_ALLOW = [
  "ls",
  "pwd",
  "echo",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "find",
  "which",
  "whoami",
  "env",
  "date",
  "uname",
  "type",
  "dirname",
  "basename",
  "realpath",
  "stat",
  "sort",
  "uniq",
  "jq",
  "grep",
  "git",
  "bun",
  "node",
  "npm",
  "tsc",
  "jest",
];
// Always-deny list. Wins over the allowlist — if a binary appears here, it's
// never runnable even if explicitly allowed. For super-risky ops (rm of system
// files, privilege escalation, network creds, raw disk).
const BASH_DEFAULT_DENY = [
  "rm",
  "rmdir",
  "sudo",
  "su",
  "doas",
  "mkfs",
  "fdisk",
  "dd",
  "kill",
  "killall",
  "pkill",
  "ssh",
  "scp",
  "rsync",
  "curl",
  "wget",
  "chmod",
  "chown",
  "ln",
  "mv",
  "cp",
  "shutdown",
  "reboot",
  "halt",
  "launchctl",
];
// Per-arg path denylist. If any positional arg matches one of these patterns,
// the call is denied — defense against "cat /etc/passwd"-style reads of
// sensitive paths and against shell-substitution patterns sneaking through.
const BASH_ARG_DENY_PATTERNS: RegExp[] = [
  /^\/etc\//,
  /^\/usr\/(?!share\b)/,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/System\//,
  /^\/Library\/(?!Caches)/,
  /^\/private\/etc\//,
  /^\/var\/(?!folders|tmp)\b/,
  /\/\.ssh(\/|$)/,
  /\/\.aws(\/|$)/,
  /\/\.gnupg(\/|$)/,
  /\/id_rsa\b/,
  /\.env(\.|$)/,
  /\$\(/,
  /`/,
  /;\s*\w/,
  /&&/,
  /\|\|/,
  />/,
  /</,
  /\|/,
];

// Mirror of file-resolver's allowlist. Kept in sync via shared env semantics; we
// re-read the env here so a single launched server picks up the same roots.
function readAllowedRoots(): string[] {
  const raw = process.env["MCP_FILE_PATHS_ALLOWED_ROOTS"];
  const fallback = [os.homedir(), "/tmp"];
  if (!raw) return fallback;
  const roots = raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => (r.startsWith("~") ? path.join(os.homedir(), r.slice(1)) : r))
    .map((r) => path.resolve(r));
  return roots.length > 0 ? roots : fallback;
}

// Narrower allowlist for the write_file tool. Defaults to /tmp only — least
// privilege. Operators broadening this (e.g. to a project dir under $HOME)
// should also ensure the target dir contains no malicious symlinks, since
// v1 doesn't realpath-resolve write targets.
function readWriteAllowedRoots(): string[] {
  const raw = process.env["MCP_FILE_PATHS_WRITE_ROOTS"];
  const fallback = ["/tmp"];
  if (!raw) return fallback;
  const roots = raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => (r.startsWith("~") ? path.join(os.homedir(), r.slice(1)) : r))
    .map((r) => path.resolve(r));
  return roots.length > 0 ? roots : fallback;
}

function readWebFetchDomainAllowlist(): Set<string> | null {
  const raw = process.env["MCP_EXPLORE_WEB_FETCH_DOMAINS"];
  if (!raw) return null; // null = no allowlist, all reachable hostnames allowed
  const items = raw
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? new Set(items.map((s) => s.toLowerCase())) : null;
}

function readBashAllowlist(): Set<string> {
  const raw = process.env["MCP_EXPLORE_BASH_ALLOWLIST"];
  const items = raw
    ? raw
        .split(":")
        .map((s) => s.trim())
        .filter(Boolean)
    : BASH_DEFAULT_ALLOW;
  return new Set(items);
}

function readBashDenylist(): Set<string> {
  const raw = process.env["MCP_EXPLORE_BASH_DENYLIST"];
  // Env override REPLACES the default; operators wanting "default + extras"
  // should pass the full union themselves.
  const items = raw
    ? raw
        .split(":")
        .map((s) => s.trim())
        .filter(Boolean)
    : BASH_DEFAULT_DENY;
  return new Set(items);
}

const ALLOWED_ROOTS = readAllowedRoots();
const WRITE_ALLOWED_ROOTS = readWriteAllowedRoots();
const BASH_ALLOW = readBashAllowlist();
const BASH_DENY = readBashDenylist();
const WEB_FETCH_DOMAIN_ALLOW = readWebFetchDomainAllowlist();

function isUnderAllowed(absPath: string): boolean {
  const normalized = path.resolve(absPath);
  return ALLOWED_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(root + path.sep),
  );
}

function isUnderWriteAllowed(absPath: string): boolean {
  const normalized = path.resolve(absPath);
  return WRITE_ALLOWED_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(root + path.sep),
  );
}

function gateAbs(p: string, label: string): string | { error: string } {
  if (!path.isAbsolute(p)) return { error: `${label} must be an absolute path: '${p}'` };
  if (!isUnderAllowed(p)) {
    return {
      error: `${label} '${p}' is outside allowed roots (${ALLOWED_ROOTS.join(":")})`,
    };
  }
  return path.resolve(p);
}

function gateAbsForWrite(p: string, label: string): string | { error: string } {
  if (!path.isAbsolute(p)) return { error: `${label} must be an absolute path: '${p}'` };
  if (!isUnderWriteAllowed(p)) {
    return {
      error: `${label} '${p}' is outside write-allowed roots (${WRITE_ALLOWED_ROOTS.join(":")}). Set MCP_FILE_PATHS_WRITE_ROOTS to broaden.`,
    };
  }
  return path.resolve(p);
}

function truncate(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MAX_RESULT_BYTES) return s;
  // Truncate by bytes, not chars, to stay within cap reliably.
  const buf = Buffer.from(s, "utf8").subarray(0, MAX_RESULT_BYTES);
  return buf.toString("utf8") + `\n\n... [truncated; output exceeded ${MAX_RESULT_BYTES} bytes]`;
}

// =============================================================================
// list_dir
// =============================================================================
export type ListDirArgs = { path: string; max_entries?: number };

export async function listDir(args: ListDirArgs): Promise<string> {
  const gated = gateAbs(args.path, "path");
  if (typeof gated !== "string") return gated.error;

  let entries: string[];
  try {
    entries = await fs.readdir(gated);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
  entries.sort();
  const cap = Math.max(1, Math.min(args.max_entries ?? 100, 500));
  const truncated = entries.length > cap;
  entries = entries.slice(0, cap);

  const lines: string[] = [];
  for (const name of entries) {
    const child = path.join(gated, name);
    try {
      const st = await fs.lstat(child);
      const type = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "?";
      const size = st.isFile() ? String(st.size) : "-";
      lines.push(`${type}\t${size}\t${name}`);
    } catch {
      lines.push(`?\t-\t${name}`);
    }
  }
  let out = `# listing of ${gated}\n# format: <type>\\t<size>\\t<name>  (type: f=file, d=dir, l=symlink)\n${lines.join("\n")}`;
  if (truncated) out += `\n... [truncated; ${entries.length} of total entries shown]`;
  return truncate(out);
}

// =============================================================================
// read_file
// =============================================================================
export type ReadFileArgs = {
  path: string;
  start_line?: number;
  end_line?: number;
};

export async function readFile(args: ReadFileArgs): Promise<string> {
  const gated = gateAbs(args.path, "path");
  if (typeof gated !== "string") return gated.error;

  let stat: { size: number };
  try {
    stat = await fs.stat(gated);
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }

  const cap = Math.min(stat.size, MAX_RESULT_BYTES);
  let content: string;
  try {
    const handle = await fs.open(gated, "r");
    try {
      const buf = Buffer.alloc(cap);
      await handle.read(buf, 0, cap, 0);
      content = buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }

  // Apply line slicing if requested. 1-indexed, inclusive on both ends.
  const start = args.start_line;
  const end = args.end_line;
  if (start !== undefined || end !== undefined) {
    const lines = content.split("\n");
    const s = Math.max(1, start ?? 1) - 1;
    const e = Math.min(lines.length, end ?? lines.length);
    const slice = lines.slice(s, e);
    const numbered = slice.map((line, i) => `${s + i + 1}\t${line}`).join("\n");
    let out = `# ${gated} (lines ${s + 1}-${e} of ${lines.length})\n${numbered}`;
    if (stat.size > MAX_RESULT_BYTES) {
      out += `\n... [file is ${stat.size} bytes total; only first ${MAX_RESULT_BYTES} bytes were read before slicing]`;
    }
    return truncate(out);
  }

  let out = `# ${gated} (${stat.size} bytes)\n${content}`;
  if (stat.size > MAX_RESULT_BYTES) {
    out += `\n... [truncated; ${stat.size} bytes total, kept ${MAX_RESULT_BYTES}]`;
  }
  return truncate(out);
}

// =============================================================================
// glob
// =============================================================================
export type GlobArgs = { root: string; pattern: string; max_results?: number };

export async function globSearch(args: GlobArgs): Promise<string> {
  const gated = gateAbs(args.root, "root");
  if (typeof gated !== "string") return gated.error;

  const cap = Math.max(1, Math.min(args.max_results ?? 50, 500));
  const matches: string[] = [];
  try {
    // glob v13 (Node) replaces Bun's Glob.scan; globIterate streams matches so
    // we keep the early-break once the cap is hit. nodir:false mirrors Bun's
    // onlyFiles:false (include directories).
    for await (const rel of globIterate(args.pattern, { cwd: gated, dot: false, nodir: false })) {
      matches.push(path.join(gated, rel));
      if (matches.length >= cap) break;
    }
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }

  if (matches.length === 0) {
    return `# glob ${args.pattern} under ${gated}\n(no matches)`;
  }
  return truncate(
    `# glob ${args.pattern} under ${gated} (${matches.length}${
      matches.length >= cap ? "+" : ""
    } matches)\n${matches.join("\n")}`,
  );
}

// =============================================================================
// grep — uses native grep (no ripgrep on this system)
// =============================================================================
export type GrepArgs = {
  root: string;
  pattern: string;
  max_matches?: number;
  ignore_case?: boolean;
  include?: string;
};

export async function grepSearch(args: GrepArgs): Promise<string> {
  const gated = gateAbs(args.root, "root");
  if (typeof gated !== "string") return gated.error;

  const cap = Math.max(1, Math.min(args.max_matches ?? 50, 500));
  const flags = ["-rIn", "--exclude-dir=node_modules", "--exclude-dir=.git", `--max-count=${cap}`];
  if (args.ignore_case) flags.push("-i");
  if (args.include) flags.push(`--include=${args.include}`);
  // -- guards against pattern starting with '-'.
  flags.push("-e", args.pattern, gated);

  return new Promise<string>((resolve) => {
    const child = spawn("grep", flags, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let truncated = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      truncated = true;
    }, PER_TOOL_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_RESULT_BYTES) {
        truncated = true;
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`error: failed to spawn grep: ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // grep exit codes: 0=match, 1=no match, 2=error
      if (code === 1) {
        resolve(`# grep '${args.pattern}' under ${gated}\n(no matches)`);
        return;
      }
      if (code !== 0 && !truncated) {
        resolve(`error: grep exit ${code}${stderr ? ": " + stderr.slice(0, 500) : ""}`);
        return;
      }
      const lines = stdout.split("\n").filter(Boolean).slice(0, cap);
      let out = `# grep '${args.pattern}' under ${gated} (${lines.length}${
        truncated || lines.length >= cap ? "+" : ""
      } hits)\n${lines.join("\n")}`;
      if (truncated) out += `\n... [truncated by cap or timeout]`;
      resolve(truncate(out));
    });
  });
}

// =============================================================================
// write_file — the only mutating tool. Gated by MCP_FILE_PATHS_WRITE_ROOTS
// (default /tmp) on top of the read allowlist. No symlink resolution in v1.
// =============================================================================
export type WriteFileArgs = {
  path: string;
  content: string;
  create_parents?: boolean;
  append?: boolean;
};

export async function writeFile(args: WriteFileArgs): Promise<string> {
  if (typeof args.content !== "string") {
    return `error: 'content' must be a string, got ${typeof args.content}`;
  }
  const bytes = Buffer.byteLength(args.content, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    return `error: content is ${bytes} bytes, exceeds MAX_WRITE_BYTES (${MAX_WRITE_BYTES}). Split into smaller writes.`;
  }
  const gated = gateAbsForWrite(args.path, "path");
  // Prefix gate errors with "error: " so writeFiles' batch-failure detection
  // (which keys on result.startsWith("error:")) catches them. Without this,
  // a denied path silently slipped into the success column.
  if (typeof gated !== "string") return `error: ${gated.error}`;

  // Detect create-vs-overwrite for an honest return value.
  let existed = false;
  try {
    await fs.stat(gated);
    existed = true;
  } catch {
    // file doesn't exist; will create
  }

  const createParents = args.create_parents ?? true;
  if (createParents) {
    const parent = path.dirname(gated);
    try {
      await fs.mkdir(parent, { recursive: true });
    } catch (err) {
      return `error: failed to create parent dir '${parent}': ${(err as Error).message}`;
    }
  }

  const append = args.append === true;
  try {
    if (append) {
      await fs.appendFile(gated, args.content, { encoding: "utf8" });
    } else {
      await fs.writeFile(gated, args.content, { encoding: "utf8" });
    }
  } catch (err) {
    return `error: ${append ? "append" : "write"} failed: ${(err as Error).message}`;
  }

  const verb = append
    ? existed
      ? "appended to"
      : "appended (created)"
    : existed
      ? "overwrote"
      : "wrote";
  return `# ${verb} ${gated} (${bytes} bytes)\n[ok]`;
}

// =============================================================================
// write_files — batch variant of write_file. One tool call writes N files.
// Each file goes through the same gateAbsForWrite check independently. If any
// file fails, the others still attempt — partial-success result is reported.
// =============================================================================
export type WriteFilesArgs = {
  files: Array<{ path: string; content: string; create_parents?: boolean; append?: boolean }>;
};

export async function writeFiles(args: WriteFilesArgs): Promise<string> {
  if (!Array.isArray(args.files)) {
    return `error: 'files' must be an array of {path, content, create_parents?}`;
  }
  if (args.files.length === 0) return `error: 'files' is empty`;
  if (args.files.length > MAX_WRITE_FILES_PER_CALL) {
    return `error: ${args.files.length} files exceeds MAX_WRITE_FILES_PER_CALL (${MAX_WRITE_FILES_PER_CALL}). Split into multiple calls.`;
  }

  // Sequential execution — fs writes to different paths could otherwise race
  // on intermediate mkdir calls when create_parents=true and files share a
  // parent dir. Keeps the tool's mutating semantics consistent with the
  // loop's sequential dispatch for write batches.
  const lines: string[] = [];
  let okCount = 0;
  let failCount = 0;
  for (const file of args.files) {
    if (typeof file?.path !== "string" || typeof file?.content !== "string") {
      lines.push(`✗ <invalid entry: missing path or content>`);
      failCount++;
      continue;
    }
    const result = await writeFile(file);
    if (result.startsWith("error:")) {
      lines.push(`✗ ${file.path}: ${result.slice(6).trim()}`);
      failCount++;
    } else {
      // writeFile returns "# wrote <gated> (N bytes)\n[ok]" — extract bytes
      const match = result.match(/\((\d+) bytes\)/);
      const bytes = match ? match[1] : "?";
      lines.push(`✓ ${file.path} (${bytes} bytes)`);
      okCount++;
    }
  }

  const header = `# write_files: ${okCount}/${args.files.length} ok${failCount > 0 ? `, ${failCount} failed` : ""}`;
  return truncate(`${header}\n${lines.join("\n")}`);
}

// =============================================================================
// bash — gated shell command execution. NOT a real shell: shell:false direct
// spawn, no pipes/redirects/$()/backticks/sequencing. Allowlist of binaries +
// denylist of binaries (deny wins) + per-arg path/pattern denylist. Output
// capped at 200KB, hard timeout 30s.
// =============================================================================
export type BashArgs = { command: string };

// Parse a command string into [binary, ...args]. Supports double/single quotes
// for args containing spaces; otherwise splits on whitespace. NO shell
// substitution, NO escape handling beyond stripping the surrounding quotes.
function parseBashArgs(cmd: string): string[] {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

function violatesArgPolicy(arg: string): RegExp | null {
  for (const re of BASH_ARG_DENY_PATTERNS) {
    if (re.test(arg)) return re;
  }
  return null;
}

export async function bash(args: BashArgs): Promise<string> {
  if (typeof args.command !== "string" || args.command.trim() === "") {
    return `error: 'command' must be a non-empty string`;
  }
  const parts = parseBashArgs(args.command);
  if (parts.length === 0) return `error: command parsed to empty argv`;
  const [binary, ...rest] = parts as [string, ...string[]];

  // Allowlist + denylist gate. Deny always wins.
  if (BASH_DENY.has(binary)) {
    return `error: bash binary '${binary}' is in the denylist (super-risky: ${[...BASH_DENY].slice(0, 6).join(",")},...). Override via MCP_EXPLORE_BASH_DENYLIST if you really need it.`;
  }
  if (!BASH_ALLOW.has(binary)) {
    return `error: bash binary '${binary}' is not in the allowlist. Allowed: ${[...BASH_ALLOW].sort().join(",")}. Set MCP_EXPLORE_BASH_ALLOWLIST to broaden.`;
  }

  // Per-arg path/pattern denylist. Catches "cat /etc/passwd", "$(...)", etc.
  for (const arg of rest) {
    const violation = violatesArgPolicy(arg);
    if (violation !== null) {
      return `error: bash arg '${arg}' matches denied pattern ${violation}. (Path under /etc /usr /bin /sbin etc, network creds, or shell-substitution syntax.)`;
    }
  }

  return new Promise<string>((resolve) => {
    const child = spawn(binary, rest, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;
    let truncatedByCap = false;
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      child.kill("SIGTERM");
    }, BASH_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > BASH_OUTPUT_BYTES) {
        truncatedByCap = true;
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(`error: failed to spawn '${binary}': ${err.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const reason = killedByTimeout
        ? ` [killed after ${BASH_TIMEOUT_MS}ms timeout]`
        : truncatedByCap
          ? ` [killed at ${BASH_OUTPUT_BYTES} byte output cap]`
          : "";
      const stderrTrim = stderr.trim();
      const head = `# bash: ${binary} ${rest.join(" ")} (exit ${code ?? "?"})${reason}`;
      const body = stdout || (stderrTrim ? `[stderr only]\n${stderrTrim}` : "[no output]");
      const tail = stderrTrim && stdout ? `\n--- stderr ---\n${stderrTrim}` : "";
      resolve(truncate(`${head}\n${body}${tail}`));
    });
  });
}

// =============================================================================
// web_fetch — HTTP GET with SSRF defense. Idempotent → marked read-only so
// the loop can parallelize it with other reads. Scheme allowlist (http/https
// only), private-IP/loopback denylist, optional domain allowlist via env,
// content-type filter, size cap, hard timeout.
// =============================================================================
export type WebFetchArgs = { url: string; max_bytes?: number };

function isPrivateHost(hostname: string): boolean {
  const stripped = hostname.replace(/^\[|\]$/g, "");
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(stripped));
}

function gateWebFetchUrl(rawUrl: string): URL | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { error: `invalid url '${rawUrl}': ${(err as Error).message}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `scheme '${parsed.protocol}' not allowed (http/https only)` };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) return { error: `url has no hostname` };
  if (isPrivateHost(hostname)) {
    return {
      error: `hostname '${hostname}' resolves to private/loopback/link-local space (SSRF defense). Set MCP_EXPLORE_WEB_FETCH_DOMAINS to override for specific allowed hosts.`,
    };
  }
  if (WEB_FETCH_DOMAIN_ALLOW !== null) {
    // Allowlist match: exact OR suffix (so "example.com" allows "api.example.com")
    const ok = [...WEB_FETCH_DOMAIN_ALLOW].some(
      (d) => hostname === d || hostname.endsWith("." + d),
    );
    if (!ok) {
      return {
        error: `hostname '${hostname}' not in MCP_EXPLORE_WEB_FETCH_DOMAINS allowlist (${[...WEB_FETCH_DOMAIN_ALLOW].join(",")})`,
      };
    }
  }
  return parsed;
}

function htmlToText(html: string): string {
  // Lightweight HTML → text: strip script/style blocks, then strip tags, decode
  // a few common entities. Not a real DOM parser; good enough for read-and-cite.
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function webFetch(args: WebFetchArgs): Promise<string> {
  const cap = Math.max(
    1024,
    Math.min(args.max_bytes ?? WEB_FETCH_DEFAULT_BYTES, WEB_FETCH_MAX_BYTES),
  );
  const gated = gateWebFetchUrl(args.url);
  if (!(gated instanceof URL)) return `error: ${gated.error}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(gated.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "glm-explore/1.0 (https://github.com/anthropics/claude-code)" },
    });
    const ctype = res.headers.get("content-type") ?? "application/octet-stream";
    if (!ACCEPTED_CONTENT_TYPE_PATTERNS.some((re) => re.test(ctype))) {
      return `error: rejected content-type '${ctype}' (text/json/xml/yaml only — no binary, image, pdf)`;
    }
    // Stream-read with byte cap so we never buffer >cap+chunk
    const reader = res.body?.getReader();
    if (!reader) return `error: response has no body`;
    let received = 0;
    const chunks: Uint8Array[] = [];
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > cap) {
        truncated = true;
        try {
          reader.cancel();
        } catch {
          /* ignore */
        }
        // Keep what we have up to the cap
        const allow = cap - (received - value.byteLength);
        if (allow > 0) chunks.push(value.subarray(0, allow));
        break;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    let body = buf.toString("utf8");
    if (/^text\/html/i.test(ctype)) body = htmlToText(body);

    const head = `# fetch ${gated.toString()} (${res.status} ${res.statusText}, ${received} bytes${truncated ? ", truncated at " + cap : ""}, content-type=${ctype})`;
    return truncate(`${head}\n${body}`);
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return `error: web_fetch timed out after ${WEB_FETCH_TIMEOUT_MS}ms`;
    }
    return `error: web_fetch failed: ${(err as Error).message}`;
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// web_search — proxies to Z.ai's web_search_prime MCP endpoint via JSON-RPC.
// Reuses ZAI_API_KEY auth. Counts against the shared 1k/month MCP tool pool
// on Pro tier. Idempotent → read-only. Result count is server-side controlled
// (the upstream MCP schema rejects unknown args via additionalProperties:false).
// =============================================================================
export type WebSearchArgs = { query: string };

// Parse the MCP HTTP transport's JSON-or-SSE response into a typed object.
// Returns { json } on success or { error } on parse failure.
function parseMcpResponse(text: string): { json: unknown } | { error: string } {
  // Try direct JSON first.
  try {
    return { json: JSON.parse(text) };
  } catch {
    // SSE: lines may be "data:{...}" (no space) or "data: {...}" (with space).
    const dataLine = text.split(/\r?\n/).find((l) => /^data:\s?/.test(l));
    if (!dataLine) return { error: `not JSON or SSE: ${text.slice(0, 300)}` };
    const payload = dataLine.replace(/^data:\s?/, "");
    try {
      return { json: JSON.parse(payload) };
    } catch (err) {
      return { error: `SSE data not JSON: ${(err as Error).message}: ${payload.slice(0, 300)}` };
    }
  }
}

// Shared initialize + tools/call handshake for any Z.ai hosted MCP tool. Returns
// the tool's joined text content, or an "error: ..." string. Re-handshakes every
// call (stateless tool semantics; adds ~150-300ms). `endpointTool` is the host
// sub-path; `toolName` is the MCP tool id (they differ, e.g. web_reader/webReader).
// All Z.ai MCP tools share the ~1k/month Pro pool and reuse ZAI_API_KEY auth.
async function zaiMcpToolCall(
  label: string,
  endpointTool: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<{ text: string } | { error: string }> {
  const apiKey = process.env["ZAI_API_KEY"];
  if (!apiKey) {
    return {
      error: `error: ZAI_API_KEY not set — ${label} proxies to Z.ai's ${endpointTool} MCP endpoint and needs the same auth as the chat completions API`,
    };
  }
  const endpoint = zaiMcpEndpoint(endpointTool);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZAI_MCP_TIMEOUT_MS);
  const baseHeaders = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  try {
    const initRes = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "agentmcp-explore", version: "1.0" },
        },
      }),
    });
    if (!initRes.ok) {
      const body = (await initRes.text()).slice(0, 500);
      return { error: `error: ${label} initialize HTTP ${initRes.status}: ${body}` };
    }
    const sessionId = initRes.headers.get("mcp-session-id");
    if (!sessionId) {
      return {
        error: `error: ${label} initialize succeeded but server returned no Mcp-Session-Id header`,
      };
    }
    // Drain the init body so the connection can close cleanly.
    await initRes.text();

    const callRes = await fetch(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { ...baseHeaders, "Mcp-Session-Id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: toolArgs },
      }),
    });
    if (!callRes.ok) {
      const body = (await callRes.text()).slice(0, 500);
      return { error: `error: ${label} HTTP ${callRes.status}: ${body}` };
    }
    const parsed = parseMcpResponse(await callRes.text());
    if ("error" in parsed) return { error: `error: ${label} response ${parsed.error}` };

    type MCPResp = {
      error?: { code?: number; message?: string };
      result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
    };
    const r = parsed.json as MCPResp;
    if (r?.error) {
      return {
        error: `error: ${label} returned MCP error ${r.error.code ?? ""}: ${r.error.message ?? JSON.stringify(r.error)}`,
      };
    }
    if (r?.result?.isError) {
      const errText = r.result.content?.[0]?.text ?? JSON.stringify(r.result);
      return { error: `error: ${label} tool returned error: ${errText.slice(0, 300)}` };
    }
    const contentArr = r?.result?.content;
    if (!Array.isArray(contentArr) || contentArr.length === 0) {
      return { text: "" };
    }
    return {
      text: contentArr
        .map((c) => c?.text ?? "")
        .filter(Boolean)
        .join("\n\n"),
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { error: `error: ${label} timed out after ${ZAI_MCP_TIMEOUT_MS}ms` };
    }
    return { error: `error: ${label} failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function webSearch(args: WebSearchArgs): Promise<string> {
  if (typeof args.query !== "string" || args.query.trim() === "") {
    return `error: 'query' must be a non-empty string`;
  }
  const res = await zaiMcpToolCall("web_search", "web_search_prime", "web_search_prime", {
    search_query: args.query,
  });
  if ("error" in res) {
    return res.error;
  }
  if (!res.text) {
    return `# web_search '${args.query}'\n[no results]`;
  }

  // The Z.ai server returns a single text block whose body is itself a
  // JSON-encoded string of an array of {title, link, content, refer}. Try
  // to parse and pretty-format. If the inner shape doesn't match, fall
  // through to the raw text so we don't lose data.
  let formatted = res.text;
  try {
    const inner = JSON.parse(res.text) as unknown;
    if (typeof inner === "string") {
      const parsed = JSON.parse(inner) as Array<{
        title?: string;
        link?: string;
        content?: string;
        refer?: string;
      }>;
      if (Array.isArray(parsed)) {
        formatted = parsed
          .map((r, i) => {
            const ref = r.refer ?? `ref_${i + 1}`;
            return `[${ref}] ${r.title ?? "(untitled)"}\n  ${r.link ?? ""}\n  ${(r.content ?? "").replace(/\s+/g, " ").trim()}`;
          })
          .join("\n\n");
      }
    }
  } catch {
    // not the expected shape; keep the raw text as the body
  }
  return truncate(
    `# web_search '${args.query}' (${formatted.split("\n\n").length} results)\n${formatted}`,
  );
}

// web_reader — proxies to Z.ai's web_reader MCP (tool id `webReader`). Fetches a
// URL and returns clean, LLM-friendly markdown. Idempotent → read-only. Shares
// the same monthly MCP pool as web_search.
export type WebReaderArgs = { url: string };

export async function webReader(args: WebReaderArgs): Promise<string> {
  if (typeof args.url !== "string" || args.url.trim() === "") {
    return `error: 'url' must be a non-empty string`;
  }
  const res = await zaiMcpToolCall("web_reader", "web_reader", "webReader", { url: args.url });
  if ("error" in res) {
    return res.error;
  }
  if (!res.text) {
    return `# web_reader '${args.url}'\n[empty]`;
  }
  return truncate(`# web_reader '${args.url}'\n${res.text}`);
}

// zread — proxies to Z.ai's zread MCP: read a GitHub repo's docs/issues/commits,
// files, and structure. One tool, three operations (search_doc / read_file /
// get_repo_structure). Idempotent → read-only. Shares the monthly MCP pool.
export type ZreadArgs = {
  operation: string;
  repo_name: string;
  query?: string;
  file_path?: string;
  dir_path?: string;
  language?: string;
};

export async function zread(args: ZreadArgs): Promise<string> {
  const repo = typeof args.repo_name === "string" ? args.repo_name.trim() : "";
  if (!repo) {
    return `error: 'repo_name' must be a non-empty "owner/repo" string`;
  }

  let toolName: string;
  let toolArgs: Record<string, unknown>;
  switch (args.operation) {
    case "search_doc":
      if (typeof args.query !== "string" || args.query.trim() === "") {
        return `error: 'query' is required for operation 'search_doc'`;
      }
      toolName = "search_doc";
      toolArgs = {
        repo_name: repo,
        query: args.query,
        ...(args.language && { language: args.language }),
      };
      break;
    case "read_file":
      if (typeof args.file_path !== "string" || args.file_path.trim() === "") {
        return `error: 'file_path' is required for operation 'read_file'`;
      }
      toolName = "read_file";
      toolArgs = { repo_name: repo, file_path: args.file_path };
      break;
    case "get_repo_structure":
      toolName = "get_repo_structure";
      toolArgs = { repo_name: repo, ...(args.dir_path && { dir_path: args.dir_path }) };
      break;
    default:
      return `error: 'operation' must be one of: search_doc, read_file, get_repo_structure`;
  }

  const res = await zaiMcpToolCall("zread", "zread", toolName, toolArgs);
  if ("error" in res) {
    return res.error;
  }
  if (!res.text) {
    return `# zread ${args.operation} ${repo}\n[empty]`;
  }
  return truncate(`# zread ${args.operation} ${repo}\n${res.text}`);
}

// =============================================================================
// notebook_edit — Jupyter (.ipynb) cell-aware ops. Single tool with 4 operations
// (read / replace / insert / delete). Read uses the READ allowlist; write ops
// use the WRITE allowlist. new_source caps at MAX_WRITE_BYTES per cell. JSON
// shape validated; cells normalized so source-as-array and source-as-string
// both work on read. On replace, outputs + execution_count are cleared since
// the source changed (matches native NotebookEdit semantics).
// =============================================================================
type NotebookCell = {
  cell_type?: string;
  source?: string | string[];
  outputs?: unknown[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
};
type Notebook = {
  cells?: NotebookCell[];
  metadata?: { kernelspec?: { name?: string } };
  nbformat?: number;
  nbformat_minor?: number;
};

export type NotebookEditArgs = {
  path: string;
  operation: "read" | "replace" | "insert" | "delete";
  cell_index?: number;
  cell_type?: "code" | "markdown";
  new_source?: string;
};

function cellSourceToString(src: string | string[] | undefined): string {
  if (Array.isArray(src)) return src.join("");
  return src ?? "";
}

export async function notebookEdit(args: NotebookEditArgs): Promise<string> {
  const isWrite = args.operation !== "read";
  const gated = isWrite ? gateAbsForWrite(args.path, "path") : gateAbs(args.path, "path");
  if (typeof gated !== "string") return `error: ${gated.error}`;

  let raw: string;
  try {
    raw = await fs.readFile(gated, "utf8");
  } catch (err) {
    return `error: failed to read notebook '${gated}': ${(err as Error).message}`;
  }
  let nb: Notebook;
  try {
    nb = JSON.parse(raw) as Notebook;
  } catch (err) {
    return `error: notebook '${gated}' is not valid JSON: ${(err as Error).message}`;
  }
  if (!Array.isArray(nb.cells)) {
    return `error: notebook '${gated}' has no 'cells' array (not a Jupyter notebook?)`;
  }
  const cells = nb.cells;
  const kernel = nb.metadata?.kernelspec?.name ?? "unknown";

  switch (args.operation) {
    case "read": {
      if (args.cell_index !== undefined) {
        const i = args.cell_index;
        if (!Number.isInteger(i) || i < 0 || i >= cells.length) {
          return `error: cell_index ${i} out of range (notebook has ${cells.length} cells)`;
        }
        const cell = cells[i]!;
        const src = cellSourceToString(cell.source);
        return truncate(`# ${gated}[${i}] ${cell.cell_type ?? "?"} (kernel: ${kernel})\n${src}`);
      }
      const lines: string[] = [
        `# notebook ${gated} (${cells.length} cells, kernel: ${kernel}, nbformat ${nb.nbformat ?? "?"}.${nb.nbformat_minor ?? "?"})`,
      ];
      cells.forEach((cell, i) => {
        const src = cellSourceToString(cell.source);
        const lineCount = src === "" ? 0 : src.split("\n").length;
        const preview = src
          .split("\n")
          .slice(0, 3)
          .map((l) => `    ${l}`)
          .join("\n");
        lines.push(
          `[${i}] ${cell.cell_type ?? "?"} (${lineCount} line${lineCount === 1 ? "" : "s"})`,
        );
        if (preview) lines.push(preview);
      });
      return truncate(lines.join("\n"));
    }
    case "replace": {
      if (args.cell_index === undefined) return `error: 'replace' requires cell_index`;
      if (args.new_source === undefined) return `error: 'replace' requires new_source`;
      const i = args.cell_index;
      if (!Number.isInteger(i) || i < 0 || i >= cells.length) {
        return `error: cell_index ${i} out of range (notebook has ${cells.length} cells)`;
      }
      const bytes = Buffer.byteLength(args.new_source, "utf8");
      if (bytes > MAX_WRITE_BYTES) {
        return `error: new_source is ${bytes} bytes, exceeds MAX_WRITE_BYTES (${MAX_WRITE_BYTES}) for a single cell`;
      }
      const cell = cells[i]!;
      cell.source = args.new_source;
      if (cell.cell_type === "code") {
        cell.execution_count = null;
        cell.outputs = [];
      }
      try {
        await fs.writeFile(gated, JSON.stringify(nb, null, 1) + "\n", "utf8");
      } catch (err) {
        return `error: failed to write notebook: ${(err as Error).message}`;
      }
      return `# replaced cell ${i} of ${gated} (${bytes} bytes; outputs cleared if code cell)\n[ok]`;
    }
    case "insert": {
      if (args.cell_index === undefined)
        return `error: 'insert' requires cell_index (insert position; 0 = top, ${cells.length} = bottom)`;
      if (args.cell_type !== "code" && args.cell_type !== "markdown") {
        return `error: 'insert' requires cell_type ('code' or 'markdown')`;
      }
      if (args.new_source === undefined) return `error: 'insert' requires new_source`;
      const i = args.cell_index;
      if (!Number.isInteger(i) || i < 0 || i > cells.length) {
        return `error: cell_index ${i} out of range (insert position must be 0..${cells.length})`;
      }
      const bytes = Buffer.byteLength(args.new_source, "utf8");
      if (bytes > MAX_WRITE_BYTES) {
        return `error: new_source is ${bytes} bytes, exceeds MAX_WRITE_BYTES (${MAX_WRITE_BYTES}) for a single cell`;
      }
      const newCell: NotebookCell = {
        cell_type: args.cell_type,
        source: args.new_source,
        metadata: {},
      };
      if (args.cell_type === "code") {
        newCell.execution_count = null;
        newCell.outputs = [];
      }
      cells.splice(i, 0, newCell);
      try {
        await fs.writeFile(gated, JSON.stringify(nb, null, 1) + "\n", "utf8");
      } catch (err) {
        return `error: failed to write notebook: ${(err as Error).message}`;
      }
      return `# inserted ${args.cell_type} cell at index ${i} of ${gated} (${bytes} bytes); notebook now has ${cells.length} cells\n[ok]`;
    }
    case "delete": {
      if (args.cell_index === undefined) return `error: 'delete' requires cell_index`;
      const i = args.cell_index;
      if (!Number.isInteger(i) || i < 0 || i >= cells.length) {
        return `error: cell_index ${i} out of range (notebook has ${cells.length} cells)`;
      }
      const removed = cells.splice(i, 1)[0];
      const removedType = removed?.cell_type ?? "?";
      try {
        await fs.writeFile(gated, JSON.stringify(nb, null, 1) + "\n", "utf8");
      } catch (err) {
        return `error: failed to write notebook: ${(err as Error).message}`;
      }
      return `# deleted cell ${i} (was ${removedType}) of ${gated}; notebook now has ${cells.length} cells\n[ok]`;
    }
    default:
      return `error: unknown operation '${args.operation}' (use read | replace | insert | delete)`;
  }
}

// =============================================================================
// OpenAI tool definitions sent to GLM. Names match the executors below.
// =============================================================================
export const EXPLORE_TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description:
        "List the contents of a directory. Returns lines of '<type>\\t<size>\\t<name>' where type is f|d|l (file/dir/symlink). Use to discover what's in a directory before reading specific files.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the directory. Must be inside an allowed root.",
          },
          max_entries: {
            type: "number",
            description: "Cap on entries returned (default 100, max 500).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read a file's contents (or a line range). Capped at 200KB. Use start_line/end_line (1-indexed, inclusive) to read a slice with line numbers prefixed.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file. Must be inside an allowed root.",
          },
          start_line: { type: "number", description: "1-indexed start line (optional)." },
          end_line: { type: "number", description: "1-indexed end line, inclusive (optional)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "glob",
      description:
        "Find files matching a glob pattern under a directory. Pattern uses standard globs: '*' matches one segment, '**' is recursive. Example: pattern='**/*.ts' to find all TypeScript files.",
      parameters: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description: "Absolute path to the search root. Must be inside an allowed root.",
          },
          pattern: { type: "string", description: "Glob pattern, relative to root." },
          max_results: {
            type: "number",
            description: "Cap on results (default 50, max 500).",
          },
        },
        required: ["root", "pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep",
      description:
        "Search file contents under a directory for a regex. Returns 'path:line:text' hits. Excludes node_modules and .git. Use 'include' to narrow by filename pattern (e.g. '*.ts').",
      parameters: {
        type: "object",
        properties: {
          root: {
            type: "string",
            description: "Absolute path to the search root. Must be inside an allowed root.",
          },
          pattern: { type: "string", description: "Regex pattern (POSIX extended)." },
          max_matches: {
            type: "number",
            description: "Cap on matches (default 50, max 500).",
          },
          ignore_case: { type: "boolean", description: "Case-insensitive match." },
          include: {
            type: "string",
            description: "Filename pattern to restrict search (e.g. '*.ts').",
          },
        },
        required: ["root", "pattern"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Write a file. By default creates new or overwrites existing; pass append:true to add to the end of an existing file (also creates the file if missing). UTF-8 only, capped at 100KB per call (the cap applies to the chunk being written/appended, not the full file size — split big appends across multiple calls). Path must be inside the WRITE allowed roots (defaults to /tmp). Parent dirs auto-created by default. Use append for accumulating logs, building output across iterations, or extending a file you don't want to re-serialize. The loop runs write batches sequentially.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute path to the target file. Must be inside a write-allowed root (default /tmp).",
          },
          content: {
            type: "string",
            description: "UTF-8 content to write or append. Capped at 100KB per call.",
          },
          create_parents: {
            type: "boolean",
            description:
              "Create missing parent directories (default true). Set false to fail on missing parent.",
          },
          append: {
            type: "boolean",
            description:
              "If true, append to the end of the file instead of overwriting (creates the file if missing). Default false. No trailing newline is added — control line endings via your content.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_files",
      description:
        "Batch variant of write_file — write up to 20 files in one tool call. Each file is gated independently against the WRITE allowlist; partial success is reported per file (✓/✗ lines). Use when a code-mod touches multiple files at once (rename across N files, generate a small project). Each file still capped at 100KB. The whole batch runs sequentially internally.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            description:
              "List of files to write. Up to 20 entries. Per-entry append flag lets a single batch mix overwrites and appends.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "Absolute path. Must be inside a write-allowed root (default /tmp).",
                },
                content: {
                  type: "string",
                  description: "UTF-8 content. Capped at 100KB per file.",
                },
                create_parents: {
                  type: "boolean",
                  description: "Create missing parent directories (default true).",
                },
                append: {
                  type: "boolean",
                  description: "If true, append to file instead of overwriting (default false).",
                },
              },
              required: ["path", "content"],
            },
          },
        },
        required: ["files"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_fetch",
      description:
        "HTTP GET a URL and return its body (stripped to text for HTML). Idempotent — runs in parallel with other reads. Scheme allowlist (http/https only); private IP / loopback / link-local / RFC1918 hosts blocked (SSRF defense). Optional domain allowlist via MCP_EXPLORE_WEB_FETCH_DOMAINS env var (suffix match). Content-type filter (text/json/xml/yaml only — no binary, image, pdf). Body capped at 200KB by default (max 1MB). 30s timeout. Use to read documentation pages, fetch JSON APIs, or pull public source files cited in a task.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute http:// or https:// URL. Hostname must not be private/loopback.",
          },
          max_bytes: {
            type: "number",
            description: "Cap on body bytes (default 200000, max 1048576).",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description:
        "Search the web via Z.ai's web_search_prime endpoint. Idempotent — runs in parallel. Reuses ZAI_API_KEY auth. Result count is server-side (typically ~5-10). NOTE: counts against your shared MCP-tool monthly quota on the Coding Plan (~1,000 calls/month on Pro tier, pooled across web_search/web_reader/zread). Use sparingly for queries that genuinely need fresh web info. 30s timeout. Keep query under 70 chars for best results.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (recommended <70 chars)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_reader",
      description:
        "Fetch a URL and return clean, LLM-friendly markdown via Z.ai's web_reader endpoint. Idempotent — runs in parallel. Reuses ZAI_API_KEY auth. Prefer this over web_fetch for content-heavy pages (docs, articles) where you want readable markdown instead of raw HTML/text. NOTE: shares the same ~1,000/month MCP-tool pool as web_search/zread. 30s timeout.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http:// or https:// URL to read." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "zread",
      description:
        "Explore a GitHub repository via Z.ai's zread endpoint. Idempotent — runs in parallel. Reuses ZAI_API_KEY auth. Operations: 'search_doc' (search docs/issues/commits — needs query), 'read_file' (full file content — needs file_path), 'get_repo_structure' (directory tree — optional dir_path). Use for understanding third-party GitHub repos cited in a task. NOTE: shares the same ~1,000/month MCP-tool pool as web_search/web_reader. 30s timeout.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["search_doc", "read_file", "get_repo_structure"],
            description: "Which zread operation to run.",
          },
          repo_name: {
            type: "string",
            description: 'GitHub repository as "owner/repo" (e.g. "vitejs/vite"). Required.',
          },
          query: {
            type: "string",
            description: "Search keywords/question. Required for 'search_doc'.",
          },
          file_path: {
            type: "string",
            description: "Relative file path (e.g. \"src/index.ts\"). Required for 'read_file'.",
          },
          dir_path: {
            type: "string",
            description: "Directory to inspect (default root). Optional for 'get_repo_structure'.",
          },
          language: {
            type: "string",
            description: "'zh' or 'en'. Optional for 'search_doc'.",
          },
        },
        required: ["operation", "repo_name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "notebook_edit",
      description:
        "Cell-aware operations on Jupyter notebooks (.ipynb). Operations: 'read' (whole-notebook listing or single cell), 'replace' (overwrite a cell's source), 'insert' (add new cell at index), 'delete' (remove cell). Read uses the READ allowlist; mutating ops use the WRITE allowlist (default /tmp). Replacing a code cell's source clears its outputs + execution_count (matches native NotebookEdit). Each cell's new_source capped at 100KB. The whole notebook is rewritten on every mutation — atomic but not concurrency-safe; the dispatch runs notebook_edit calls sequentially.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute path to the .ipynb file. Must be inside the appropriate allowed root (READ for read op, WRITE for mutating ops).",
          },
          operation: {
            type: "string",
            enum: ["read", "replace", "insert", "delete"],
            description: "Which op to perform.",
          },
          cell_index: {
            type: "number",
            description:
              "Cell index. Required for replace/insert/delete. Optional for read (omit to list whole notebook). For insert: 0 = top, N = bottom of N-cell notebook.",
          },
          cell_type: {
            type: "string",
            enum: ["code", "markdown"],
            description: "Cell type. Required only for insert.",
          },
          new_source: {
            type: "string",
            description: "New cell content. Required for replace and insert. Capped at 100KB.",
          },
        },
        required: ["path", "operation"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bash",
      description:
        "Run a single shell command. NOT a real shell: shell:false direct spawn — no pipes, redirects, command substitution ($(...) / backticks), or sequencing (; && ||). Args are split on whitespace; quote substrings to keep them together. Binary must be on the allowlist (default ~25 read-only/diagnostic: ls, cat, head, tail, find, grep, git, bun, node, npm, tsc, jest, etc.) and not on the denylist (rm, sudo, dd, ssh, curl, etc.). Per-arg policy denies paths under /etc /usr /bin /sbin /System /Library, network creds (.ssh, .aws, .gnupg, id_rsa, .env), and shell-substitution syntax. Output capped at 200KB; hard timeout 30s. For chained ops, sequence multiple bash calls.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The command to run. Example: 'git status' or 'tsc --noEmit' or 'find /tmp/scratch -name *.ts'.",
          },
        },
        required: ["command"],
      },
    },
  },
] as const;

// Tuple form (not just a union type) so callers can build `z.enum(...)` from
// the same source of truth without duplicating the strings. Order matches
// EXPLORE_TOOL_DEFS above.
export const EXPLORE_TOOL_NAMES = [
  "list_dir",
  "read_file",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "web_reader",
  "zread",
  "write_file",
  "write_files",
  "notebook_edit",
  "bash",
] as const;
export type ExploreToolName = (typeof EXPLORE_TOOL_NAMES)[number];

// Read-only tool annotation (mirrors native Claude Code's `readOnlyHint`).
// Read-only tools can run concurrently within a turn; mutating tools must
// run sequentially to avoid clobbering each other. web_fetch, web_search,
// web_reader, and zread are read-only by virtue of being idempotent (HTTP GET /
// search / read) — they parallelize with the fs reads. write_file, write_files,
// and bash are excluded — any batch containing them falls back to sequential
// dispatch.
export const READONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_dir",
  "read_file",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "web_reader",
  "zread",
]);

export function isReadOnlyTool(name: string): boolean {
  return READONLY_TOOL_NAMES.has(name);
}

export async function executeExploreTool(name: string, rawArgs: unknown): Promise<string> {
  if (typeof rawArgs !== "object" || rawArgs === null) {
    return `error: tool args must be an object, got ${typeof rawArgs}`;
  }
  const args = rawArgs as Record<string, unknown>;
  try {
    switch (name) {
      case "list_dir":
        return await listDir(args as ListDirArgs);
      case "read_file":
        return await readFile(args as ReadFileArgs);
      case "glob":
        return await globSearch(args as GlobArgs);
      case "grep":
        return await grepSearch(args as GrepArgs);
      case "write_file":
        return await writeFile(args as WriteFileArgs);
      case "write_files":
        return await writeFiles(args as WriteFilesArgs);
      case "bash":
        return await bash(args as BashArgs);
      case "web_fetch":
        return await webFetch(args as WebFetchArgs);
      case "web_search":
        return await webSearch(args as WebSearchArgs);
      case "web_reader":
        return await webReader(args as WebReaderArgs);
      case "zread":
        return await zread(args as ZreadArgs);
      case "notebook_edit":
        return await notebookEdit(args as NotebookEditArgs);
      default:
        return `error: unknown tool '${name}'`;
    }
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}
