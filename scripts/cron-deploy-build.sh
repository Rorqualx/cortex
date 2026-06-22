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

echo "==> Building (this crashes the gateway; launchd relaunches on the fresh dist = deploy complete)..."
rm -f "$HOME/.openclaw/update-check.json"
cd "$ROOT"
exec pnpm build
