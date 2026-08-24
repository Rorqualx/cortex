#!/usr/bin/env bash
# Deploy-step merge of the cron worktree branch (cron-work) into the live branch
# (main) in the MAIN tree. Self-preserving: rather than aborting and letting the
# next cycle's `reset --hard main` discard un-merged work, it snapshots that work to
# a pushed cron-archive/<date>-<sha> branch, reports any backlog, and — only once
# today's work has merged — fast-forwards recoverable prior archives onto main and
# prunes archives already shipped to origin/main.
#
# Order matters: today's cron-work is merged FIRST, and recovery (drain/prune) runs
# ONLY after that succeeds. So a failed/conflicted cycle leaves main exactly as it
# was (matching the report) and skips the build; main is never advanced on a day the
# deploy does not build.
#
# Exit codes: 0 = today's cron-work is on main (safe to build/deploy);
#             non-zero = today's work did not land (it is preserved) — skip the build.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/cron-archive.sh
source "$SCRIPT_DIR/lib/cron-archive.sh"
# shellcheck source=scripts/lib/main-commit-lock.sh
source "$SCRIPT_DIR/lib/main-commit-lock.sh"

MAIN="/Users/joederas/Documents/Cline/code/claudy/openclaw"
cd "$MAIN" || { echo "MERGE-ABORT: main tree missing"; exit 2; }

# preserve_cron_work <context-message-prefix> -- snapshot cron-work durably and log
# truthfully: a non-zero return from cron_archive_unmerged means the snapshot could
# NOT be created, so do not claim the work was preserved.
preserve_cron_work() {
  local prefix="$1" archived
  if archived="$(cron_archive_unmerged "$MAIN" cron-work)"; then
    echo "$prefix preserved cron-work to ${archived:-<nothing un-merged>}; deploy skipped."
  else
    echo "$prefix FAILED to snapshot cron-work — commits remain only on cron-work, resolve manually; deploy skipped."
  fi
}

# The live tree must be on main to merge into it. If it is parked off main (a
# resync/zenbrain checkout, possibly an operator's in-progress work), do NOT touch
# their branch — just preserve today's cron-work durably and skip. A later deploy,
# once the tree is back on main, fast-forwards the archive back in.
cur="$(git rev-parse --abbrev-ref HEAD)"
if [ "$cur" != "main" ]; then
  preserve_cron_work "MERGE-ABORT: live tree on '$cur', not main;"
  cron_unmerged_report "$MAIN"
  exit 2
fi

# Serialize every local-main mutation below (merge + archive drain/prune) against the
# upstream-merge land and cron-sync's push via the shared main-commit lock, so a
# concurrent land cannot advance main out from under this merge (and vice-versa). Wait
# a land out rather than skipping: this cron's work should still land, just after the
# in-flight writer releases. If it cannot acquire in time, preserve and skip — the next
# cycle retries. (cron-work is already durable on its branch; nothing is lost here.)
if ! main_lock_acquire 300; then
  preserve_cron_work "MERGE-DEFER: main-commit lock held past 300s (a land is in flight);"
  cron_unmerged_report "$MAIN"
  echo "MERGE-STOP: could not acquire the main-commit lock; deploy will not build."
  exit 4
fi
trap 'main_lock_release' EXIT

# Merge today's cron-work FIRST (before any recovery), so a failure leaves main intact.
merged_today=0
if ! git rev-parse --verify --quiet cron-work >/dev/null; then
  echo "MERGE-NOTE: cron-work branch does not exist; nothing to deploy."
elif git merge-base --is-ancestor cron-work HEAD; then
  echo "MERGE-NOOP: cron-work already in main ($(git rev-parse --short HEAD))."
  merged_today=1
else
  errlog="$(mktemp)"
  # Prefer fast-forward (cron-work = main + today's commits); fall back to a real
  # merge when interactive commits landed on main after the cycle started.
  if git merge --ff-only cron-work >"$errlog" 2>&1; then
    echo "MERGE-OK (ff): main @ $(git rev-parse --short HEAD)."
    merged_today=1
  elif git merge --no-edit cron-work >"$errlog" 2>&1; then
    echo "MERGE-OK (merge commit): main @ $(git rev-parse --short HEAD)."
    merged_today=1
  else
    # Conflict: abort to leave main intact, then preserve the work durably.
    git merge --abort 2>/dev/null || true
    preserve_cron_work "MERGE-DEFER: could not merge cron-work cleanly; main left intact;"
    echo "git said:"
    sed 's/^/  /' "$errlog"
  fi
  rm -f "$errlog"
fi

if [ "$merged_today" -ne 1 ]; then
  cron_unmerged_report "$MAIN"
  echo "MERGE-STOP: today's cron-work is not on main; deploy will not build."
  exit 4
fi

# Today's work landed -> we are going to build. Recover recoverable backlog into the
# SAME build (drain BEFORE prune: drain may fast-forward an archive onto local main
# that prune would otherwise delete for being on origin/main but not yet local main).
cron_ff_drain_archives "$MAIN"
cron_prune_durable_archives "$MAIN"
cron_unmerged_report "$MAIN"
exit 0
