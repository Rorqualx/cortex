#!/usr/bin/env bash
#
# Shared advisory mutex serializing every autonomous-cron mutation of local `main`.
#
# Three crons write main and can run at overlapping times: cron-merge-to-main.sh
# (merges cron-work into local main), the upstream-merge land (ff-only land + baseline
# /asset commits + push, in cron-upstream-merge.sh land_and_deploy), and
# cron-sync-main-to-origin.sh (push origin main). Each is a MULTI-STEP sequence on
# main; interleaving them races the ref: a sibling commit slipped between the land's
# ff-only and its push turns the push non-fast-forward (LAND-LOCAL-ONLY, no deploy),
# two writers advancing the ref at once hit `cannot lock ref`, and a slow land lets a
# sibling drift main out from under it (ff-blocked DEFER, a wasted ~40min proof cycle).
# absorb_local_main + cron-sync recover from that drift AFTER the fact; this prevents
# the short-window interleave at the source by making each writer hold the ref alone
# while it mutates + pushes.
#
# Bounded-WAIT, not skip-if-busy: a writer that MUST land its change (a merge, a land)
# waits its turn rather than dropping the work. A periodic writer (sync) passes a short
# wait and skips on timeout — the next tick retries. mkdir is the atomic acquire; the
# lock records the holder pid and its acquire mtime so a dead holder (a build-crash
# SIGKILL before release) or a hung one (age backstop) is reclaimed rather than
# deadlocking every future writer. Release is pid-guarded: it only removes the lock
# this process owns, so it is safe to call unconditionally and from a shared EXIT trap.
#
# Usage:
#   source "$(dirname "$0")/lib/main-commit-lock.sh"
#   main_lock_acquire 300 || { echo "DEFER: main busy"; exit 1; }
#   ... mutate + push main ...
#   main_lock_release

MAIN_COMMIT_LOCK_DIR="${MAIN_COMMIT_LOCK_DIR:-/tmp/openclaw-main-commit.lock.d}"

# A legit hold is one merge or one land+push (seconds, up to ~1-2min for the land's
# asset regen + network push). 15min is far above that but well under "wedged", so a
# genuinely hung holder is reclaimed while a live-but-slow one is never stolen from.
MAIN_COMMIT_LOCK_STALE_S="${MAIN_COMMIT_LOCK_STALE_S:-900}"

# main_lock_acquire [max_wait_seconds]
# Returns 0 with the lock held; 1 if it could not be acquired within max_wait_seconds.
main_lock_acquire() {
  local wait_s="${1:-300}" waited=0
  while :; do
    if mkdir "$MAIN_COMMIT_LOCK_DIR" 2>/dev/null; then
      printf '%s\n' "$$" >"$MAIN_COMMIT_LOCK_DIR/pid"
      return 0
    fi
    local holder age
    holder="$(cat "$MAIN_COMMIT_LOCK_DIR/pid" 2>/dev/null || true)"
    age=$(( $(date +%s) - $(stat -f %m "$MAIN_COMMIT_LOCK_DIR" 2>/dev/null || echo 0) ))
    # Reclaim a lock whose holder pid is gone (crash before release) or that has been
    # held past the stale bound (hung holder). `continue` re-attempts the mkdir; the
    # rm+mkdir race with a concurrent reclaimer degrades to one more wait iteration.
    if { [ -z "$holder" ] || ! kill -0 "$holder" 2>/dev/null; } || [ "$age" -ge "$MAIN_COMMIT_LOCK_STALE_S" ]; then
      echo "[main-lock] reclaiming lock (holder pid=${holder:-none}, age=${age}s)" >&2
      rm -rf "$MAIN_COMMIT_LOCK_DIR" 2>/dev/null || true
      continue
    fi
    if [ "$waited" -ge "$wait_s" ]; then
      echo "[main-lock] could not acquire within ${wait_s}s (held by pid=$holder, age=${age}s)" >&2
      return 1
    fi
    sleep 2
    waited=$(( waited + 2 ))
  done
}

# main_lock_release — remove the lock ONLY if this process owns it (pid matches). Safe
# to call when the lock was never acquired or was already reclaimed.
main_lock_release() {
  [ "$(cat "$MAIN_COMMIT_LOCK_DIR/pid" 2>/dev/null || true)" = "$$" ] || return 0
  rm -rf "$MAIN_COMMIT_LOCK_DIR" 2>/dev/null || true
}
