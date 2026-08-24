#!/usr/bin/env bash
#
# Shared cron-quiesce gate for gateway-restarting scripts (restart-mac.sh,
# prod-restart.sh, ...). Killing or rebuilding the gateway also kills every
# in-flight cron run (research scans, skill-forge, the upstream-merge cron /
# Implementation jobs), so callers must refuse to restart while a cron job is
# running unless explicitly forced.
#
# Source this file, then call `assert_cron_idle <repo-root>`:
#   - return 0  -> safe to restart (no other cron job running, or a soft skip
#                  because the state DB / sqlite3 is unavailable, or overridden
#                  via FORCE=1 / SKIP_ACTIVE_CHECK=1).
#   - return 3  -> a non-stale cron run is active; the caller MUST abort.
#
# The check delegates to cron-restart-safe-wait.sh --once, which reads the
# persisted cron_jobs.running_at_ms marker straight from SQLite, so it works in a
# detached restart process without booting the gateway or the openclaw CLI.

assert_cron_idle() {
  local root="$1"
  if [[ "${FORCE:-0}" -eq 1 || "${SKIP_ACTIVE_CHECK:-0}" -eq 1 ]]; then
    return 0
  fi
  # Capture the real exit code from the command itself. Do NOT wrap this in
  # `if ! cmd; then rc=$?` — the `!` resets $? to the negated 0/1, masking the
  # exit code 3 we need to distinguish "busy" (3) from "soft skip" (2).
  local rc=0
  bash "${root}/scripts/cron-restart-safe-wait.sh" --once || rc=$?
  case "$rc" in
    # 0 = idle; 2 = no db / no sqlite3, nothing to block on.
    0 | 2) return 0 ;;
    # 3 = a non-stale cron run is active.
    3) return 3 ;;
    # Any other code means the check itself broke or is missing (e.g. exit 127).
    # Fail OPEN here: these are gateway RECOVERY tools, and a broken cron probe must
    # not brick a restart. Warn loudly and proceed; the build-suicide guard
    # (assert-build-safe.mjs) fails closed instead because a build is deferrable.
    *)
      echo "assert_cron_idle: cron check unavailable (exit $rc); cannot confirm idle, proceeding with restart." >&2
      return 0
      ;;
  esac
}
