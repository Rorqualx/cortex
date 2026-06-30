// Refuse an in-place build that would crash the live gateway with active cron runs.
//
// `pnpm build` (node scripts/build-all.mjs) rewrites dist/; the live gateway
// imports those chunks, so building the SAME tree the gateway runs from crashes
// it on the next dynamic import — killing every in-flight cron run in the process
// (research scans, skill-forge, the Implementation/upstream jobs). The sanctioned
// restart is the deploy pipeline (scripts/cron-deploy-build.sh), which quiesces
// first. This guard makes the build itself refuse a self-inflicted build-suicide,
// closing the hole for ad-hoc or cron-agent `pnpm build` calls that bypass the
// deploy gate (e.g. the Implementation cron building to "verify" its own edits).
//
// It fires ONLY when ALL hold, so worktree / CI / foreign-root builds are never
// blocked:
//   1. not explicitly sanctioned (deploy/force/CI env), AND
//   2. a non-stale cron run is active (cron-restart-safe-wait.sh --once => 3), AND
//   3. a live gateway is running from THIS repo root (ps match on <root>/dist).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveRepoRoot } from "./ts-guard-utils.mjs";

// Operator-granted exemptions: these consciously skip the guard.
const SANCTIONED_FLAGS = ["OPENCLAW_DEPLOY_BUILD", "OPENCLAW_BUILD_FORCE"];

function isSanctioned() {
  // Memoization (not an exemption): build-all.mjs sets this after its own check so
  // the tsdown child it spawns does not repeat the subprocess-heavy probe. Direct
  // tsdown callers do not inherit it and still gate themselves.
  if (process.env.OPENCLAW_BUILD_SAFE_CHECKED === "1") {
    return true;
  }
  // CI/deploy/force builds own their own restart timing; never gate them. Accept
  // both common CI truthy spellings ("true" and "1") — prod-restart.sh builds with
  // CI=1, and CI providers vary.
  const ci = process.env.CI;
  if (ci === "true" || ci === "1") {
    return true;
  }
  return SANCTIONED_FLAGS.some((flag) => process.env[flag] === "1");
}

// Realistic gateway entry points launched from this tree — a deliberate subset of
// src/infra/gateway-process-argv.ts (isGatewayArgv): the dist forms the production
// launchd gateway runs, plus the openclaw.mjs launcher. Generic runners
// (run-node.mjs) and tsx src entries are omitted so unrelated node processes are
// not misidentified as the gateway.
const GATEWAY_ENTRY_SUFFIXES = ["dist/index.js", "dist/entry.js", "openclaw.mjs"];

// Both the resolved build root and its realpath, so a launchd entry installed via a
// symlinked path still ties to this tree.
function gatewayEntryPaths(root) {
  const roots = new Set([root]);
  try {
    roots.add(fs.realpathSync(root));
  } catch {
    // root not resolvable as a real path (unusual); the raw root still applies.
  }
  return [...roots].flatMap((r) => GATEWAY_ENTRY_SUFFIXES.map((suffix) => path.join(r, suffix)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Pure matcher (exported for tests): true when a process line in `psOutput` is a
// gateway launched from `root`. Matches the entry as a whole, boundary-delimited
// path token (not a bare substring, so a sibling like index.jsx never false-matches)
// without splitting on whitespace (so a checkout path containing spaces still
// matches), and lowercases both sides like isGatewayArgv so case-insensitive
// filesystems (APFS) do not cause a false negative.
export function gatewayRunsInPsOutput(psOutput, root) {
  // Precompile one boundary regex per entry path (constant across all ps lines).
  const entryPatterns = gatewayEntryPaths(root).map(
    (entry) =>
      new RegExp(`(?:^|\\s)${escapeRegExp(entry.replaceAll("\\", "/").toLowerCase())}(?:\\s|$)`),
  );
  return psOutput.split("\n").some((line) => {
    const normalized = line.replaceAll("\\", "/").toLowerCase();
    if (!/(?:^|\s)gateway(?:\s|$)/.test(normalized)) {
      return false;
    }
    return entryPatterns.some((pattern) => pattern.test(normalized));
  });
}

// ps is the cross-process, OS-portable way to tie this build's dist to the
// gateway that imports it — no launchd/systemd parsing or hardcoded paths.
function liveGatewayRunsFromRoot(root) {
  const result = spawnSync("ps", ["-axww", "-o", "args="], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    // Cannot enumerate processes. Fail open with a warning: blocking every build on
    // a ps hiccup is worse than this gap, and the deploy path quiesces separately.
    console.error(
      "assert-build-safe: ps probe failed; cannot confirm gateway state, allowing build.",
    );
    return false;
  }
  return gatewayRunsInPsOutput(result.stdout, root);
}

// Exit codes mirror cron-restart-safe-wait.sh: 0 idle, 2 soft-skip (no db/sqlite3),
// 3 active. Any other status means the probe itself broke; the build guard fails
// CLOSED (treat as busy) — unlike the restart recovery gate (cron-quiesce-guard.sh)
// which fails open. A build is deferrable, so when we cannot confirm cron is idle we
// protect the in-flight runs; the operator can override with OPENCLAW_BUILD_FORCE=1.
function otherCronRunsActive(root) {
  const script = path.join(root, "scripts", "cron-restart-safe-wait.sh");
  const result = spawnSync("bash", [script, "--once"], { encoding: "utf8" });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0 || result.status === 2) {
    return { busy: false, detail };
  }
  if (result.status === 3) {
    return { busy: true, detail };
  }
  const note = `assert-build-safe: unexpected cron-check exit ${result.status}; treating as busy.`;
  return { busy: true, detail: detail ? `${detail}\n${note}` : note };
}

export function assertBuildSafe() {
  if (isSanctioned()) {
    return;
  }
  const root = resolveRepoRoot(import.meta.url);
  // Cheap ps check first: if no live gateway runs from this tree, the build cannot
  // crash one, so skip the heavier bash+sqlite cron probe (the common dev case).
  if (!liveGatewayRunsFromRoot(root)) {
    return;
  }
  const { busy, detail } = otherCronRunsActive(root);
  if (!busy) {
    return;
  }
  const message = [
    "BUILD-REFUSED: in-place build would crash the live gateway and kill active cron run(s).",
    detail,
    "",
    "Building this tree rewrites dist/ and crashes the gateway that imports it (launchd",
    "relaunches on the new dist), aborting every in-flight cron run. Use the deploy",
    "pipeline (scripts/cron-deploy-build.sh), which quiesces first, or wait for the run(s)",
    "to finish. To override deliberately: OPENCLAW_BUILD_FORCE=1 pnpm build.",
  ]
    .filter(Boolean)
    .join("\n");
  console.error(message);
  process.exit(3);
}
