#!/usr/bin/env bash
#
# Deploy staleness check, run by the Midnight Deploy cron BEFORE it dispatches the deploy.
# Exit 1 (cron receipt = error -> failure alert) when the serving release lags main and
# no deploy has succeeded recently. Exists because a deploy that never ran (2026-10-02..15:
# dispatch killed before detaching) or always aborts looked identical to success: the cron
# receipt only says "dispatched" and the /tmp deploy logs are overwritten every run.
#
#   STALE_AFTER_HOURS   lag tolerated before alerting (default 48)
#   DEPLOY_HISTORY_LOG  written by cron-deploy-build.sh (default ~/.openclaw/logs/deploy-history.log)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STALE_AFTER_HOURS="${STALE_AFTER_HOURS:-48}"
HISTORY="${DEPLOY_HISTORY_LOG:-$HOME/.openclaw/logs/deploy-history.log}"
INFO="$ROOT/dist.current/build-info.json"

serving_commit="$(sed -n 's/.*"commit": *"\([0-9a-f]*\)".*/\1/p' "$INFO" 2>/dev/null | head -1)"
[ -n "$serving_commit" ] || { echo "DEPLOY-STALE: cannot read serving commit from $INFO"; exit 1; }

behind="$(git -C "$ROOT" rev-list --count "$serving_commit..HEAD" 2>/dev/null)"
[ -n "$behind" ] || { echo "DEPLOY-STALE: serving commit $serving_commit is not in main's history"; exit 1; }
if [ "$behind" = 0 ]; then
  echo "DEPLOY-FRESH: serving ${serving_commit:0:11} = main"
  exit 0
fi

# Age of the serving release (promote clones without preserving mtimes, so build-info.json's
# mtime is the promote time). Commit dates would mislead: merged upstream commits carry
# their original, often weeks-old, dates.
promoted_at="$(stat -f %m "$INFO" 2>/dev/null || echo 0)"
age_h=$(( ($(date +%s) - promoted_at) / 3600 ))
if [ "$age_h" -lt "$STALE_AFTER_HOURS" ]; then
  echo "DEPLOY-OK: $behind commit(s) pending for ${age_h}h (< ${STALE_AFTER_HOURS}h)"
  exit 0
fi

last="$(tail -n 1 "$HISTORY" 2>/dev/null)"
echo "DEPLOY-STALE: gateway serves ${serving_commit:0:11}, $behind commit(s) behind main for ${age_h}h. Last deploy run: ${last:-none recorded in $HISTORY}. See /tmp/midnight-deploy.log."
exit 1
