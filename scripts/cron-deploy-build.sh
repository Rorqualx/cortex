#!/usr/bin/env bash
#
# FINAL deploy action for the "Validate & Deploy" cron pipeline.
#
# Two modes, chosen by whether the atomic release layout is installed
# (scripts/deploy-release-migrate.sh; dist.current is a symlink):
#
#   MIGRATED (atomic swap): the build writes the scratch `dist` dir, NOT the release the
#   gateway serves, so it never crashes the running gateway. We build, verify, and ONLY
#   on success clone dist into a new release + atomically repoint dist.current + bounce.
#   A failed or incomplete build never promotes, so the live gateway keeps serving the
#   last-good release — a build failure is no longer an outage. The expensive build runs
#   WITHOUT the quiesce gate (it is gateway-safe); only the instant promote+bounce is
#   quiesced, so crons run through the build.
#
#   LEGACY (pre-migration): the in-place `pnpm build` rewrites the live dist and crashes
#   the gateway; launchd relaunches on the fresh dist — the build IS the deploy. That
#   crash kills every other in-flight cron, so we quiesce first, then build.
#
# Exit 3 = deferred (other cron jobs still running past the wait window; gateway intact).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/deploy-build-core.sh
source "$ROOT/scripts/lib/deploy-build-core.sh"
# shellcheck source=scripts/lib/deploy-release-swap.sh
source "$ROOT/scripts/lib/deploy-release-swap.sh"

# The daily "Midnight Deploy" cron job id — excluded from the quiesce check (it is the job
# that triggers this wrapper and is briefly marked running) and the one job allowed to trigger
# a restart. Deploy was decoupled on 2026-08-26 from both the hourly upstream-merge land and the
# 7am research "Validate & Deploy" job (9d1cec60, now push-only); the midnight cron owns deploy
# now and sets DEPLOY_CRON_JOB_ID explicitly, so this default only covers a manual UM_DEPLOY=1 land.
DEPLOY_JOB_ID="${DEPLOY_CRON_JOB_ID:-9a206be3-dec8-4c81-8f63-22a2c7cdfd1d}"
QUIESCE_TIMEOUT="${QUIESCE_TIMEOUT:-1800}"

quiesce() {
  echo "==> Quiesce: waiting for other cron jobs to finish before the gateway bounce..."
  if ! bash "$ROOT/scripts/cron-restart-safe-wait.sh" --self "$DEPLOY_JOB_ID" --timeout "$QUIESCE_TIMEOUT"; then
    echo "DEPLOY-DEFER: other cron job(s) still running after ${QUIESCE_TIMEOUT}s; NOT bouncing."
    echo "DEPLOY-DEFER: gateway left intact — re-run the deploy once the board is idle."
    return 1
  fi
}
dispatch_healthcheck() {
  # Detached so it survives the bounce, waits for the relaunch, and records + auto-recovers.
  # ${1+"$@"}: expand args only when there is at least one — a bare "$@" with no args is an
  # unbound-variable error under `set -u` on macOS system bash 3.2, which (backgrounded with
  # output discarded) would silently kill the legacy-mode dispatch and lose the watcher.
  echo "==> Launching detached post-deploy health watcher..."
  nohup env ${1+"$@"} bash "$ROOT/scripts/cron-deploy-healthcheck.sh" >/dev/null 2>&1 &
}
bounce_gateway() { launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true; }

# Single-flight: only ONE dist-mutating op at a time (this deploy, a healthcheck rebuild, or
# the release migration) — the deploy's two triggers (a land's detached cron-deploy-build.sh
# and the scheduled "Validate & Deploy" cron) plus those siblings otherwise race dist/.
# Acquire BEFORE anything else; a colliding trigger SKIPS (it ships current main). Shared
# helper reclaims a dead holder / >90min hang. See deploy-build-core.sh.
if ! try_acquire_deploy_lock; then
  echo "DEPLOY-SKIP: another dist-mutating op (pid=${DEPLOY_LOCK_HOLDER:-?}, held ${DEPLOY_LOCK_AGE}s) is in progress; it ships current main. Skipping this trigger."
  exit 0
fi
trap 'release_deploy_lock' EXIT

if deploy_is_migrated "$ROOT"; then
  echo "==> Deploy mode: ATOMIC SWAP (serving $(basename "$(dirname "$(deploy_serving_release "$ROOT")")"))"
  # Build is gateway-safe (writes scratch dist, not the serving release) — no quiesce.
  build_dist_and_repair "$ROOT"
  build_rc=$?
  if [ "$build_rc" != 0 ] || ! deploy_dist_complete "$ROOT"; then
    # A 0 build rc but incomplete dist (e.g. ui:build failed twice) still shipped nothing —
    # force a nonzero exit so the cron/land caller sees failure and retries/alerts.
    [ "$build_rc" = 0 ] && build_rc=1
    echo "DEPLOY-ABORT: build failed or dist incomplete (exit $build_rc); NOT promoting. Gateway still serves the last-good release — no outage."
    command -v osascript >/dev/null 2>&1 && osascript -e 'display notification "Deploy build FAILED — gateway kept on last-good release (no promote)" with title "OpenClaw cron"' >/dev/null 2>&1 || true
    exit "$build_rc"
  fi
  # Only the instant promote+bounce disrupts the gateway — quiesce just for that.
  quiesce || exit 3
  new_rel="$(promote_release "$ROOT")" || { echo "DEPLOY-ABORT: promote refused; gateway unchanged."; exit 1; }
  # Dispatch the watcher AFTER promote and IMMEDIATELY before the bounce, so it captures
  # the pre-bounce pid and assesses the NEW release the bounce brings up. Dispatching
  # earlier (before quiesce) would let it assess the still-up old gateway, record HEALTHY
  # for a swap that had not happened, and — if quiesce deferred or promote refused — roll
  # the live symlink back for no reason. SKIP_BUILD_WAIT: the build already finished.
  echo "==> Promoted $(basename "$new_rel"); bouncing gateway onto it..."
  dispatch_healthcheck CRON_HEALTHCHECK_SKIP_BUILD_WAIT=1
  bounce_gateway
  echo "DEPLOY-OK: atomic swap complete — gateway now serves $(basename "$new_rel")."
  exit 0
fi

# --- LEGACY (pre-migration) in-place deploy ---------------------------------
echo "==> Deploy mode: LEGACY in-place (run scripts/deploy-release-migrate.sh to enable atomic swap)"
quiesce || exit 3
dispatch_healthcheck
build_dist_and_repair "$ROOT"
build_rc=$?
# The in-place build crashed the gateway; bounce once if we repaired dist so it boots on
# the complete dist rather than crash-looping / serving a cached empty root.
if [ "$DEPLOY_DIST_REPAIRED" = 1 ]; then
  echo "==> repaired dist; bouncing the gateway to boot on the complete dist..."
  bounce_gateway
fi
exit "$build_rc"
