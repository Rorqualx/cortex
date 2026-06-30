#!/usr/bin/env bash
# Sync the cron worktree branch (cron-work) to the live branch (main) so
# the day's autonomous LLM-research pipeline starts from current production state.
# Isolates the cron agents from the main working tree / live gateway build.
#
# Safe: only touches the cron worktree (openclaw-cron / cron-work). Never the
# main tree or main.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/cron-archive.sh
source "$SCRIPT_DIR/lib/cron-archive.sh"

MAIN="/Users/joederas/Documents/Cline/code/claudy/openclaw"
WT="/Users/joederas/Documents/Cline/code/claudy/openclaw-cron"

if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
  echo "SYNC-ABORT: cron worktree missing at $WT (run: git -C $MAIN worktree add $WT -b cron-work main)"
  exit 2
fi

# Backstop against the historical loss: if a prior cycle's deploy never merged
# cron-work (job crashed before the deploy ran, etc.), the reset below would
# discard those commits forever. Snapshot+push them to a durable cron-archive/<date>-<sha>
# branch first; a later deploy fast-forwards it back onto main. No-op when cron-work
# is already on main. Fail CLOSED: if the snapshot cannot be created, refuse to reset
# rather than silently destroy the commits the backstop exists to protect.
if ! preserved="$(cron_archive_unmerged "$WT" cron-work)"; then
  echo "SYNC-ABORT: failed to preserve un-merged cron-work commits; refusing to reset (would lose them). Resolve manually."
  exit 2
fi
[ -n "$preserved" ] && echo "SYNC-PRESERVE: un-merged cron-work archived to $preserved before reset."

# Reset cron-work to the current main tip (discards any leftover state
# from an interrupted prior cycle). node_modules is a symlink (untracked) and is
# left untouched.
if git -C "$WT" reset --hard main; then
  echo "SYNC-OK: cron-work @ $(git -C "$WT" rev-parse --short HEAD) (= main)"
  exit 0
fi
echo "SYNC-ABORT: reset failed"
exit 1
