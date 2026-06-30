// Tests cover the build-suicide guard's process-detection matcher and the shared
// cron-quiesce gate's exit-code interpretation (busy=3 vs soft-skip=2 vs fail-closed).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayRunsInPsOutput } from "../../scripts/lib/assert-build-safe.mjs";

const ROOT = "/repo/openclaw";

describe("gatewayRunsInPsOutput", () => {
  it("matches a gateway launched from this root", () => {
    const ps = `1 /usr/bin/node ${ROOT}/dist/index.js gateway --port 18789`;
    expect(gatewayRunsInPsOutput(ps, ROOT)).toBe(true);
  });

  it("matches the openclaw.mjs and dist/entry.js launch forms", () => {
    expect(gatewayRunsInPsOutput(`9 node ${ROOT}/openclaw.mjs gateway`, ROOT)).toBe(true);
    expect(gatewayRunsInPsOutput(`9 node ${ROOT}/dist/entry.js gateway`, ROOT)).toBe(true);
  });

  it("ignores a gateway running from a different root", () => {
    const ps = `1 /usr/bin/node /other/tree/dist/index.js gateway --port 18789`;
    expect(gatewayRunsInPsOutput(ps, ROOT)).toBe(false);
  });

  it("ignores a process from this root that is not the gateway", () => {
    expect(gatewayRunsInPsOutput(`1 node ${ROOT}/dist/index.js serve`, ROOT)).toBe(false);
  });

  it("does not substring-match a sibling entry path", () => {
    // index.jsx must not satisfy a match for index.js (per-arg exact comparison).
    expect(gatewayRunsInPsOutput(`1 node ${ROOT}/dist/index.jsx gateway`, ROOT)).toBe(false);
  });

  it("does not match generic runners or tsx src entries (false-positive guard)", () => {
    expect(gatewayRunsInPsOutput(`1 node ${ROOT}/scripts/run-node.mjs gateway`, ROOT)).toBe(false);
    expect(gatewayRunsInPsOutput(`1 tsx ${ROOT}/src/index.ts gateway`, ROOT)).toBe(false);
  });

  it("matches a checkout path containing spaces", () => {
    const spacedRoot = "/Volumes/My Disk/openclaw";
    const ps = `1 /usr/bin/node ${spacedRoot}/dist/index.js gateway --port 18789`;
    expect(gatewayRunsInPsOutput(ps, spacedRoot)).toBe(true);
  });

  it("matches case-insensitively (APFS launchd path casing drift)", () => {
    const ps = `1 node ${ROOT.toLowerCase()}/dist/index.js gateway`;
    expect(gatewayRunsInPsOutput(ps, ROOT)).toBe(true);
  });

  it("does not match a different root that contains this root's entry as a substring", () => {
    const ps = `1 node /other${ROOT}/dist/index.js gateway`;
    expect(gatewayRunsInPsOutput(ps, ROOT)).toBe(false);
  });

  it("returns false for empty output", () => {
    expect(gatewayRunsInPsOutput("", ROOT)).toBe(false);
  });
});

describe("assert_cron_idle exit-code interpretation", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Build a throwaway root whose scripts/cron-restart-safe-wait.sh exits `stubExit`
  // (or, when stubExit is null, omit the helper entirely to simulate a missing one),
  // source the real guard, and return assert_cron_idle's exit code.
  function runAssertCronIdle(stubExit: number | null, env: Record<string, string> = {}): number {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cron-quiesce-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    if (stubExit !== null) {
      fs.writeFileSync(
        path.join(root, "scripts", "cron-restart-safe-wait.sh"),
        `#!/usr/bin/env bash\nexit ${stubExit}\n`,
      );
    }
    const guard = path.resolve(process.cwd(), "scripts/lib/cron-quiesce-guard.sh");
    const result = spawnSync(
      "bash",
      ["-c", `source "${guard}"; assert_cron_idle "${root}"; echo "RC=$?"`],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
    const match = /RC=(\d+)/.exec(result.stdout);
    if (!match) {
      throw new Error(`could not parse RC from: ${result.stdout}\n${result.stderr}`);
    }
    return Number(match[1]);
  }

  it("returns 0 (safe) when the cron check reports idle", () => {
    expect(runAssertCronIdle(0)).toBe(0);
  });

  it("returns 0 (safe) on the soft-skip code (no db / no sqlite3)", () => {
    expect(runAssertCronIdle(2)).toBe(0);
  });

  it("returns 3 (block) when a cron run is active", () => {
    expect(runAssertCronIdle(3)).toBe(3);
  });

  it("fails open (0) on an unexpected exit code so gateway recovery is not bricked", () => {
    expect(runAssertCronIdle(64)).toBe(0);
  });

  it("fails open (0) when the cron-check helper is missing (exit 127)", () => {
    expect(runAssertCronIdle(null)).toBe(0);
  });

  it("returns 0 when FORCE=1 overrides an active run", () => {
    expect(runAssertCronIdle(3, { FORCE: "1" })).toBe(0);
  });

  it("returns 0 when SKIP_ACTIVE_CHECK=1 overrides an active run", () => {
    expect(runAssertCronIdle(3, { SKIP_ACTIVE_CHECK: "1" })).toBe(0);
  });
});
