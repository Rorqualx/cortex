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
import type { VaultSecretEntry } from "./store.js";
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
    if (arg === "-p" && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
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
 * Check if `sshpass` is available in the environment.
 * This is a soft check — if sshpass is needed but missing, the caller should
 * log an error and fall back.
 */
export function isSshpassAvailable(): boolean {
  try {
    const { execSync } = require("node:child_process");
    execSync("sshpass -V", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
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
}): SshInjectionResult {
  const { command, detected, credential } = params;
  const usePrivateKey = !!credential.privateKey;
  const usePassword = !usePrivateKey && !!credential.password;

  let rewrittenCommand = command;
  const extraEnv: Record<string, string> = {};
  const tempFiles: string[] = [];

  if (usePrivateKey && credential.privateKey) {
    const keyPath = writeKeyTempFile(credential.privateKey);
    tempFiles.push(keyPath);

    if (detected.tool === "ssh" || detected.tool === "sftp") {
      rewrittenCommand = injectFlag(rewrittenCommand, "-i", keyPath);
    } else if (detected.tool === "scp") {
      rewrittenCommand = injectFlag(rewrittenCommand, "-i", keyPath);
    } else if (detected.tool === "rsync") {
      // For rsync, set the rsh to include the key
      rewrittenCommand = injectRsyncRsh(rewrittenCommand, `-i ${keyPath}`);
    }
  }

  // Inject port if the vault has one and the command doesn't
  if (credential.port !== undefined && detected.port === undefined) {
    const portStr = String(credential.port);
    if (detected.tool === "ssh") {
      rewrittenCommand = injectFlag(rewrittenCommand, "-p", portStr);
    } else if (detected.tool === "scp" || detected.tool === "sftp") {
      rewrittenCommand = injectFlag(rewrittenCommand, "-P", portStr);
    } else if (detected.tool === "rsync") {
      rewrittenCommand = injectRsyncRsh(rewrittenCommand, `-p ${portStr}`);
    }
  }

  // Inject username if the vault has one and the command doesn't
  if (credential.username && !detected.username) {
    rewrittenCommand = injectUsername(rewrittenCommand, detected, credential.username);
  }

  // Add anti-hang options
  const strictHostKey = "-o StrictHostKeyChecking=accept-new";
  if (usePrivateKey) {
    // For key auth, add BatchMode to prevent password prompt hangs
    rewrittenCommand = injectOption(rewrittenCommand, strictHostKey);
    rewrittenCommand = injectOption(rewrittenCommand, "-o BatchMode=yes");
  } else {
    // For password auth via sshpass, don't add BatchMode (sshpass needs to provide the password)
    rewrittenCommand = injectOption(rewrittenCommand, strictHostKey);
  }

  // Wrap with sshpass for password auth
  if (usePassword && credential.password) {
    extraEnv["SSHPASS"] = credential.password;
    if (detected.tool === "rsync") {
      // For rsync, we need to set SSHPASS and use rsh with sshpass
      rewrittenCommand = injectRsyncRsh(rewrittenCommand, "", true);
    }
    // Wrap the entire command with sshpass -e
    rewrittenCommand = `sshpass -e ${rewrittenCommand}`;
  }

  const result: SshInjectionResult = { rewrittenCommand };
  if (Object.keys(extraEnv).length > 0) result.extraEnv = extraEnv;
  if (tempFiles.length > 0) result.tempFiles = tempFiles;
  return result;
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

/** Inject an -o option value. */
function injectOption(command: string, option: string): string {
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return command;
  // Check if this exact option is already present
  if (tokens.includes(option)) {
    return command;
  }
  // For -o options, insert after the binary but before the host argument.
  // Find the first non-flag argument (the host) and insert before it.
  let insertAt = 1;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].startsWith("-")) {
      // Check if this flag takes a value
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
  tokens.splice(insertAt, 0, option);
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

/** Inject rsh options for rsync (either -e flag or --rsh). */
function injectRsyncRsh(command: string, rshArgs: string, useSshpass = false): string {
  const tokens = tokenizeCommand(command);
  let rshFound = false;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-e" && i + 1 < tokens.length) {
      // Append to existing -e value
      const existingRsh = tokens[i + 1].replace(/^["']|["']$/g, "");
      if (useSshpass) {
        tokens[i + 1] = `"sshpass -e ssh ${existingRsh}"`;
      } else {
        tokens[i + 1] = `"ssh ${existingRsh} ${rshArgs}"`;
      }
      rshFound = true;
      break;
    }
    if (token.startsWith("-e") && token.length > 2) {
      const existingRsh = token.slice(2).replace(/^["']|["']$/g, "");
      if (useSshpass) {
        tokens[i] = `-e "sshpass -e ssh ${existingRsh}"`;
      } else {
        tokens[i] = `-e "ssh ${existingRsh} ${rshArgs}"`;
      }
      rshFound = true;
      break;
    }
    if (token.startsWith("--rsh=")) {
      const existingRsh = token.slice("--rsh=".length).replace(/^["']|["']$/g, "");
      if (useSshpass) {
        tokens[i] = `--rsh="sshpass -e ssh ${existingRsh}"`;
      } else {
        tokens[i] = `--rsh="ssh ${existingRsh} ${rshArgs}"`;
      }
      rshFound = true;
      break;
    }
    if (token === "--rsh" && i + 1 < tokens.length) {
      const existingRsh = tokens[i + 1].replace(/^["']|["']$/g, "");
      if (useSshpass) {
        tokens[i + 1] = `"sshpass -e ssh ${existingRsh}"`;
      } else {
        tokens[i + 1] = `"ssh ${existingRsh} ${rshArgs}"`;
      }
      rshFound = true;
      break;
    }
  }
  if (!rshFound) {
    // Insert -e after the binary (position 1)
    if (useSshpass) {
      tokens.splice(1, 0, "-e", `"sshpass -e ssh"`);
    } else {
      tokens.splice(1, 0, "-e", `"ssh ${rshArgs}"`);
    }
  }
  return retokenize(tokens);
}

/** Re-assemble tokens into a command string, quoting as needed. */
function retokenize(tokens: string[]): string {
  return tokens
    .map((t) => {
      // Quote tokens that contain spaces
      if (t.includes(" ") && !t.startsWith('"') && !t.startsWith("'")) {
        return `"${t}"`;
      }
      return t;
    })
    .join(" ");
}
