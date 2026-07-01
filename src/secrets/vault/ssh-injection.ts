import fs from "node:fs";
/**
 * SSH command detection and rewriting engine for the egress vault.
 *
 * The runtime calls `detectSshTarget` on every command string about to be
 * spawned. When it recognizes an SSH-family command (ssh, scp, rsync, sftp)
 * targeting a vault-allowlisted host, it rewrites the command to inject the
 * stored credential — a private key via a temp file, or a password via
 * `sshpass -e`. The agent never sees the secret material.
 */
import os from "node:os";
import path from "node:path";
import type { VaultApprovalPolicy, VaultGrantDecision, VaultSecretEntry } from "./store.js";
import { hostMatchesAllowlist } from "./store.js";

// ── Types ──────────────────────────────────────────────────────────────────

export type SshTool = "ssh" | "scp" | "rsync" | "sftp";

export type SshDetectedTarget = {
  tool: SshTool;
  host: string;
  username?: string;
  port?: number;
};

export type SshCredential = {
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  port?: number;
};

export type SshInjectionResult = {
  rewrittenCommand: string;
  extraEnv?: Record<string, string>;
  tempFiles?: string[];
  /**
   * Set when injection could not proceed safely (e.g. sshpass is required for
   * password/passphrase auth but is not installed). The command is returned
   * unchanged so the caller can surface the reason instead of spawning a
   * rewritten command that would hang on a prompt or fail cryptically.
   */
  skipped?: { reason: "sshpass-missing" };
};

// ── Detection ──────────────────────────────────────────────────────────────

const SSH_TOOLS = new Set(["ssh", "scp", "rsync", "sftp"]);

/**
 * Tokenize a shell command string, respecting simple double-quoted and
 * single-quoted segments. This is NOT a full shell parser — it handles the
 * common cases of `ssh -p 2222 user@host "ls -la"` etc.
 */
function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t" || ch === "\n") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/** Extract the binary name from a path-like token (e.g. `/usr/bin/ssh` → `ssh`). */
function baseName(token: string): string {
  // Handle both / and \ for path separators (though \ is uncommon on POSIX).
  const slashIndex = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  return slashIndex >= 0 ? token.slice(slashIndex + 1) : token;
}

/**
 * Parse a `[user@]host[:port]` or `host::module` (rsync) or `user@host:path`
 * spec into its components.
 */
function parseRemoteSpec(spec: string): {
  host: string;
  username?: string;
  port?: number;
  path?: string;
} {
  let rest = spec;
  let username: string | undefined;
  // Extract username before '@'
  const atIdx = rest.indexOf("@");
  if (atIdx >= 0) {
    username = rest.slice(0, atIdx);
    rest = rest.slice(atIdx + 1);
  }
  // For rsync daemon mode (host::module), extract host before ::
  const doubleColon = rest.indexOf("::");
  if (doubleColon >= 0) {
    const host = rest.slice(0, doubleColon);
    const rsyncPath = rest.slice(doubleColon + 2);
    return { host, username, path: rsyncPath };
  }
  // Extract host before the first ':' that starts a path (not a port for ssh-style).
  // For scp/rsync, `host:path` means remote path; for ssh, there's no colon in the host part.
  // We need to handle `host:port` only for ssh -p style which is separate.
  // Here we just want the hostname. The colon could start a remote path.
  const colonIdx = rest.indexOf(":");
  let host: string;
  let remotePath: string | undefined;
  if (colonIdx >= 0) {
    host = rest.slice(0, colonIdx);
    remotePath = rest.slice(colonIdx + 1);
  } else {
    host = rest;
  }
  return { host, username, path: remotePath };
}

/**
 * Detect if a command is SSH-family and extract the target host.
 * Returns null for non-SSH commands.
 */
export function detectSshTarget(command: string): SshDetectedTarget | null {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) {
    return null;
  }
  const tool = baseName(tokens[0]);
  if (!SSH_TOOLS.has(tool)) {
    return null;
  }

  switch (tool) {
    case "ssh":
      return detectSsh(tokens.slice(1));
    case "scp":
      return detectScp(tokens.slice(1));
    case "rsync":
      return detectRsync(tokens.slice(1));
    case "sftp":
      return detectSftp(tokens.slice(1));
    default:
      return null;
  }
}

/** Parse `ssh` args to find the target host. */
function detectSsh(args: string[]): SshDetectedTarget | null {
  let host: string | undefined;
  let username: string | undefined;
  let port: number | undefined;
  let seenDashDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seenDashDash) {
      // After --, the next token is the host target
      if (!arg.startsWith("-")) {
        const parsed = parseRemoteSpec(arg);
        if (parsed.host) {
          host = parsed.host;
          username = parsed.username;
        }
      }
      continue;
    }
    if (arg === "--") {
      seenDashDash = true;
      continue;
    }
    if (arg === "-p" && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
      continue;
    }
    if (arg.startsWith("-p") && arg.length > 2) {
      port = parseInt(arg.slice(2), 10);
      continue;
    }
    // Options like -o, -l, -i take a value
    if ((arg === "-o" || arg === "-l" || arg === "-i" || arg === "-F") && i + 1 < args.length) {
      i++; // skip the value
      continue;
    }
    // -L, -R, -D, -W take a value (sometimes combined)
    if (
      [
        "-L",
        "-R",
        "-D",
        "-W",
        "-b",
        "-B",
        "-E",
        "-e",
        "-m",
        "-O",
        "-Q",
        "-q",
        "-v",
        "-V",
        "-a",
        "-x",
        "-X",
        "-Y",
        "-y",
        "-g",
        "-f",
        "-n",
        "-N",
        "-T",
        "-t",
        "-4",
        "-6",
        "-A",
        "-a",
        "-C",
        "-K",
        "-k",
        "-s",
      ].includes(arg)
    ) {
      // Some of these take values, some don't. For our purpose (finding host),
      // we just skip flags. The host is the first non-flag arg.
      // -L, -R, -D, -W, -b, -O, -Q take values, -e, -m, -i take values too (already handled above for -i)
      if (["-L", "-R", "-D", "-W", "-b", "-O", "-Q"].includes(arg) && i + 1 < args.length) {
        i++; // skip value
      }
      continue;
    }
    if (arg.startsWith("-")) {
      // Unknown flag, skip (but check if it takes a value by looking at next token)
      continue;
    }
    // First non-flag token is [user@]host
    const parsed = parseRemoteSpec(arg);
    if (parsed.host) {
      host = parsed.host;
      username = parsed.username;
      break; // rest is the remote command
    }
  }

  if (!host) {
    return null;
  }
  const result: SshDetectedTarget = { tool: "ssh", host };
  if (username) result.username = username;
  if (port !== undefined && !Number.isNaN(port)) result.port = port;
  return result;
}

/** Parse `scp` args — either source or dest can be the remote host. */
function detectScp(args: string[]): SshDetectedTarget | null {
  let port: number | undefined;
  const remoteCandidates: string[] = [];
  let seenDashDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seenDashDash) {
      // After --, args are paths (some could still be remote in scp)
      if (arg.includes(":") || arg.includes("@")) {
        remoteCandidates.push(arg);
      }
      continue;
    }
    if (arg === "--") {
      seenDashDash = true;
      continue;
    }
    if (arg === "-P" && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
      continue;
    }
    if (arg.startsWith("-P") && arg.length > 2) {
      port = parseInt(arg.slice(2), 10);
      continue;
    }
    if (arg === "-p") {
      // -p preserves timestamps — NOT a port flag for scp
      continue;
    }
    if (arg === "-i" && i + 1 < args.length) {
      i++; // skip identity file
      continue;
    }
    if (arg === "-o" && i + 1 < args.length) {
      i++; // skip option value
      continue;
    }
    if (arg === "-S" && i + 1 < args.length) {
      i++; // skip ssh program path
      continue;
    }
    if (arg.startsWith("-")) {
      // Combined flags like -rv or -rvc
      continue;
    }
    // This is a file/path argument — check if it looks like a remote spec.
    // SCP remote specs must contain `:` (host:path) or `@` (user@host).
    // A plain filename without these is a local path, not a remote.
    if (arg.includes(":") || arg.includes("@")) {
      remoteCandidates.push(arg);
    }
  }

  // Parse the first valid remote candidate
  for (const candidate of remoteCandidates) {
    const parsed = parseRemoteSpec(candidate);
    if (parsed.host && parsed.host !== "." && parsed.host !== "..") {
      const result: SshDetectedTarget = { tool: "scp", host: parsed.host };
      if (parsed.username) result.username = parsed.username;
      if (port !== undefined && !Number.isNaN(port)) result.port = port;
      return result;
    }
  }
  return null;
}

/** Parse `rsync` args. */
function detectRsync(args: string[]): SshDetectedTarget | null {
  let port: number | undefined;
  let username: string | undefined;
  let host: string | undefined;
  let seenDashDash = false;
  const pathArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seenDashDash) {
      pathArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      seenDashDash = true;
      continue;
    }
    // --rsh="ssh -p 2222" or -e "ssh -p 2222"
    if ((arg === "-e" || arg === "--rsh") && i + 1 < args.length) {
      const rshValue = args[i + 1];
      // Try to extract port from the rsh value
      const portMatch = rshValue.match(/-p\s+(\d+)/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }
      i++;
      continue;
    }
    if (arg.startsWith("-e") && arg.length > 2) {
      // -essh or -e "ssh ..."
      const rshValue = arg.slice(2);
      const portMatch = rshValue.match(/-p\s+(\d+)/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }
      continue;
    }
    if (arg.startsWith("--rsh=")) {
      const rshValue = arg.slice("--rsh=".length).replace(/^["']|["']$/g, "");
      const portMatch = rshValue.match(/-p\s+(\d+)/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }
      continue;
    }
    if (arg === "--port" && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parseInt(arg.slice("--port=".length), 10);
      continue;
    }
    // Long options that take values
    if (arg.startsWith("--") && arg.includes("=")) {
      continue; // --option=value
    }
    if (arg.startsWith("--") && i + 1 < args.length && !args[i + 1].startsWith("-")) {
      // Some long options take a value; but for host detection, the path args
      // are the non-flag ones. We'll be conservative and only skip known value-taking options.
      if (
        [
          "--suffix",
          "--backup-dir",
          "--partial-dir",
          "--include",
          "--exclude",
          "--filter",
          "--files-from",
          "--include-from",
          "--copy-links",
          "--password-file",
          "--socks-options",
          "--bwlimit",
        ].includes(arg)
      ) {
        i++;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    // Path argument — could contain a remote host
    pathArgs.push(arg);
  }

  // Check path args for remote specs
  for (const pArg of pathArgs) {
    // rsync daemon mode: host::module/path
    if (pArg.includes("::")) {
      const beforeColon = pArg.split("::")[0];
      const parsed = parseRemoteSpec(beforeColon);
      if (parsed.host) {
        host = parsed.host;
        username = parsed.username;
        break;
      }
    }
    // ssh mode: [user@]host:path
    const colonIdx = pArg.indexOf(":");
    const atIdx = pArg.indexOf("@");
    if (colonIdx >= 0 || atIdx >= 0) {
      // It might be a remote spec
      const parsed = parseRemoteSpec(pArg);
      if (parsed.host && parsed.host !== "." && parsed.host !== "..") {
        host = parsed.host;
        username = parsed.username;
        break;
      }
    }
  }

  if (!host) {
    return null;
  }
  const result: SshDetectedTarget = { tool: "rsync", host };
  if (username) result.username = username;
  if (port !== undefined && !Number.isNaN(port)) result.port = port;
  return result;
}

/** Parse `sftp` args. */
function detectSftp(args: string[]): SshDetectedTarget | null {
  let host: string | undefined;
  let username: string | undefined;
  let port: number | undefined;
  let seenDashDash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seenDashDash) {
      if (!arg.startsWith("-")) {
        const parsed = parseRemoteSpec(arg);
        if (parsed.host) {
          host = parsed.host;
          username = parsed.username;
        }
      }
      continue;
    }
    if (arg === "--") {
      seenDashDash = true;
      continue;
    }
    if (arg === "-P" && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
      continue;
    }
    // For sftp, `-p` means preserve times (a valueless flag); only `-P` is the
    // port. Consuming the next token as its value used to swallow the host and
    // drop detection entirely.
    if (arg === "-p") {
      continue;
    }
    if (arg === "-i" && i + 1 < args.length) {
      i++; // skip identity file
      continue;
    }
    if (arg === "-o" && i + 1 < args.length) {
      i++; // skip option value
      continue;
    }
    if (arg === "-S" && i + 1 < args.length) {
      i++; // skip ssh program path
      continue;
    }
    if (arg === "-b" && i + 1 < args.length) {
      i++; // skip batch file
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    // First non-flag token is [user@]host
    const parsed = parseRemoteSpec(arg);
    if (parsed.host) {
      host = parsed.host;
      username = parsed.username;
      break;
    }
  }

  if (!host) {
    return null;
  }
  const result: SshDetectedTarget = { tool: "sftp", host };
  if (username) result.username = username;
  if (port !== undefined && !Number.isNaN(port)) result.port = port;
  return result;
}

// ── Matching ───────────────────────────────────────────────────────────────

/**
 * Check if a vault SSH entry matches a detected target.
 * Returns the first matching entry or undefined.
 */
export function matchSshVaultEntry(
  target: { host: string },
  entries: VaultSecretEntry[],
): VaultSecretEntry | undefined {
  return entries.find(
    (entry) => entry.authKind === "ssh" && hostMatchesAllowlist(target.host, entry.hostAllowlist),
  );
}

/**
 * Detect an SSH target to inject vault credentials for, unless the exec is
 * sandboxed. Sandboxed execs cannot see the private-key temp file (written to
 * the host tmpdir) and must not receive SSHPASS in their env, so vault injection
 * is disabled for them entirely — the command runs with the agent's own creds.
 */
export function detectSshInjectionTarget(
  command: string,
  // `sandbox` is the caller's resolved sandbox config (a truthy object) or
  // undefined for a host exec. Typed as `unknown` and coerced here so a caller
  // cannot accidentally pass a mis-narrowed value (e.g. `config === true`, which
  // is always false for an object) and silently defeat the guard.
  opts: { sandbox?: unknown },
): SshDetectedTarget | null {
  if (opts.sandbox) {
    return null;
  }
  return detectSshTarget(command);
}

/**
 * Fail-closed approval gate for SSH vault injection, mirroring the HTTP vault
 * path. The exec runtime has no interactive approval channel, so a credential is
 * injected only under an "auto" policy or a persisted allow-always grant, and
 * never over a "deny" grant — an "ask" policy without a standing grant declines.
 */
export function isSshVaultInjectionAllowed(params: {
  approvalPolicy: VaultApprovalPolicy;
  grant: VaultGrantDecision | undefined;
}): boolean {
  const { approvalPolicy, grant } = params;
  return grant !== "deny" && (approvalPolicy === "auto" || grant === "allow-always");
}

// ── Rewriting ──────────────────────────────────────────────────────────────

/** Write a private key to a temp file with 0600 permissions. */
function writeKeyTempFile(privateKey: string): string {
  const tmpDir = os.tmpdir();
  const randomName = `openclaw-ssh-key-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const keyPath = path.join(tmpDir, randomName);
  // Ensure the key ends with a newline
  const content = privateKey.endsWith("\n") ? privateKey : privateKey + "\n";
  fs.writeFileSync(keyPath, content, { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(keyPath, 0o600);
  }
  return keyPath;
}

/**
 * Check if `sshpass` is available. Password auth and passphrase-protected keys
 * both feed their secret through sshpass, so injectSshCredential probes this
 * before rewriting and declines injection when it is missing. The result is
 * process-stable, so cache the first probe.
 */
let sshpassAvailableCache: boolean | undefined;
export function isSshpassAvailable(): boolean {
  if (sshpassAvailableCache === undefined) {
    try {
      const { execSync } = require("node:child_process");
      execSync("sshpass -V", { stdio: "ignore", timeout: 5000 });
      sshpassAvailableCache = true;
    } catch {
      sshpassAvailableCache = false;
    }
  }
  return sshpassAvailableCache;
}

/**
 * Rewrite an SSH-family command with injected credentials.
 *
 * - **Private key**: Write PEM to a temp file (0600), inject `-i <tempfile>`.
 * - **Password**: Wrap with `sshpass -e` and set `SSHPASS` env var.
 * - **Username**: If vault has a username and command doesn't include `user@`, prepend.
 * - **Port**: If vault has a port and command doesn't include `-p`/`-P`, add it.
 * - **Anti-hang options**: Add StrictHostKeyChecking=accept-new + BatchMode for key auth.
 */
export function injectSshCredential(params: {
  command: string;
  detected: SshDetectedTarget;
  credential: SshCredential;
  env: NodeJS.ProcessEnv;
  /** Test seam; defaults to a live `sshpass -V` probe. */
  sshpassAvailable?: boolean;
}): SshInjectionResult {
  const { command, detected, credential } = params;
  const usePrivateKey = !!credential.privateKey;
  const usePassword = !usePrivateKey && !!credential.password;
  const usePassphrase = usePrivateKey && !!credential.passphrase;
  // Password auth and passphrase-protected keys both hand their secret to
  // sshpass. Without it, the rewritten command would block on an interactive
  // prompt (or fail obscurely), so decline injection and report why rather than
  // ship a broken command.
  const needsSshpass = usePassword || usePassphrase;
  const sshpassAvailable = params.sshpassAvailable ?? isSshpassAvailable();
  if (needsSshpass && !sshpassAvailable) {
    return { rewrittenCommand: command, skipped: { reason: "sshpass-missing" } };
  }

  const extraEnv: Record<string, string> = {};
  const tempFiles: string[] = [];

  // ssh `-o` options applied to every tool. BatchMode is safe only for a bare
  // key: with a passphrase, sshpass must answer the prompt that BatchMode would
  // otherwise suppress; for password auth sshpass provides the password.
  const options: Array<[string, string]> = [["-o", "StrictHostKeyChecking=accept-new"]];
  if (usePrivateKey && !usePassphrase) {
    options.push(["-o", "BatchMode=yes"]);
  }

  let keyPath: string | undefined;
  if (usePrivateKey && credential.privateKey) {
    keyPath = writeKeyTempFile(credential.privateKey);
    tempFiles.push(keyPath);
  }

  const injectPort = credential.port !== undefined && detected.port === undefined;
  let rewrittenCommand: string;

  if (detected.tool === "rsync") {
    // rsync rejects ssh flags (`-i`, `-o`, `-p`, BatchMode) on its own argv —
    // they belong inside the remote-shell command (`-e`/`--rsh`). Build one rsh
    // string and merge it into any existing `-e`.
    const rshArgs: string[] = [];
    if (keyPath) {
      rshArgs.push("-i", keyPath);
    }
    if (injectPort) {
      rshArgs.push("-p", String(credential.port));
    }
    for (const [flag, value] of options) {
      rshArgs.push(flag, value);
    }
    const sshpassPrefix = needsSshpass ? `${sshpassCommand(usePassphrase)} ` : "";
    rewrittenCommand = injectRsyncRsh(command, rshArgs.join(" "), sshpassPrefix);
    if (credential.username && !detected.username) {
      rewrittenCommand = injectUsername(rewrittenCommand, detected, credential.username);
    }
  } else {
    rewrittenCommand = command;
    if (keyPath) {
      rewrittenCommand = injectFlag(rewrittenCommand, "-i", keyPath);
    }
    if (injectPort) {
      // scp/sftp use `-P` for the port; ssh uses `-p`.
      const portFlag = detected.tool === "ssh" ? "-p" : "-P";
      rewrittenCommand = injectFlag(rewrittenCommand, portFlag, String(credential.port));
    }
    if (credential.username && !detected.username) {
      rewrittenCommand = injectUsername(rewrittenCommand, detected, credential.username);
    }
    for (const [flag, value] of options) {
      rewrittenCommand = injectOption(rewrittenCommand, flag, value);
    }
    if (needsSshpass) {
      rewrittenCommand = `${sshpassCommand(usePassphrase)} ${rewrittenCommand}`;
    }
  }

  if (needsSshpass) {
    // The secret rides in SSHPASS (env), never in argv.
    extraEnv["SSHPASS"] = usePassword ? credential.password! : credential.passphrase!;
  }

  const result: SshInjectionResult = { rewrittenCommand };
  if (Object.keys(extraEnv).length > 0) result.extraEnv = extraEnv;
  if (tempFiles.length > 0) result.tempFiles = tempFiles;
  return result;
}

/**
 * The sshpass invocation prefix. `-P assphrase` re-points its prompt match at
 * the key-passphrase prompt ("Enter passphrase for key …"); the default matches
 * "assword" for password auth. `-e` reads the secret from the SSHPASS env var.
 */
function sshpassCommand(usePassphrase: boolean): string {
  return usePassphrase ? "sshpass -P assphrase -e" : "sshpass -e";
}

/** Inject a flag+value pair after the tool binary in a command string. */
function injectFlag(command: string, flag: string, value: string): string {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return command;
  // Insert after the first token (the tool binary)
  // But only if the flag isn't already present
  if (tokens.some((t) => t === flag)) {
    return command; // Already has this flag
  }
  tokens.splice(1, 0, flag, value);
  return retokenize(tokens);
}

/** Inject an option flag + value pair (e.g. `-o` `BatchMode=yes`) as two tokens. */
function injectOption(command: string, flag: string, value: string): string {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return command;
  // Already present (same flag immediately followed by the same value) → no-op.
  for (let i = 1; i < tokens.length - 1; i++) {
    if (tokens[i] === flag && tokens[i + 1] === value) {
      return command;
    }
  }
  // Insert after the leading flags, before the first non-flag (host) argument.
  let insertAt = 1;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].startsWith("-")) {
      const nextToken = tokens[i + 1];
      if (nextToken && !nextToken.startsWith("-") && isFlagWithValue(tokens[i])) {
        i++; // Skip the value too
      }
      insertAt = i + 1;
    } else {
      // Found the host argument
      insertAt = i;
      break;
    }
  }
  tokens.splice(insertAt, 0, flag, value);
  return retokenize(tokens);
}

/** Check if a flag token takes a value (for positioning purposes). */
function isFlagWithValue(flag: string): boolean {
  return [
    "-i",
    "-p",
    "-P",
    "-o",
    "-S",
    "-b",
    "-e",
    "-L",
    "-R",
    "-D",
    "-W",
    "-l",
    "-F",
    "-O",
    "-Q",
  ].includes(flag);
}

/** Inject a username into the remote host spec. */
function injectUsername(command: string, detected: SshDetectedTarget, username: string): string {
  // Find the host in the command and prepend username@
  // For ssh/sftp: replace `host` with `user@host` (the first bare host occurrence)
  // For scp/rsync: replace `host:` or `host::` with `user@host:` or `user@host::`
  const hostPattern = detected.host;
  // Use a careful approach: tokenize and modify
  const tokens = tokenizeCommand(command);
  let modified = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.includes(hostPattern) && !token.includes(`${username}@${hostPattern}`)) {
      // Check if this token contains the host without a username prefix
      // For ssh: token is just "host" or "host command..."
      // For scp/rsync: token is "host:path" or "[user@]host:path"
      if (
        token.startsWith(hostPattern + " ") ||
        token === hostPattern ||
        token.startsWith(hostPattern + ":") ||
        token.startsWith(hostPattern + "::") ||
        token.startsWith(hostPattern + " ")
      ) {
        tokens[i] = token.replace(hostPattern, `${username}@${hostPattern}`);
        modified = true;
        break;
      }
    }
  }
  return modified ? retokenize(tokens) : command;
}

/**
 * Merge injected ssh args into rsync's remote-shell command (`-e`/`--rsh`).
 *
 * `rshArgs` are the extra ssh args (e.g. `-i /tmp/k -o StrictHostKeyChecking=…`)
 * and `sshpassPrefix` is either "" or `sshpass -e ` / `sshpass -P assphrase -e `.
 * The result is stored as one literal token; `retokenize` shell-quotes it, so we
 * never build tokens with embedded quote characters (which the old code did and
 * which then round-tripped incorrectly). rsync splits the `-e` value on spaces
 * itself, so a single quoted argument is exactly what it expects.
 */
function injectRsyncRsh(command: string, rshArgs: string, sshpassPrefix: string): string {
  const tokens = tokenizeCommand(command);
  const buildValue = (existing: string): string => {
    // Preserve whatever remote-shell the user specified (`ssh`, a full path like
    // /usr/bin/ssh, or an sshpass wrapper) and append our args to it; only
    // synthesize `ssh` when there is no existing -e/--rsh value. Blindly
    // prepending `ssh ` corrupted custom rsh commands.
    const base = existing.trim();
    const remoteShell = base.length === 0 ? "ssh" : base;
    return `${sshpassPrefix}${remoteShell}${rshArgs ? ` ${rshArgs}` : ""}`;
  };
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    // tokenizeCommand already strips the quotes around an -e/--rsh value, so the
    // value token holds the literal remote-shell command with its spaces intact.
    if ((token === "-e" || token === "--rsh") && i + 1 < tokens.length) {
      tokens[i + 1] = buildValue(tokens[i + 1]);
      return retokenize(tokens);
    }
    if (token.startsWith("-e") && token.length > 2) {
      tokens[i] = "-e";
      tokens.splice(i + 1, 0, buildValue(token.slice(2)));
      return retokenize(tokens);
    }
    if (token.startsWith("--rsh=")) {
      tokens[i] = "--rsh";
      tokens.splice(i + 1, 0, buildValue(token.slice("--rsh=".length)));
      return retokenize(tokens);
    }
  }
  // No existing rsh — insert one after the binary.
  tokens.splice(1, 0, "-e", buildValue(""));
  return retokenize(tokens);
}

// Characters that make the local shell execute a command, substitute, redirect,
// or split a word: whitespace, quotes/backslash, $, backtick, and the control
// operators & | ; < > ( ) ! #. A token containing any of these must be
// single-quoted so the shell hands it to the child as one literal argument —
// this is what stops `ssh host "a&&b"` from splitting at && and running `b`
// locally. Glob/brace/tilde chars (* ? [ ] { } ~) are deliberately NOT here:
// they only expand filenames/paths locally, which is the pre-existing behavior
// scp/rsync source arguments rely on, and they cannot execute a command.
const SHELL_UNSAFE_CHAR = /[\s'"\\$`&|;<>()!#]/u;

/**
 * POSIX single-quote a token so it survives the local shell as one literal
 * argument when it contains a command/word metacharacter. tokenizeCommand
 * decoded the original quoting to the literal value, so re-quoting keeps the
 * argument byte-identical. Tokens with only expansion characters (globs, tilde)
 * are left as-is so local filename expansion still works.
 */
function quoteShellToken(token: string): string {
  if (token.length === 0) {
    return "''";
  }
  if (!SHELL_UNSAFE_CHAR.test(token)) {
    return token;
  }
  return `'${token.replaceAll("'", "'\\''")}'`;
}

/** Re-assemble tokens into a command string, shell-quoting each as needed. */
function retokenize(tokens: string[]): string {
  return tokens.map(quoteShellToken).join(" ");
}
