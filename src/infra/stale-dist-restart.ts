// Gateway stale-dist restart guard.
// When dist/ is rebuilt or swapped under a live gateway (source rebuild, npm
// update without restart, rollback), already-loaded chunks lazily import hashed
// files that no longer exist and every affected path fails with
// ERR_MODULE_NOT_FOUND until the process restarts. This guard detects that
// state from caught dispatch errors and requests one safe gateway restart.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway");

// Mirrors the dist-relative build-info.json resolution in src/version.ts.
// build-info.json ships in the npm package and is rewritten by every local
// build, so its bytes identify the dist generation in both install modes.
const BUILD_INFO_CANDIDATES = [
  "./build-info.json",
  "../build-info.json",
  "../../build-info.json",
] as const;

const MODULE_NOT_FOUND_CODES = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);
const MAX_CAUSE_DEPTH = 5;

type ArmedGuard = {
  identityPath: string;
  bootIdentity: string;
  requestRestart: (reason: string) => void;
  fired: boolean;
};

let armedGuard: ArmedGuard | null = null;

function readFileOrNull(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function resolveBuildIdentityFile(moduleUrl: string): { path: string; identity: string } | null {
  for (const candidate of BUILD_INFO_CANDIDATES) {
    let candidatePath: string;
    try {
      candidatePath = fileURLToPath(new URL(candidate, moduleUrl));
    } catch {
      continue;
    }
    const identity = readFileOrNull(candidatePath);
    if (identity !== null) {
      return { path: candidatePath, identity };
    }
  }
  return null;
}

function hasModuleNotFoundCode(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (typeof current !== "object") {
      return false;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && MODULE_NOT_FOUND_CODES.has(code)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function summarizeIdentity(identity: string): string {
  try {
    const parsed = JSON.parse(identity) as { version?: string; commit?: string };
    const version = typeof parsed.version === "string" ? parsed.version : "unknown";
    const commit = typeof parsed.commit === "string" ? parsed.commit.slice(0, 12) : "unknown";
    return `${version}@${commit}`;
  } catch {
    return "unparseable";
  }
}

/**
 * Capture the dist build identity for the lifetime of this gateway process.
 * Returns false (guard disarmed) when no identity file is readable, e.g.
 * source-mode test runs. Gateway-only: one-shot CLI processes must not arm,
 * since the injected restart path signals the current process.
 */
export function armStaleDistRestartGuard(opts: {
  requestRestart: (reason: string) => void;
  moduleUrl?: string;
}): boolean {
  const resolved = resolveBuildIdentityFile(opts.moduleUrl ?? import.meta.url);
  if (!resolved) {
    armedGuard = null;
    return false;
  }
  armedGuard = {
    identityPath: resolved.path,
    bootIdentity: resolved.identity,
    requestRestart: opts.requestRestart,
    fired: false,
  };
  return true;
}

/**
 * Inspect a caught dispatch error for the stale-dist signature and request one
 * safe gateway restart when the dist generation provably rotated.
 */
export function noteStaleDistCandidateError(err: unknown): void {
  const guard = armedGuard;
  if (!guard || guard.fired || !hasModuleNotFoundCode(err)) {
    return;
  }
  // The identity re-read is the authoritative rotation proof: unchanged bytes
  // mean a packaging/plugin bug a restart cannot fix (and would loop on), and
  // a missing file means a build is mid-rewrite — the next failure after the
  // build completes re-checks and fires then.
  const currentIdentity = readFileOrNull(guard.identityPath);
  if (currentIdentity === null || currentIdentity === guard.bootIdentity) {
    return;
  }
  guard.fired = true;
  log.warn(
    `dist build identity changed while the gateway was running (${summarizeIdentity(guard.bootIdentity)} -> ${summarizeIdentity(currentIdentity)}); loaded chunks now import missing files (${formatModuleNotFoundDetail(err)}). Requesting gateway restart to load current code.`,
  );
  guard.requestRestart("gateway.restart.stale-dist");
}

function formatModuleNotFoundDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const firstLine = message.split("\n", 1)[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

export function resetStaleDistRestartGuardForTest(): void {
  armedGuard = null;
}
