#!/usr/bin/env bash
#
# Frequent, deploy-decoupled sync of local main -> origin/main.
#
# Several autonomous crons (daily-research, skill-forge, improvement-lab, ...) commit to
# local main and leave the push to the next upstream-merge land. When that land is slow
# (a large resync residual) their commits pile up UN-PUSHED for hours: durability risk,
# and — because origin/main falls behind local main — every upstream-merge stage then
# starts from a main that has drifted from origin, which is exactly what turns a sibling
# commit during the ~1h resolution into an ff-blocked land (see cron-upstream-merge.sh
# absorb_local_main + the resume-off-ref guard, which recover from that; this prevents
# it at the source). A push is NOT a deploy — it never rewrites dist/ and never restarts
# the gateway — so this can run on its own cadence to keep origin synced and the
# divergence window small.
#
# Fast-forward only, never force: if local main is not a clean fast-forward of
# origin/main (they diverged) it does nothing and reports — a divergence is a bug to
# surface, not to paper over with --force. Skips while an upstream-merge land or a deploy
# build is running so it never races their own push.
#
# Exit: 0 = in sync (pushed or already current, or safely skipped) ·
#       1 = push failed or diverged (reported, main untouched).
set -uo pipefail

MAIN="${SYNC_MAIN_TREE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$MAIN" || { echo "MAIN-SYNC-ABORT: main tree missing"; exit 1; }

log() { echo "[main-sync] $*" >&2; }

# Only operate on a clean main checkout: never push a cron's half-done edits, never
# touch an operator branch. A dirty tree means a cron is mid-commit — skip this tick.
cur="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$cur" != "main" ]; then log "live tree on '$cur', not main — skip"; exit 0; fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "main has uncommitted tracked changes (a cron is mid-commit) — skip"; exit 0
fi

# Never race a SEPARATE upstream-merge land/route (it will push), or a deploy build
# (rewriting dist/ and about to bounce the gateway). pgrep the exact scripts.
#
# Caller exemption: when `cron-upstream-merge.sh route` calls this synchronously it sets
# SYNC_CALLER=route, and the only process matching the pgrep below is that caller itself
# — which holds the upstream-merge singleton lock and has NOT staged/landed yet (the safe
# pre-stage window). Without the exemption the guard would match its own parent and make
# the route-time sync an unconditional no-op.
if [ "${SYNC_CALLER:-}" != "route" ] &&
  pgrep -f 'cron-upstream-merge\.sh (finish-land|route)' >/dev/null 2>&1; then
  log "upstream-merge land/route in progress — skip this sync tick"; exit 0
fi
if pgrep -f 'cron-deploy-build\.sh|build-all\.mts' >/dev/null 2>&1; then
  log "deploy build in progress — skip this sync tick"; exit 0
fi

git fetch origin -q 2>/dev/null || { log "fetch origin failed"; exit 1; }
local_sha="$(git rev-parse main)"
origin_sha="$(git rev-parse origin/main 2>/dev/null || echo '')"
if [ "$local_sha" = "$origin_sha" ]; then
  echo "MAIN-SYNC OK: already in sync at $(git rev-parse --short main)"
  exit 0
fi
# origin/main must be an ancestor of local main — a plain fast-forward. If it is not,
# origin holds a commit local main lacks (a diverged history): surface it and refuse to
# force, so no work is ever overwritten.
if ! git merge-base --is-ancestor origin/main main 2>/dev/null; then
  log "origin/main is NOT an ancestor of local main — diverged history; refusing to force-push"
  echo "MAIN-SYNC DIVERGED: local $(git rev-parse --short main) vs origin $(git rev-parse --short origin/main); reconcile before sync."
  exit 1
fi
ahead="$(git rev-list --count origin/main..main 2>/dev/null || echo '?')"
if git push origin main >/tmp/main-sync-push.log 2>&1; then
  echo "MAIN-SYNC PUSHED: origin/main -> $(git rev-parse --short main) (+$ahead commit(s))"
  exit 0
fi
log "push origin main failed:"; tail -n 5 /tmp/main-sync-push.log >&2 2>/dev/null || true
echo "MAIN-SYNC PUSH-FAILED: +$ahead commit(s) still local-only (see /tmp/main-sync-push.log)"
exit 1
