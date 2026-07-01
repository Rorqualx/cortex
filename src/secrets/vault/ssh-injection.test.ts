import { describe, expect, it } from "vitest";
import {
  detectSshTarget,
  matchSshVaultEntry,
  injectSshCredential,
  type SshCredential,
} from "./ssh-injection.js";
import type { VaultSecretEntry } from "./store.js";

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
    });
    expect(result.rewrittenCommand).not.toContain("BatchMode");
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
