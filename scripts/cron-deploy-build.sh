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
# Build the bundle directly instead of `pnpm build` so pnpm 11's verify-deps
# pre-run install does not fire: it can wedge for minutes and re-runs native
# postinstalls (e.g. node-llama-cpp) that fail under x64/Rosetta node. `pnpm build`
# is itself just `node --import tsx scripts/build-all.mts`; the gate already proved deps resolve.
# OPENCLAW_DEPLOY_BUILD=1 marks this as the one sanctioned in-place build so the
# build-suicide guard (scripts/lib/assert-build-safe.mjs) stands down: this path
# already waited for quiesce above, and the deploy job's own running marker would
# otherwise trip the guard's --once check.
env OPENCLAW_DEPLOY_BUILD=1 CI=1 npm_config_verify_deps_before_run=false node --import tsx scripts/build-all.mts
build_rc=$?

# The tsdown phases clean dist/ (outDir: "dist"), which races/wipes the ui:build
# output, leaving dist/control-ui empty. The gateway caches its control-ui root at
# boot, so a wiped UI is a persistent 503 that the build's crash-relaunch cannot
# clear on its own. Rebuild the UI if it was wiped, then bounce the gateway once more
# so it boots with the assets present. (prod-restart.sh guards the same way.)
#
# Verify + retry rather than a fire-and-forget `pnpm ui:build || true`: ui:build
# wipes dist/control-ui via vite emptyOutDir at the START, so an interrupted or
# failed single attempt leaves NO index.html — and an unchecked rebuild then
# bounced the gateway onto that empty root, which is how the dashboard stayed 503
# across deploys. Only bounce after the assets are confirmed present; if two
# attempts still fail, leave the gateway on the current dist and warn loudly rather
# than kickstart it onto a known-empty root.
if [ ! -f "$ROOT/dist/control-ui/index.html" ]; then
  echo "==> control-ui wiped by the build; rebuilding before the final bounce..."
  for attempt in 1 2; do
    (cd "$ROOT" && CI=1 npm_config_verify_deps_before_run=false pnpm ui:build) || true
    [ -f "$ROOT/dist/control-ui/index.html" ] && break
    echo "==> ui:build attempt $attempt left control-ui empty (interrupted emptyOutDir?)."
  done
  if [ -f "$ROOT/dist/control-ui/index.html" ]; then
    echo "==> control-ui restored; bouncing the gateway to clear the cached empty root..."
    launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
  else
    echo "DEPLOY-WARN: control-ui still missing after 2 rebuilds; NOT bouncing onto an empty root. Dashboard stays on the current dist; fix pnpm ui:build." >&2
  fi
fi
exit "$build_rc"
