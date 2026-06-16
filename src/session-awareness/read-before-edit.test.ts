import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkReadBeforeMutation } from "./file-write-guard.js";
import { readLedger } from "./read-ledger.js";
import { sessionActivityRegistry } from "./session-activity-registry.js";
import { runWithSessionContext } from "./session-context.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rbe-"));
});

afterEach(() => {
  readLedger.clear();
  rmSync(dir, { recursive: true, force: true });
});

function recordCurrentRead(path: string): void {
  const s = statSync(path);
  readLedger.recordRead(path, { size: s.size, mtimeMs: s.mtimeMs });
}

describe("checkReadBeforeMutation", () => {
  it("allows non-edit tools without a prior read", () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    runWithSessionContext({ sessionKey: "s1" }, () => {
      expect(checkReadBeforeMutation(file, "write").ok).toBe(true);
    });
  });

  it("allows edits outside a session context", () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    expect(checkReadBeforeMutation(file, "edit").ok).toBe(true);
  });

  it("allows editing a not-yet-existing file (creation)", () => {
    const file = join(dir, "new.txt");
    runWithSessionContext({ sessionKey: "s1" }, () => {
      expect(checkReadBeforeMutation(file, "edit").ok).toBe(true);
    });
  });

  it("blocks editing an existing file that was never read", () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    runWithSessionContext({ sessionKey: "s1" }, () => {
      const result = checkReadBeforeMutation(file, "edit");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("was not read");
      }
    });
  });

  it("allows editing a file read fresh this session", () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    runWithSessionContext({ sessionKey: "s1" }, () => {
      recordCurrentRead(file);
      expect(checkReadBeforeMutation(file, "edit").ok).toBe(true);
    });
  });

  it("blocks editing a file that changed on disk since the read", () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    runWithSessionContext({ sessionKey: "s1" }, () => {
      recordCurrentRead(file);
      writeFileSync(file, "hello world — changed and longer");
      const result = checkReadBeforeMutation(file, "edit");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("changed on disk");
      }
    });
  });

  it("allows edits when session-awareness is disabled", () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "hello");
    sessionActivityRegistry.setEnabled(false);
    try {
      runWithSessionContext({ sessionKey: "s1" }, () => {
        expect(checkReadBeforeMutation(file, "edit").ok).toBe(true);
      });
    } finally {
      sessionActivityRegistry.setEnabled(true);
    }
  });
});
