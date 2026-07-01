import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { splitShellArgs } from "../../utils/shell-argv.js";
import {
  detectSshInjectionTarget,
  detectSshTarget,
  isSshVaultInjectionAllowed,
  matchSshVaultEntry,
  injectSshCredential,
  type SshCredential,
  type SshInjectionResult,
} from "./ssh-injection.js";
import type { VaultSecretEntry } from "./store.js";

/** Remove any private-key temp files an injection wrote. */
function cleanupTempFiles(result: SshInjectionResult): void {
  for (const file of result.tempFiles ?? []) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }
}

function makeSshEntry(
  name: string,
  hosts: string[],
  overrides: Partial<VaultSecretEntry> = {},
): VaultSecretEntry {
  return {
    name,
    hostAllowlist: hosts,
    approvalPolicy: "auto",
    authKind: "ssh",
    authConfig: { kind: "ssh" },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("detectSshTarget", () => {
  it("detects a basic ssh command", () => {
    const result = detectSshTarget("ssh example.com");
    expect(result).toEqual({ tool: "ssh", host: "example.com" });
  });

  it("detects ssh with username", () => {
    const result = detectSshTarget("ssh user@example.com");
    expect(result).toEqual({ tool: "ssh", host: "example.com", username: "user" });
  });

  it("detects ssh with -p port flag", () => {
    const result = detectSshTarget("ssh -p 2222 user@example.com");
    expect(result).toEqual({ tool: "ssh", host: "example.com", username: "user", port: 2222 });
  });

  it("detects ssh with combined -pPORT flag", () => {
    const result = detectSshTarget("ssh -p2222 example.com");
    expect(result).toEqual({ tool: "ssh", host: "example.com", port: 2222 });
  });

  it("detects ssh with remote command after host", () => {
    const result = detectSshTarget('ssh user@example.com "ls -la /tmp"');
    expect(result).toEqual({ tool: "ssh", host: "example.com", username: "user" });
  });

  it("detects ssh after -- separator", () => {
    const result = detectSshTarget("ssh -- example.com");
    expect(result).toEqual({ tool: "ssh", host: "example.com" });
  });

  it("detects ssh with -o options", () => {
    const result = detectSshTarget("ssh -o StrictHostKeyChecking=no user@example.com");
    expect(result).toEqual({ tool: "ssh", host: "example.com", username: "user" });
  });

  it("detects ssh with -i identity file", () => {
    const result = detectSshTarget("ssh -i ~/.ssh/id_rsa user@example.com");
    expect(result).toEqual({ tool: "ssh", host: "example.com", username: "user" });
  });

  it("detects full path to ssh binary", () => {
    const result = detectSshTarget("/usr/bin/ssh user@example.com");
    expect(result).toEqual({ tool: "ssh", host: "example.com", username: "user" });
  });

  it("detects scp with remote source", () => {
    const result = detectSshTarget("scp user@example.com:/tmp/file.txt /local/");
    expect(result).toEqual({ tool: "scp", host: "example.com", username: "user" });
  });

  it("detects scp with remote dest", () => {
    const result = detectSshTarget("scp /local/file.txt user@example.com:/tmp/");
    expect(result).toEqual({ tool: "scp", host: "example.com", username: "user" });
  });

  it("detects scp with -P port flag", () => {
    const result = detectSshTarget("scp -P 2222 file.txt user@example.com:/tmp/");
    expect(result).toEqual({ tool: "scp", host: "example.com", username: "user", port: 2222 });
  });

  it("detects scp without username", () => {
    const result = detectSshTarget("scp file.txt example.com:/tmp/");
    expect(result).toEqual({ tool: "scp", host: "example.com" });
  });

  it("detects rsync with remote source", () => {
    const result = detectSshTarget("rsync -avz user@example.com:/remote/path /local/");
    expect(result).toEqual({ tool: "rsync", host: "example.com", username: "user" });
  });

  it("detects rsync with remote dest", () => {
    const result = detectSshTarget("rsync -avz /local/path user@example.com:/remote/");
    expect(result).toEqual({ tool: "rsync", host: "example.com", username: "user" });
  });

  it("detects rsync with -e ssh port", () => {
    const result = detectSshTarget('rsync -avz -e "ssh -p 2222" /local user@host:/remote');
    expect(result).toEqual({ tool: "rsync", host: "host", username: "user", port: 2222 });
  });

  it("detects rsync with --rsh option", () => {
    const result = detectSshTarget('rsync -avz --rsh="ssh -p 2222" /local user@host:/remote');
    expect(result).toEqual({ tool: "rsync", host: "host", username: "user", port: 2222 });
  });

  it("detects rsync daemon mode (host::module)", () => {
    const result = detectSshTarget("rsync -avz user@host::module/path /local");
    expect(result).toEqual({ tool: "rsync", host: "host", username: "user" });
  });

  it("detects sftp command", () => {
    const result = detectSshTarget("sftp user@example.com");
    expect(result).toEqual({ tool: "sftp", host: "example.com", username: "user" });
  });

  it("detects sftp with port", () => {
    const result = detectSshTarget("sftp -P 2222 user@example.com");
    expect(result).toEqual({ tool: "sftp", host: "example.com", username: "user", port: 2222 });
  });

  it("detects sftp when -p (preserve) precedes the host", () => {
    // Regression: for sftp `-p` is preserve-times, not the port. Consuming its
    // "value" swallowed the host and dropped detection (so no injection).
    const result = detectSshTarget("sftp -p user@example.com");
    expect(result).toEqual({ tool: "sftp", host: "example.com", username: "user" });
  });

  it("returns null for non-SSH commands", () => {
    expect(detectSshTarget("ls -la")).toBeNull();
    expect(detectSshTarget("curl https://example.com")).toBeNull();
    expect(detectSshTarget("git push")).toBeNull();
    expect(detectSshTarget("echo hello")).toBeNull();
    expect(detectSshTarget("")).toBeNull();
  });

  it("returns null for ssh with no host argument", () => {
    expect(detectSshTarget("ssh -v")).toBeNull();
  });
});

describe("matchSshVaultEntry", () => {
  const entries = [
    makeSshEntry("server1", ["server1.example.com"]),
    makeSshEntry("server2", ["server2.example.com", "10.0.0.2"]),
  ];

  it("matches by exact host", () => {
    const result = matchSshVaultEntry({ host: "server1.example.com" }, entries);
    expect(result?.name).toBe("server1");
  });

  it("matches by IP", () => {
    const result = matchSshVaultEntry({ host: "10.0.0.2" }, entries);
    expect(result?.name).toBe("server2");
  });

  it("matches by subdomain", () => {
    const entry = makeSshEntry("wildcard", ["example.com"]);
    const result = matchSshVaultEntry({ host: "sub.example.com" }, [entry]);
    expect(result?.name).toBe("wildcard");
  });

  it("does not match bare suffix", () => {
    const entry = makeSshEntry("safe", ["example.com"]);
    const result = matchSshVaultEntry({ host: "evil-example.com" }, [entry]);
    expect(result).toBeUndefined();
  });

  it("returns undefined when no match", () => {
    const result = matchSshVaultEntry({ host: "nomatch.com" }, entries);
    expect(result).toBeUndefined();
  });

  it("skips non-SSH vault entries", () => {
    const bearerEntry: VaultSecretEntry = {
      ...makeSshEntry("bearer", ["example.com"]),
      authKind: "bearer",
      authConfig: { kind: "bearer" },
    };
    const result = matchSshVaultEntry({ host: "example.com" }, [bearerEntry]);
    expect(result).toBeUndefined();
  });
});

describe("injectSshCredential", () => {
  const baseDetected = { tool: "ssh" as const, host: "example.com" };

  it("injects private key via temp file for ssh", () => {
    const cred: SshCredential = {
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----",
    };
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: cred,
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("-i ");
    expect(result.rewrittenCommand).toContain("StrictHostKeyChecking=accept-new");
    expect(result.rewrittenCommand).toContain("BatchMode=yes");
    expect(result.tempFiles).toBeDefined();
    expect(result.tempFiles!.length).toBe(1);
    // Clean up temp file
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("injects username when missing", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
      username: "myuser",
    };
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: cred,
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("myuser@example.com");
    expect(result.tempFiles).toBeDefined();
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("does not inject username when already present", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
      username: "vaultuser",
    };
    const result = injectSshCredential({
      command: "ssh existinguser@example.com",
      detected: { tool: "ssh", host: "example.com", username: "existinguser" },
      credential: cred,
      env: process.env,
    });
    // Should NOT contain vaultuser@
    expect(result.rewrittenCommand).not.toContain("vaultuser@");
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("injects port when missing", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
      port: 2222,
    };
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: cred,
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("-p 2222");
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("does not inject port when already specified", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
      port: 2222,
    };
    const result = injectSshCredential({
      command: "ssh -p 3333 example.com",
      detected: { tool: "ssh", host: "example.com", port: 3333 },
      credential: cred,
      env: process.env,
    });
    // Should NOT add another -p
    expect(result.rewrittenCommand).not.toContain("-p 2222");
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("wraps with sshpass -e for password auth", () => {
    const cred: SshCredential = {
      password: "secretpass",
    };
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: cred,
      env: process.env,
      sshpassAvailable: true,
    });
    expect(result.rewrittenCommand.startsWith("sshpass -e ")).toBe(true);
    expect(result.extraEnv?.SSHPASS).toBe("secretpass");
    // Password auth should NOT add BatchMode
    expect(result.rewrittenCommand).not.toContain("BatchMode=yes");
    // But should add StrictHostKeyChecking
    expect(result.rewrittenCommand).toContain("StrictHostKeyChecking=accept-new");
  });

  it("does not add BatchMode for password auth", () => {
    const cred: SshCredential = {
      password: "secretpass",
    };
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: cred,
      env: process.env,
      sshpassAvailable: true,
    });
    expect(result.rewrittenCommand).not.toContain("BatchMode");
  });

  it("declines password injection when sshpass is unavailable", () => {
    // Finding: `sshpass -e` was wrapped unconditionally; on a host without
    // sshpass the command hard-failed with "command not found". Now injection
    // is declined and the command is left untouched.
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: { password: "secretpass" },
      env: process.env,
      sshpassAvailable: false,
    });
    expect(result.skipped).toEqual({ reason: "sshpass-missing" });
    expect(result.rewrittenCommand).toBe("ssh example.com");
    expect(result.extraEnv).toBeUndefined();
    expect(result.tempFiles).toBeUndefined();
  });

  it("uses a stored key passphrase via sshpass and omits BatchMode", () => {
    // Finding: credential.passphrase was never used and BatchMode=yes forced a
    // passphrase-protected key to fail. Now the passphrase is fed via sshpass
    // (prompt-matched with -P) and BatchMode is dropped so the prompt is answerable.
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: { privateKey: "fake-key-content", passphrase: "keypass" },
      env: process.env,
      sshpassAvailable: true,
    });
    expect(result.rewrittenCommand.startsWith("sshpass -P assphrase -e ")).toBe(true);
    expect(result.rewrittenCommand).not.toContain("BatchMode");
    expect(result.rewrittenCommand).toContain("-i ");
    expect(result.extraEnv?.SSHPASS).toBe("keypass");
    cleanupTempFiles(result);
  });

  it("declines passphrase-key injection when sshpass is unavailable", () => {
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: { privateKey: "fake-key-content", passphrase: "keypass" },
      env: process.env,
      sshpassAvailable: false,
    });
    expect(result.skipped).toEqual({ reason: "sshpass-missing" });
    expect(result.rewrittenCommand).toBe("ssh example.com");
    expect(result.tempFiles).toBeUndefined();
  });

  it("keeps a metacharacter remote command quoted so it cannot execute locally", () => {
    // Finding: `ssh host "a&&b"` re-emitted `a&&b` unquoted, so the LOCAL shell
    // split at && and ran `b` on the host machine.
    const result = injectSshCredential({
      command: 'ssh example.com "a&&b"',
      detected: baseDetected,
      credential: { privateKey: "fake-key-content" },
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("'a&&b'");
    cleanupTempFiles(result);
  });

  it("does not re-quote a single-quoted remote command into local expansion", () => {
    const result = injectSshCredential({
      command: "ssh example.com 'echo $HOME'",
      detected: baseDetected,
      credential: { privateKey: "fake-key-content" },
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("'echo $HOME'");
    expect(result.rewrittenCommand).not.toContain('"echo $HOME"');
    cleanupTempFiles(result);
  });

  it("routes rsync ssh options into the -e remote-shell value, not rsync argv", () => {
    // Finding: `-o StrictHostKeyChecking=…` / BatchMode were injected as bare
    // rsync argv, which rsync rejects. They must live inside the -e ssh command.
    const result = injectSshCredential({
      command: "rsync -avz /local user@example.com:/remote",
      detected: { tool: "rsync", host: "example.com", username: "user" },
      credential: { privateKey: "fake-key-content" },
      env: process.env,
    });
    const cmd = result.rewrittenCommand;
    expect(cmd).toMatch(/-e '[^']*StrictHostKeyChecking=accept-new[^']*'/u);
    expect(cmd).toMatch(/-e '[^']*-i [^']*'/u);
    const argv = splitShellArgs(cmd)!;
    // rsync must not receive ssh-only tokens on its own argv.
    expect(argv).not.toContain("-o");
    expect(argv).not.toContain("BatchMode=yes");
    cleanupTempFiles(result);
  });

  it("preserves a custom rsync remote-shell binary instead of prepending ssh", () => {
    // Regression: an existing `-e <value>` not literally starting with `ssh` was
    // corrupted to `ssh <value>` (e.g. `ssh /usr/bin/ssh`), breaking the command.
    const result = injectSshCredential({
      command: "rsync -avz -e /usr/bin/ssh /local user@example.com:/remote",
      detected: { tool: "rsync", host: "example.com", username: "user" },
      credential: { privateKey: "fake-key-content" },
      env: process.env,
    });
    expect(result.rewrittenCommand).toMatch(/-e '\/usr\/bin\/ssh /u);
    expect(result.rewrittenCommand).not.toContain("ssh /usr/bin/ssh");
    cleanupTempFiles(result);
  });

  it("leaves local glob tokens unquoted so scp source expansion still works", () => {
    // Regression: the whitelist re-quoted `*.txt` into a literal '*.txt', so the
    // local shell could no longer glob the upload set. Glob chars are expansion,
    // not execution, and must survive unquoted.
    const result = injectSshCredential({
      command: "scp *.txt user@example.com:/tmp/",
      detected: { tool: "scp", host: "example.com", username: "user" },
      credential: { privateKey: "fake-key-content" },
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("*.txt");
    expect(result.rewrittenCommand).not.toContain("'*.txt'");
    cleanupTempFiles(result);
  });

  it("prefers private key over password when both present", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
      password: "also-a-password",
    };
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: cred,
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("-i ");
    expect(result.rewrittenCommand).not.toContain("sshpass");
    expect(result.tempFiles).toBeDefined();
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("handles scp private key injection", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
    };
    const result = injectSshCredential({
      command: "scp file.txt example.com:/tmp/",
      detected: { tool: "scp", host: "example.com" },
      credential: cred,
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("-i ");
    expect(result.tempFiles).toBeDefined();
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("handles scp port injection with -P", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
      port: 2222,
    };
    const result = injectSshCredential({
      command: "scp file.txt example.com:/tmp/",
      detected: { tool: "scp", host: "example.com" },
      credential: cred,
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("-P 2222");
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("handles rsync with key injection via -e", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
    };
    const result = injectSshCredential({
      command: "rsync -avz /local user@example.com:/remote",
      detected: { tool: "rsync", host: "example.com", username: "user" },
      credential: cred,
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("-i ");
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("handles sftp with key injection", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
    };
    const result = injectSshCredential({
      command: "sftp example.com",
      detected: { tool: "sftp", host: "example.com" },
      credential: cred,
      env: process.env,
    });
    expect(result.rewrittenCommand).toContain("-i ");
    const fs = require("node:fs");
    if (result.tempFiles && fs.existsSync(result.tempFiles[0])) {
      fs.unlinkSync(result.tempFiles[0]);
    }
  });

  it("creates temp files with 0600 permissions", () => {
    const cred: SshCredential = {
      privateKey: "fake-key-content",
    };
    const result = injectSshCredential({
      command: "ssh example.com",
      detected: baseDetected,
      credential: cred,
      env: process.env,
    });
    expect(result.tempFiles).toBeDefined();
    expect(result.tempFiles!.length).toBe(1);
    if (process.platform !== "win32") {
      const fs = require("node:fs");
      const stat = fs.statSync(result.tempFiles![0]);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);
      fs.unlinkSync(result.tempFiles![0]);
    }
  });
});

describe("detectSshInjectionTarget", () => {
  it("detects a target for a host exec", () => {
    expect(detectSshInjectionTarget("ssh example.com", { sandbox: false })).toEqual({
      tool: "ssh",
      host: "example.com",
    });
  });

  it("returns null for a sandboxed exec so the vault key/SSHPASS never reach the sandbox", () => {
    expect(detectSshInjectionTarget("ssh example.com", { sandbox: true })).toBeNull();
  });

  it("treats a truthy sandbox config object as sandboxed (not just boolean true)", () => {
    // Regression: the caller passes the BashSandboxConfig object, not a boolean.
    // A `sandbox === true` narrowing was always false for an object and silently
    // let vault creds inject into sandboxed execs.
    expect(detectSshInjectionTarget("ssh example.com", { sandbox: {} })).toBeNull();
    expect(
      detectSshInjectionTarget("ssh example.com", { sandbox: { containerName: "c" } }),
    ).toBeNull();
  });

  it("detects normally when no sandbox config is present (host exec)", () => {
    expect(detectSshInjectionTarget("ssh example.com", { sandbox: undefined })).toEqual({
      tool: "ssh",
      host: "example.com",
    });
  });
});

describe("isSshVaultInjectionAllowed", () => {
  it("injects for an auto policy with no grant", () => {
    expect(isSshVaultInjectionAllowed({ approvalPolicy: "auto", grant: undefined })).toBe(true);
  });

  it("declines an ask policy with no standing grant (fail closed)", () => {
    // Regression: exec injection ignored approvalPolicy entirely and injected a
    // credential the operator saved with the default `ask` policy.
    expect(isSshVaultInjectionAllowed({ approvalPolicy: "ask", grant: undefined })).toBe(false);
  });

  it("injects for an ask policy once allow-always is granted", () => {
    expect(isSshVaultInjectionAllowed({ approvalPolicy: "ask", grant: "allow-always" })).toBe(true);
  });

  it("never injects over a deny grant, even for an auto policy", () => {
    expect(isSshVaultInjectionAllowed({ approvalPolicy: "auto", grant: "deny" })).toBe(false);
  });
});
