#!/usr/bin/env bash
#
# Restart-safety quiesce gate for the cron pipeline.
#
# A gateway-restarting build (the deploy's in-place `pnpm build` crashes the live
# gateway so launchd relaunches it on the fresh dist) kills EVERY in-flight cron
# run in the process — a research scan, skill-forge, the upstream-merge job, etc.
# This gate blocks until no OTHER cron job is running, so the restart only happens
# when it is safe to do so.
#
# It reads the PERSISTED run marker (`cron_jobs.running_at_ms`) straight from the
# state SQLite, so it works cross-process and WITHOUT booting the gateway or the
# `openclaw` CLI (the deploy survival rule forbids running `openclaw` before the
# build). The in-process active-job registry (src/cron/active-jobs.ts) is invisible
# to a separate process; the SQLite marker is the durable source of truth.
#
# Usage:
#   cron-restart-safe-wait.sh [--self <jobId>] [--timeout <sec>] [--poll <sec>] [--once]
#
#   --self <jobId>   Ignore this job id (the caller's own run, which is itself
#                    marked running). Required when the caller is a cron job.
#   --timeout <sec>  Max seconds to wait for other jobs to finish (default 1800).
#   --poll <sec>     Poll interval (default 15).
#   --once           Check once and exit; do not wait.
#
# Exit 0 = idle, safe to restart/build.
# Exit 3 = other cron job(s) still running after the timeout — caller should DEFER.
# Exit 2 = could not determine state (missing db/sqlite3) — treated as idle, warns.
set -uo pipefail

DB="${OPENCLAW_STATE_DB:-$HOME/.openclaw/state/openclaw.sqlite}"
# cron_jobs.store_key is the legacy jobs.json path, kept as the store key in SQLite.
STORE_KEY="${OPENCLAW_CRON_STORE_KEY:-$HOME/.openclaw/cron/jobs.json}"
# Mirror STUCK_RUN_MS (src/cron/service/jobs.ts): a runningAtMs marker older than
# 2h is a crashed/stuck run, not a live one — ignore it so a stale marker can
# never block deploys forever.
STUCK_MS=$((2 * 60 * 60 * 1000))

SELF=""
TIMEOUT=1800
POLL=15
ONCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --self) SELF="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT="${2:-1800}"; shift 2 ;;
    --poll) POLL="${2:-15}"; shift 2 ;;
    --once) ONCE=1; shift ;;
    *) echo "cron-restart-safe-wait: unknown arg '$1'" >&2; exit 64 ;;
  esac
done

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "QUIESCE-SKIP: sqlite3 not found; cannot check cron run state — proceeding."
  exit 2
fi
if [ ! -f "$DB" ]; then
  echo "QUIESCE-SKIP: state db not found at $DB — no cron runs possible, proceeding."
  exit 2
fi

# Print "<job_id>  <name>" for every OTHER cron job currently running (non-stale).
active_runs() {
  local now_ms cutoff
  now_ms=$(( $(date +%s) * 1000 ))
  cutoff=$(( now_ms - STUCK_MS ))
  # -readonly + WAL gives a consistent snapshot without blocking the writer.
  # `.timeout` (dot-command) sets the busy timeout without emitting a result row
  # the way `PRAGMA busy_timeout` would.
  sqlite3 -readonly -batch -cmd ".timeout 4000" "$DB" \
    "SELECT job_id || '  ' || name
       FROM cron_jobs
      WHERE store_key = '$STORE_KEY'
        AND running_at_ms IS NOT NULL
        AND running_at_ms > $cutoff
        AND job_id <> '$SELF';" 2>/dev/null
}

deadline=$(( $(date +%s) + TIMEOUT ))
while true; do
  busy="$(active_runs)"
  if [ -z "$busy" ]; then
    echo "QUIESCE-OK: no other cron job running; safe to restart/build."
    exit 0
  fi
  count="$(printf '%s\n' "$busy" | grep -c .)"
  if [ "$ONCE" -eq 1 ] || [ "$(date +%s)" -ge "$deadline" ]; then
    echo "QUIESCE-BUSY: $count cron job(s) still running after waiting:"
    printf '%s\n' "$busy" | sed 's/^/  - /'
    exit 3
  fi
  echo "QUIESCE-WAIT: $count cron job(s) running; re-checking in ${POLL}s ($(( deadline - $(date +%s) ))s left):"
  printf '%s\n' "$busy" | sed 's/^/  - /'
  sleep "$POLL"
done
