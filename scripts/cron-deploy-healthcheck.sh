#!/usr/bin/env bash
#
# Post-deploy gateway health check for the cron "Validate & Deploy" pipeline.
#
# The deploy build crashes the gateway; launchd relaunches it on the new dist.
# Nothing currently confirms the relaunched gateway is actually healthy. Run this
# DETACHED right before the deploy build so it OUTLIVES the crash, waits for the
# relaunch, and records the result:
#
#   nohup bash scripts/cron-deploy-healthcheck.sh >/dev/null 2>&1 &
#   rm -f ~/.openclaw/update-check.json && pnpm build
#
# Writes HEALTHY/UNHEALTHY to memory/reports/deploy-health-YYYY-MM-DD.md (which
# the 08:00 briefing reads). Exit 0 healthy, 1 unhealthy.
#
# Env (testing): CRON_HEALTHCHECK_TIMEOUT, CRON_HEALTHCHECK_INTERVAL,
#                CRON_HEALTHCHECK_URL, CRON_HEALTHCHECK_REPORT.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TIMEOUT="${CRON_HEALTHCHECK_TIMEOUT:-240}"
INTERVAL="${CRON_HEALTHCHECK_INTERVAL:-10}"
REPORT="${CRON_HEALTHCHECK_REPORT:-$ROOT/memory/reports/deploy-health-$(date +%F).md}"
URL_ARG=()
[ -n "${CRON_HEALTHCHECK_URL:-}" ] && URL_ARG=(--url "$CRON_HEALTHCHECK_URL")
mkdir -p "$(dirname "$REPORT")" 2>/dev/null || true

probe="$(mktemp)"
trap 'rm -f "$probe"' EXIT
deadline=$(( $(date +%s) + TIMEOUT ))
healthy=0
while :; do
  if node "$ROOT/openclaw.mjs" gateway status --require-rpc --json "${URL_ARG[@]+"${URL_ARG[@]}"}" >"$probe" 2>/dev/null; then
    healthy=1
    break
  fi
  [ "$(date +%s)" -ge "$deadline" ] && break
  sleep "$INTERVAL"
done

ts="$(date '+%Y-%m-%d %H:%M:%S %Z')"
if [ "$healthy" = "1" ]; then
  ver="$(python3 -c "import json,sys
raw=open('$probe').read(); i=raw.find('{')
print(json.loads(raw[i:]).get('version','') if i>=0 else '')" 2>/dev/null || true)"
  printf '## Deploy health %s\nHEALTHY — gateway running, RPC probe ok%s\n\n' "$ts" "${ver:+ (version $ver)}" >> "$REPORT"
  echo "HEALTHCHECK-PASS: gateway healthy${ver:+ (version $ver)}"
  exit 0
fi

printf '## Deploy health %s\nUNHEALTHY — gateway RPC probe failed for %ss after the deploy. Investigate immediately (the deploy may have left a broken dist).\n\n' "$ts" "$TIMEOUT" >> "$REPORT"
# Best-effort local alert — chat alerts are unreliable when the gateway is down.
# Suppressed when CRON_HEALTHCHECK_NO_NOTIFY is set (so tests don't fire real alerts).
if [ -z "${CRON_HEALTHCHECK_NO_NOTIFY:-}" ] && command -v osascript >/dev/null 2>&1; then
  osascript -e 'display notification "Deploy left the gateway UNHEALTHY" with title "OpenClaw cron"' >/dev/null 2>&1 || true
fi
echo "HEALTHCHECK-FAIL: gateway RPC probe failed for ${TIMEOUT}s after deploy"
exit 1
