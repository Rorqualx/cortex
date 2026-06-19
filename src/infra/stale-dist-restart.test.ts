import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  armStaleDistRestartGuard,
  noteStaleDistCandidateError,
  resetStaleDistRestartGuardForTest,
} from "./stale-dist-restart.js";

const BOOT_IDENTITY = `${JSON.stringify({ version: "2026.6.2", commit: "aaa111" })}\n`;
const ROTATED_IDENTITY = `${JSON.stringify({ version: "2026.6.3", commit: "bbb222" })}\n`;

function moduleNotFoundError(message = "Cannot find module '/dist/chat-old.js'"): Error {
  const err = new Error(message);
  (err as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
  return err;
}

async function withArmedGuard(
  run: (ctx: {
    identityPath: string;
    requestRestart: ReturnType<typeof vi.fn>;
  }) => void | Promise<void>,
): Promise<void> {
  await withTempDir({ prefix: "openclaw-stale-dist-" }, async (tmp) => {
    const identityPath = path.join(tmp, "build-info.json");
    fs.writeFileSync(identityPath, BOOT_IDENTITY);
    const requestRestart = vi.fn();
    const armed = armStaleDistRestartGuard({
      requestRestart,
      moduleUrl: pathToFileURL(path.join(tmp, "guard-module.js")).href,
    });
    expect(armed).toBe(true);
    await run({ identityPath, requestRestart });
  });
}

describe("stale dist restart guard", () => {
  afterEach(() => {
    resetStaleDistRestartGuardForTest();
  });

  it("requests one restart when identity rotated and latches afterwards", async () => {
    await withArmedGuard(({ identityPath, requestRestart }) => {
      fs.writeFileSync(identityPath, ROTATED_IDENTITY);
      noteStaleDistCandidateError(moduleNotFoundError());
      noteStaleDistCandidateError(moduleNotFoundError());
      expect(requestRestart).toHaveBeenCalledTimes(1);
      expect(requestRestart).toHaveBeenCalledWith("gateway.restart.stale-dist");
    });
  });

  it("detects the module-not-found code on a wrapped cause chain", async () => {
    await withArmedGuard(({ identityPath, requestRestart }) => {
      fs.writeFileSync(identityPath, ROTATED_IDENTITY);
      const wrapped = new Error("dispatch failed", { cause: moduleNotFoundError() });
      noteStaleDistCandidateError(wrapped);
      expect(requestRestart).toHaveBeenCalledTimes(1);
    });
  });

  it("does not restart when identity is unchanged (packaging bug, not rotation)", async () => {
    await withArmedGuard(({ requestRestart }) => {
      noteStaleDistCandidateError(moduleNotFoundError());
      expect(requestRestart).not.toHaveBeenCalled();
    });
  });

  it("does not restart while the identity file is missing mid-rebuild", async () => {
    await withArmedGuard(({ identityPath, requestRestart }) => {
      fs.rmSync(identityPath);
      noteStaleDistCandidateError(moduleNotFoundError());
      expect(requestRestart).not.toHaveBeenCalled();
      // Build finished writing a rotated identity: the next failure fires.
      fs.writeFileSync(identityPath, ROTATED_IDENTITY);
      noteStaleDistCandidateError(moduleNotFoundError());
      expect(requestRestart).toHaveBeenCalledTimes(1);
    });
  });

  it("ignores errors without a module-not-found code", async () => {
    await withArmedGuard(({ identityPath, requestRestart }) => {
      fs.writeFileSync(identityPath, ROTATED_IDENTITY);
      noteStaleDistCandidateError(new Error("boom"));
      noteStaleDistCandidateError("string failure");
      noteStaleDistCandidateError(null);
      expect(requestRestart).not.toHaveBeenCalled();
    });
  });

  it("stays disarmed when no identity file resolves at arm time", async () => {
    await withTempDir({ prefix: "openclaw-stale-dist-" }, async (tmp) => {
      const requestRestart = vi.fn();
      const armed = armStaleDistRestartGuard({
        requestRestart,
        moduleUrl: pathToFileURL(path.join(tmp, "guard-module.js")).href,
      });
      expect(armed).toBe(false);
      noteStaleDistCandidateError(moduleNotFoundError());
      expect(requestRestart).not.toHaveBeenCalled();
    });
  });
});
