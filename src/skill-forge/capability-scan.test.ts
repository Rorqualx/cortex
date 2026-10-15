import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_MARKERS,
  CAPABILITY_SCAN_SIDECAR,
  DEFAULT_CAPABILITY_SCAN_CAPS,
  SKILL_CAPABILITY_CLASSES,
  scanSkillBundle,
  scanTextForCapabilities,
  writeCapabilityScanSidecar,
} from "./capability-scan.js";

// Capability vector (2026-10-15 QW2): deterministic, display-only inventory
// of capability classes referenced by a skill bundle. Detection is literal
// substring matching only — by construction immune to the RW-3 ReDoS class.

describe("scanTextForCapabilities", () => {
  it("returns empty vectors for clean prose", () => {
    const vector = scanTextForCapabilities(
      "This skill explains how to write clear documentation and be nice to readers.",
    );
    for (const cls of SKILL_CAPABILITY_CLASSES) {
      expect(vector[cls]).toEqual([]);
    }
  });

  it("detects shell execution", () => {
    const vector = scanTextForCapabilities("const { execSync } = require('child_process');");
    expect(vector["shell-exec"]).toContain("execSync");
    expect(vector["shell-exec"]).toContain("child_process");
  });

  it("detects filesystem reads and writes separately", () => {
    const vector = scanTextForCapabilities("await readFile(p); fs.writeFileSync(q, d);");
    expect(vector["fs-read"]).toContain("readFile");
    expect(vector["fs-write"]).toContain("writeFileSync");
  });

  it("detects network egress actions", () => {
    const vector = scanTextForCapabilities("curl -s https://example.internal/api | jq .");
    expect(vector["network-egress"]).toContain("curl");
  });

  it("does not flag bare URLs as network egress (docs link freely)", () => {
    const vector = scanTextForCapabilities("See https://example.com/docs for details.");
    expect(vector["network-egress"]).toEqual([]);
  });

  it("detects credential access", () => {
    const vector = scanTextForCapabilities("const key = process.env.API_KEY; cat ~/.ssh/id_rsa");
    expect(vector["credential-access"]).toContain("process.env");
    expect(vector["credential-access"]).toContain("API_KEY");
    expect(vector["credential-access"]).toContain("~/.ssh");
    expect(vector["credential-access"]).toContain("id_rsa");
    expect(vector["fs-read"]).toContain("cat ");
  });

  it("marker tables contain only literal substrings (no regex metacharacters)", () => {
    // Guard the linear-time invariant: a marker containing regex
    // metacharacters would suggest someone switched to regex matching.
    const metaChars = /[\\^$.*+?()[\]{}|]/u;
    for (const cls of SKILL_CAPABILITY_CLASSES) {
      for (const marker of CAPABILITY_MARKERS[cls]) {
        expect(metaChars.test(marker)).toBe(false);
      }
    }
  });
});

describe("scanSkillBundle", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "caps-scan-"));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("scans SKILL.md and nested text scripts, merging vectors", async () => {
    await fsp.writeFile(path.join(dir, "SKILL.md"), "# skill\n\nRun `curl` to fetch.\n");
    await fsp.mkdir(path.join(dir, "scripts"));
    await fsp.writeFile(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\nrm -rf /tmp/x\n");
    const result = await scanSkillBundle(dir);
    expect(result.mode).toBe("advisory");
    expect(result.truncated).toBe(false);
    expect(result.filesScanned).toBe(2);
    expect(result.capabilities["network-egress"]).toContain("curl");
    expect(result.capabilities["fs-write"]).toContain("rm ");
  });

  it("skips non-text extensions", async () => {
    await fsp.writeFile(path.join(dir, "SKILL.md"), "# clean\n");
    await fsp.writeFile(path.join(dir, "logo.png"), "curl wget process.env");
    const result = await scanSkillBundle(dir);
    expect(result.filesScanned).toBe(1);
    for (const cls of SKILL_CAPABILITY_CLASSES) {
      expect(result.capabilities[cls]).toEqual([]);
    }
  });

  it("sets truncated when the file cap is exceeded", async () => {
    const caps = { ...DEFAULT_CAPABILITY_SCAN_CAPS, maxFiles: 1 };
    await fsp.writeFile(path.join(dir, "SKILL.md"), "# clean\n");
    await fsp.writeFile(path.join(dir, "notes.txt"), "curl example\n");
    const result = await scanSkillBundle(dir, caps);
    expect(result.truncated).toBe(true);
    expect(result.filesScanned).toBe(1);
  });

  it("returns a truncated zero-file result for a missing directory", async () => {
    const result = await scanSkillBundle(path.join(dir, "does-not-exist"));
    expect(result.filesScanned).toBe(0);
    expect(result.truncated).toBe(true);
  });
});

describe("writeCapabilityScanSidecar", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "caps-sidecar-"));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("writes the JSON sidecar", async () => {
    const result = await scanSkillBundle(dir);
    await writeCapabilityScanSidecar(dir, result);
    const parsed = JSON.parse(
      await fsp.readFile(path.join(dir, CAPABILITY_SCAN_SIDECAR), "utf8"),
    ) as Record<string, unknown>;
    expect(parsed["mode"]).toBe("advisory");
    expect(parsed["filesScanned"]).toBe(0);
  });

  it("never throws when the target is unwritable", async () => {
    const result = await scanSkillBundle(dir);
    await expect(
      writeCapabilityScanSidecar(path.join(dir, "missing", "sub"), result),
    ).resolves.toBeUndefined();
  });
});
