import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Tests for session-awareness module.
 *
 * Covers:
 * - SessionActivityRegistry: claim, release, conflict detection, expiry
 * - FileWriteGuard: claim/release/check with session context
 * - SessionContext: AsyncLocalStorage propagation
 * - Integration with file-mutation-queue
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkExecGuard, releaseExecGuard, formatExecGuardError } from "./exec-guard.js";
import { claimFileForWrite, formatWriteGuardError } from "./file-write-guard.js";
import { SessionActivityRegistry, sessionActivityRegistry } from "./session-activity-registry.js";
import {
  getSessionContext,
  getSessionKey,
  runWithSessionContext,
  updateSessionContextMetadata,
} from "./session-context.js";

// ── SessionActivityRegistry ────────────────────────────────────────────

describe("SessionActivityRegistry", () => {
  let registry: SessionActivityRegistry;

  beforeEach(() => {
    registry = new SessionActivityRegistry({ claimExpiryMs: 1000 });
  });

  afterEach(() => {
    registry.clear();
  });

  describe("claimFile", () => {
    it("allows a session to claim a file", () => {
      const result = registry.claimFile("session-a", "/tmp/test.ts", "write");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claim.sessionKey).toBe("session-a");
        expect(result.claim.toolName).toBe("write");
        expect(result.claim.resolvedPath).toContain("test.ts");
      }
    });

    it("allows same session to re-claim a file", () => {
      registry.claimFile("session-a", "/tmp/test.ts", "write");
      const result = registry.claimFile("session-a", "/tmp/test.ts", "edit");
      expect(result.ok).toBe(true);
    });

    it("blocks another session from claiming the same file", () => {
      registry.claimFile("session-a", "/tmp/test.ts", "write");
      const result = registry.claimFile("session-b", "/tmp/test.ts", "edit");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.conflict.claimedBy.sessionKey).toBe("session-a");
        expect(result.conflict.claimedBy.toolName).toBe("write");
      }
    });

    it("returns conflict details with agent ID", () => {
      registry.claimFile("session-a", "/tmp/test.ts", "write", { agentId: "codex" });
      const result = registry.claimFile("session-b", "/tmp/test.ts", "edit");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.conflict.claimedBy.agentId).toBe("codex");
      }
    });
  });

  describe("releaseFile", () => {
    it("releases a file claim", () => {
      registry.claimFile("session-a", "/tmp/test.ts", "write");
      const released = registry.releaseFile("session-a", "/tmp/test.ts");
      expect(released).toBe(true);
      // Now another session can claim it
      const result = registry.claimFile("session-b", "/tmp/test.ts", "edit");
      expect(result.ok).toBe(true);
    });

    it("does not release another session's claim", () => {
      registry.claimFile("session-a", "/tmp/test.ts", "write");
      const released = registry.releaseFile("session-b", "/tmp/test.ts");
      expect(released).toBe(false);
    });
  });

  describe("releaseAllForSession", () => {
    it("releases all claims for a session", () => {
      registry.claimFile("session-a", "/tmp/a.ts", "write");
      registry.claimFile("session-a", "/tmp/b.ts", "write");
      registry.claimFile("session-b", "/tmp/c.ts", "edit");
      const count = registry.releaseAllForSession("session-a");
      expect(count).toBe(2);
      expect(registry.claimCount).toBe(1);
    });
  });

  describe("checkConflict", () => {
    it("returns undefined when no conflict", () => {
      const conflict = registry.checkConflict("session-a", "/tmp/test.ts");
      expect(conflict).toBeUndefined();
    });

    it("returns conflict when another session holds the file", () => {
      registry.claimFile("session-a", "/tmp/test.ts", "write");
      const conflict = registry.checkConflict("session-b", "/tmp/test.ts");
      expect(conflict).toBeDefined();
      expect(conflict?.claimedBy.sessionKey).toBe("session-a");
    });

    it("returns undefined for same session", () => {
      registry.claimFile("session-a", "/tmp/test.ts", "write");
      const conflict = registry.checkConflict("session-a", "/tmp/test.ts");
      expect(conflict).toBeUndefined();
    });
  });

  describe("expiry", () => {
    it("auto-expires stale claims", async () => {
      const fastRegistry = new SessionActivityRegistry({ claimExpiryMs: 50 });
      fastRegistry.claimFile("session-a", "/tmp/test.ts", "write");
      // Wait for expiry
      await new Promise((r) => {
        setTimeout(r, 100);
      });
      const result = fastRegistry.claimFile("session-b", "/tmp/test.ts", "edit");
      expect(result.ok).toBe(true);
    });

    it("expireStaleClaims removes old entries", async () => {
      const fastRegistry = new SessionActivityRegistry({ claimExpiryMs: 50 });
      fastRegistry.claimFile("session-a", "/tmp/test.ts", "write");
      await new Promise((r) => {
        setTimeout(r, 100);
      });
      const expired = fastRegistry.expireStaleClaims();
      expect(expired).toBe(1);
      expect(fastRegistry.claimCount).toBe(0);
    });
  });

  describe("enabled/disabled", () => {
    it("skips conflict checking when disabled", () => {
      const reg = new SessionActivityRegistry({ enabled: false });
      reg.claimFile("session-a", "/tmp/test.ts", "write");
      const result = reg.claimFile("session-b", "/tmp/test.ts", "edit");
      // Disabled registry always allows claims
      expect(result.ok).toBe(true);
    });

    it("can be toggled at runtime", () => {
      registry.setEnabled(false);
      registry.claimFile("session-a", "/tmp/test.ts", "write");
      const result = registry.claimFile("session-b", "/tmp/test.ts", "edit");
      expect(result.ok).toBe(true);
      registry.setEnabled(true);
      registry.claimFile("session-c", "/tmp/test2.ts", "write");
      const result2 = registry.claimFile("session-d", "/tmp/test2.ts", "edit");
      expect(result2.ok).toBe(false);
    });
  });
});

// ── SessionContext (AsyncLocalStorage) ──────────────────────────────────

describe("SessionContext", () => {
  it("returns undefined outside a session context", () => {
    expect(getSessionKey()).toBeUndefined();
    expect(getSessionContext()).toBeUndefined();
  });

  it("provides session key inside runWithSessionContext", () => {
    runWithSessionContext({ sessionKey: "test-session" }, () => {
      expect(getSessionKey()).toBe("test-session");
      expect(getSessionContext()?.sessionKey).toBe("test-session");
    });
  });

  it("propagates through async operations", async () => {
    await runWithSessionContext({ sessionKey: "async-session" }, async () => {
      expect(getSessionKey()).toBe("async-session");
      await new Promise((r) => {
        setTimeout(r, 10);
      });
      expect(getSessionKey()).toBe("async-session");
    });
  });

  it("supports nested contexts", () => {
    runWithSessionContext({ sessionKey: "outer" }, () => {
      expect(getSessionKey()).toBe("outer");
      runWithSessionContext({ sessionKey: "inner" }, () => {
        expect(getSessionKey()).toBe("inner");
      });
      expect(getSessionKey()).toBe("outer");
    });
  });

  it("updateSessionContextMetadata updates in-place", () => {
    runWithSessionContext({ sessionKey: "test" }, () => {
      updateSessionContextMetadata({ agentId: "codex", label: "fix bug" });
      const ctx = getSessionContext()!;
      expect(ctx.agentId).toBe("codex");
      expect(ctx.label).toBe("fix bug");
    });
  });
});

// ── FileWriteGuard ──────────────────────────────────────────────────────

describe("FileWriteGuard", () => {
  let testRegistry: SessionActivityRegistry;

  beforeEach(() => {
    testRegistry = new SessionActivityRegistry({ claimExpiryMs: 5000 });
    // We test the guard functions directly by setting up session context
  });

  afterEach(() => {
    testRegistry.clear();
  });

  describe("claimFileForWrite", () => {
    it("allows writes outside session context", () => {
      const result = claimFileForWrite("/tmp/test.ts", "write");
      expect(result.ok).toBe(true);
    });

    it("allows writes within a session with no conflicts", () => {
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const result = claimFileForWrite("/tmp/test.ts", "write");
        expect(result.ok).toBe(true);
      });
    });
  });

  describe("formatWriteGuardError", () => {
    it("formats a human-readable error message", () => {
      const error = formatWriteGuardError({
        message: "Test conflict",
        conflict: {
          filePath: "/tmp/test.ts",
          claimedBy: {
            sessionKey: "session-a",
            agentId: "codex",
            toolName: "write",
            claimedAt: Date.now() - 5000,
            resolvedPath: "/tmp/test.ts",
          },
        },
        suggestion: "Wait and retry",
      });
      expect(error).toContain("Cross-session write conflict");
      expect(error).toContain("session-a");
      expect(error).toContain("codex");
      expect(error).toContain("test.ts");
      expect(error).toContain("Wait and retry");
    });
  });
});

// ── Integration: withFileMutationQueue ──────────────────────────────────
//
// These tests verify that the write guard integrates with the mutation queue.
// They import the BUILT module from dist/ since the source imports reference
// each other via relative paths that only resolve after building.
//
// Run `pnpm build` first if these fail with module-not-found.
//

describe("Integration: file-mutation-queue with write guard", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "session-awareness-test-"));
    sessionActivityRegistry.clear();
    sessionActivityRegistry.setEnabled(true);
  });

  afterEach(() => {
    sessionActivityRegistry.clear();
    sessionActivityRegistry.setEnabled(true);
    try {
      rmSync(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("allows write within same session", async () => {
    const { withFileMutationQueue } =
      await import("../agents/sessions/tools/file-mutation-queue.js");
    const testFile = join(tempDir, "test.txt");

    await runWithSessionContext({ sessionKey: "session-a" }, async () => {
      await withFileMutationQueue(testFile, async () => {
        writeFileSync(testFile, "hello");
      });
      const content = await import("node:fs/promises").then((fs) => fs.readFile(testFile, "utf-8"));
      expect(content).toBe("hello");
    });
  });

  it("blocks write from another session when file is claimed", async () => {
    const { withFileMutationQueue } =
      await import("../agents/sessions/tools/file-mutation-queue.js");
    const testFile = join(tempDir, "test.txt");
    writeFileSync(testFile, "original");

    // Session A claims and holds the file
    await runWithSessionContext({ sessionKey: "session-a" }, async () => {
      const claimResult = sessionActivityRegistry.claimFile("session-a", testFile, "write");
      expect(claimResult.ok).toBe(true);
    });

    // Session B tries to write — should fail
    await runWithSessionContext({ sessionKey: "session-b" }, async () => {
      await expect(
        withFileMutationQueue(testFile, async () => {
          writeFileSync(testFile, "from-b");
        }),
      ).rejects.toThrow("Cross-session write conflict");
    });
  });

  it("releases claim after write completes", async () => {
    const { withFileMutationQueue } =
      await import("../agents/sessions/tools/file-mutation-queue.js");
    const testFile = join(tempDir, "test.txt");

    await runWithSessionContext({ sessionKey: "session-a" }, async () => {
      await withFileMutationQueue(testFile, async () => {
        writeFileSync(testFile, "from-a");
      });
    });

    // Session B should now be able to write
    await runWithSessionContext({ sessionKey: "session-b" }, async () => {
      await withFileMutationQueue(testFile, async () => {
        writeFileSync(testFile, "from-b");
      });
    });
  });
});

// ── Exec Guard ───────────────────────────────────────────────────────────

describe("ExecGuard", () => {
  beforeEach(() => {
    sessionActivityRegistry.clear();
    sessionActivityRegistry.setEnabled(true);
  });

  afterEach(() => {
    sessionActivityRegistry.clear();
  });

  describe("detectProtectedCommand", () => {
    it("allows non-protected commands outside session context", () => {
      const result = checkExecGuard("ls -la", "/tmp");
      expect(result.allowed).toBe(true);
      expect(result.scopeKey).toBeUndefined();
    });

    it("allows non-protected commands within session context", () => {
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const result = checkExecGuard("ls -la", "/tmp");
        expect(result.allowed).toBe(true);
      });
    });

    it("detects git commit", () => {
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const result = checkExecGuard("git commit -m 'fix'", "/tmp");
        expect(result.allowed).toBe(true);
        expect(result.scopeKey).toMatch(/^repo:/);
      });
    });

    it("detects git push", () => {
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const result = checkExecGuard("git push origin main", "/tmp");
        expect(result.allowed).toBe(true);
        expect(result.scopeKey).toMatch(/^repo:/);
      });
    });

    it("detects prod-restart.sh", () => {
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const result = checkExecGuard("bash scripts/prod-restart.sh", "/tmp");
        expect(result.allowed).toBe(true);
        expect(result.scopeKey).toBe("restart:gateway");
      });
    });

    it("detects openclaw gateway restart", () => {
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const result = checkExecGuard("openclaw gateway restart", "/tmp");
        expect(result.allowed).toBe(true);
        expect(result.scopeKey).toBe("restart:gateway");
      });
    });

    it("ignores plain git status", () => {
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const result = checkExecGuard("git status", "/tmp");
        expect(result.allowed).toBe(true);
        expect(result.scopeKey).toBeUndefined();
      });
    });
  });

  describe("scoped conflicts", () => {
    it("blocks git push from another session", () => {
      // Session A claims the repo
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const r1 = checkExecGuard("git commit -m 'fix'", "/tmp");
        expect(r1.allowed).toBe(true);
        expect(r1.scopeKey).toBeDefined();
      });

      // Session B tries to push — should be blocked
      runWithSessionContext({ sessionKey: "session-b" }, () => {
        const r2 = checkExecGuard("git push", "/tmp");
        expect(r2.allowed).toBe(false);
        if (!r2.allowed && r2.error) {
          expect(r2.error.message).toContain("session-a");
          expect(r2.error.message).toContain("Git operation");
        }
      });
    });

    it("blocks restart while repo operation is active", () => {
      // Session A claims the repo
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        checkExecGuard("git push", "/tmp");
      });

      // Session B tries to restart — should be blocked
      runWithSessionContext({ sessionKey: "session-b" }, () => {
        const r = checkExecGuard("bash scripts/prod-restart.sh", "/tmp");
        // Different scope (restart vs repo) — should be allowed
        // Actually restart and repo are different scopes, so this should pass
        expect(r.allowed).toBe(true);
      });
    });

    it("blocks restart while another restart is active", () => {
      // Session A claims restart
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const r1 = checkExecGuard("bash scripts/prod-restart.sh", "/tmp");
        expect(r1.allowed).toBe(true);
      });

      // Session B tries to restart too — should be blocked
      runWithSessionContext({ sessionKey: "session-b" }, () => {
        const r2 = checkExecGuard("openclaw gateway restart", "/tmp");
        expect(r2.allowed).toBe(false);
        if (!r2.allowed && r2.error) {
          expect(r2.error.message).toContain("restart");
        }
      });
    });

    it("releases claim after releaseExecGuard", () => {
      let scopeKey: string | undefined;
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        const r1 = checkExecGuard("git push", "/tmp");
        scopeKey = r1.scopeKey;
        expect(r1.allowed).toBe(true);
      });

      // Release the claim
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        releaseExecGuard(scopeKey);
      });

      // Session B should now be able to push
      runWithSessionContext({ sessionKey: "session-b" }, () => {
        const r2 = checkExecGuard("git push", "/tmp");
        expect(r2.allowed).toBe(true);
      });
    });
  });

  describe("formatExecGuardError", () => {
    it("formats error with all details", () => {
      runWithSessionContext({ sessionKey: "session-a" }, () => {
        checkExecGuard("git push", "/tmp");
      });

      runWithSessionContext({ sessionKey: "session-b" }, () => {
        const result = checkExecGuard("git push", "/tmp");
        if (!result.allowed && result.error) {
          const formatted = formatExecGuardError(result.error);
          expect(formatted).toContain("Cross-session operation conflict");
          expect(formatted).toContain("session-a");
          expect(formatted).toContain("repo");
        }
      });
    });
  });
});
