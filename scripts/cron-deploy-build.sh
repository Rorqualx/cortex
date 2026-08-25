#!/usr/bin/env bash
#
# FINAL deploy action for the "Validate & Deploy" cron pipeline.
#
# The in-place `pnpm build` rewrites dist/ and crashes the live gateway; launchd
# relaunches it on the fresh dist — so the build IS the deploy. Because that crash
# kills every OTHER in-flight cron run (research scans, skill-forge, the nightly
# upstream-merge job), this wrapper first WAITS until no other cron job is running,
# then launches the detached health watcher, then builds. Folding the quiesce gate
# into the build step (instead of trusting the agent to run it) makes the safety
# structural, not advisory.
#
# Exit 3 = deferred (other cron jobs were still running past the wait window); the
#          gateway is left untouched and the deploy should be retried later.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The "Validate & Deploy" cron job id. It is itself marked running while this
# wrapper executes, so it must be excluded from the quiesce check — otherwise the
# gate would always see one running job (itself) and never proceed. This is the
# one job that is allowed to trigger the restart.
DEPLOY_JOB_ID="${DEPLOY_CRON_JOB_ID:-9d1cec60-4db3-4c7c-a0da-447b7bcf26ce}"
QUIESCE_TIMEOUT="${QUIESCE_TIMEOUT:-1800}"

# Single-flight: only ONE deploy build may run at a time. Two triggers — a land's
# detached cron-deploy-build.sh (from land_and_deploy) and the scheduled "Validate &
# Deploy" cron — can otherwise run build-all concurrently, and their tsdown emptyOutDir
# passes race on dist/: the recurring wiped-control-ui 503, plus a half-built/corrupt
# dist the gateway then boots. The quiesce gate below only waits on TRACKED cron jobs
# (cron_jobs.running_at_ms); a detached deploy build is not one, so it needs its own
# process lock. Acquire it BEFORE quiesce so even a quiesce-waiting deploy blocks a
# second trigger. A deploy in progress already ships current main, so a colliding
# trigger SKIPS (exit 0) rather than queueing — the next scheduled deploy or land picks
# up any newer commits. Stale locks (the build-crash / watcher `launchctl stop` can
# SIGKILL the holder before its EXIT trap fires) are reclaimed on a dead holder pid.
DEPLOY_LOCK_DIR="${DEPLOY_LOCK_DIR:-/tmp/openclaw-deploy-build.lock.d}"
if ! mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null; then
  deploy_holder="$(cat "$DEPLOY_LOCK_DIR/pid" 2>/dev/null || true)"
  # Age backstop: a legit deploy holds the lock for at most quiesce (≤30min) + build
  # (~10min). Reclaim a much older one even if its pid still looks alive — a hung or
  # orphaned tsdown (playbook §5: ~8.5GB, orphaned bundlers that don't exit) would
  # otherwise deadlock every future deploy. 90min is far above any real hold, so this
  # never reclaims a live legit build, only a stuck one.
  lock_age=$(( $(date +%s) - $(stat -f %m "$DEPLOY_LOCK_DIR" 2>/dev/null || echo 0) ))
  if [ -n "$deploy_holder" ] && kill -0 "$deploy_holder" 2>/dev/null && [ "$lock_age" -lt 5400 ]; then
    echo "DEPLOY-SKIP: another deploy build (pid=$deploy_holder, held ${lock_age}s) is in progress; it ships current main. Skipping this trigger."
    exit 0
  fi
  echo "==> reclaiming deploy lock (holder pid=${deploy_holder:-none}, age=${lock_age}s: dead pid or hung >90min)"
  rm -rf "$DEPLOY_LOCK_DIR"
  mkdir "$DEPLOY_LOCK_DIR" 2>/dev/null || { echo "DEPLOY-SKIP: deploy lock race; skipping this trigger."; exit 0; }
fi
printf '%s\n' "$$" >"$DEPLOY_LOCK_DIR/pid"
trap 'rm -rf "$DEPLOY_LOCK_DIR"' EXIT

echo "==> Quiesce: waiting for other cron jobs to finish before the restarting build..."
if ! bash "$ROOT/scripts/cron-restart-safe-wait.sh" --self "$DEPLOY_JOB_ID" --timeout "$QUIESCE_TIMEOUT"; then
  echo "DEPLOY-DEFER: other cron job(s) still running after ${QUIESCE_TIMEOUT}s; NOT building."
  echo "DEPLOY-DEFER: gateway left intact — re-run the deploy once the board is idle."
  exit 3
fi

# Health watcher must be detached so it survives the build-crash, waits for the
# launchd relaunch, and records HEALTHY/UNHEALTHY for the 08:00 briefing.
echo "==> Launching detached post-deploy health watcher..."
nohup bash "$ROOT/scripts/cron-deploy-healthcheck.sh" >/dev/null 2>&1 &

# Build + repair dist (dropped plugin manifests, wiped control-ui) + bounce-if-repaired
# via the shared core, so the deploy and the post-deploy auto-recovery use one canonical
# path. run_deploy_build_step returns the build's own exit code.
# shellcheck source=scripts/lib/deploy-build-core.sh
source "$ROOT/scripts/lib/deploy-build-core.sh"
run_deploy_build_step "$ROOT"
exit $?
