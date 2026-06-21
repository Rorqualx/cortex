#!/usr/bin/env bash
#
# Pre-deploy build gate for the cron "Validate & Deploy" agent.
#
# The deploy step is an in-place `pnpm build` in the LIVE tree: it rewrites
# dist/ and crashes the gateway (launchd relaunches on the new dist). If that
# build FAILS, the gateway relaunches on a half-written/stale dist and stays
# broken (ERR_MODULE_NOT_FOUND) until a human fixes it.
#
# This gate proves the deploy build will succeed BEFORE that irreversible step,
# by building the exact deploy commit in the cron worktree — a separate checkout
# with its own dist/, so building here does NOT touch the live gateway.
#
#   GATE-PASS (exit 0)  -> safe to push + deploy
#   GATE-FAIL (exit 1)  -> build broke; do NOT push, do NOT deploy
#   exit 2              -> gate could not run (worktree missing/dirty)
#
# Env overrides (testing): CRON_DEPLOY_WORKTREE, CRON_DEPLOY_REF.
set -uo pipefail

LIVE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKTREE="${CRON_DEPLOY_WORKTREE:-${LIVE_ROOT}-cron}"
DEPLOY_REF="${CRON_DEPLOY_REF:-$(git -C "$LIVE_ROOT" rev-parse HEAD)}"

fail() { echo "GATE-FAIL: $1"; exit "${2:-1}"; }

[ -e "$WORKTREE/.git" ] || fail "cron worktree not found at $WORKTREE (set CRON_DEPLOY_WORKTREE)" 2
git -C "$WORKTREE" rev-parse --git-dir >/dev/null 2>&1 || fail "$WORKTREE is not a git worktree" 2

# Never discard in-progress work: refuse to sync+build a dirty worktree.
if [ -n "$(git -C "$WORKTREE" status --porcelain)" ]; then
  fail "cron worktree has uncommitted changes; resolve before deploying" 2
fi

ORIG_BRANCH="$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo cron-work)"
restore() { git -C "$WORKTREE" checkout --quiet "$ORIG_BRANCH" 2>/dev/null || true; }
trap restore EXIT

git -C "$WORKTREE" checkout --quiet --detach "$DEPLOY_REF" \
  || fail "cannot check out deploy commit $DEPLOY_REF in worktree" 2

SHORT="$(git -C "$WORKTREE" rev-parse --short HEAD)"
echo "Build gate: building deploy commit $SHORT in isolated worktree $WORKTREE ..."
log="$(mktemp)"
# CI=1 + confirm-modules-purge=false keeps pnpm non-interactive in the worktree
# (it otherwise aborts the deps-sync purge with ERR_..._NO_TTY). --frozen-lockfile
# installs exactly the deploy commit's deps and fails if package.json/lockfile
# drifted — which is itself a deploy blocker worth catching.
#
# Resource cap: a full install+build is the heaviest moment of the whole cron run
# and executes on the box hosting the live gateway. Run it CPU-de-prioritized so
# the build cannot starve the gateway into a crash-restart that kills the in-flight
# job before it deploys. (nice only reorders CPU, not RAM, but removes the CPU
# contention that compounded past OOM/crash deaths during this gate.)
if (
  cd "$WORKTREE" &&
    CI=1 nice -n 19 pnpm install --frozen-lockfile --config.confirm-modules-purge=false &&
    CI=1 nice -n 19 pnpm build
) >"$log" 2>&1; then
  echo "GATE-PASS: deploy build verified at $SHORT (live gateway untouched)"
  rm -f "$log"
  exit 0
fi

echo "GATE-FAIL: deploy build FAILED at $SHORT — aborting deploy so the gateway is not left on a broken dist."
echo "----- last 25 lines of build output -----"
tail -25 "$log"
rm -f "$log"
exit 1
