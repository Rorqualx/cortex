#!/usr/bin/env bash
# Sync the cron worktree branch (cron-work) to the live branch (memory-fork) so
# the day's autonomous LLM-research pipeline starts from current production state.
# Isolates the cron agents from the main working tree / live gateway build.
#
# Safe: only touches the cron worktree (openclaw-cron / cron-work). Never the
# main tree or memory-fork.
set -uo pipefail

MAIN="/Users/joederas/Documents/Cline/code/claudy/openclaw"
WT="/Users/joederas/Documents/Cline/code/claudy/openclaw-cron"

if [ ! -d "$WT/.git" ] && [ ! -f "$WT/.git" ]; then
  echo "SYNC-ABORT: cron worktree missing at $WT (run: git -C $MAIN worktree add $WT -b cron-work memory-fork)"
  exit 2
fi

# Reset cron-work to the current memory-fork tip (discards any leftover state
# from an interrupted prior cycle). node_modules is a symlink (untracked) and is
# left untouched.
if git -C "$WT" reset --hard memory-fork; then
  echo "SYNC-OK: cron-work @ $(git -C "$WT" rev-parse --short HEAD) (= memory-fork)"
  exit 0
fi
echo "SYNC-ABORT: reset failed"
exit 1
