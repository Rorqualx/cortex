#!/usr/bin/env bash
# Post-processing: merge the cron worktree branch (cron-work) into the live
# branch (memory-fork) in the MAIN tree, safely, as the deploy step. Relies on
# git's own safety (it refuses to overwrite uncommitted changes) plus an
# abort-on-conflict guard, so the main tree is never left broken/conflicted.
#
# Exit codes: 0 = merged or nothing-to-merge (safe to build);
#             non-zero = NOT merged (deploy step must skip the build).
set -uo pipefail

MAIN="/Users/joederas/Documents/Cline/code/claudy/openclaw"
cd "$MAIN" || { echo "MERGE-ABORT: main tree missing"; exit 2; }

cur="$(git rev-parse --abbrev-ref HEAD)"
if [ "$cur" != "memory-fork" ]; then
  echo "MERGE-ABORT: main is on '$cur', expected memory-fork"
  exit 2
fi

if ! git rev-parse --verify --quiet cron-work >/dev/null; then
  echo "MERGE-ABORT: cron-work branch does not exist"
  exit 2
fi

# Already integrated?
if git merge-base --is-ancestor cron-work HEAD; then
  echo "MERGE-NOOP: cron-work already in memory-fork ($(git rev-parse --short HEAD))"
  exit 0
fi

errlog="$(mktemp)"
# Prefer fast-forward (cron-work = memory-fork + new commits).
if git merge --ff-only cron-work >"$errlog" 2>&1; then
  echo "MERGE-OK (ff): memory-fork @ $(git rev-parse --short HEAD)"
  rm -f "$errlog"; exit 0
fi
# Non-ff (interactive commits landed after the cycle started): try a real merge.
if git merge --no-edit cron-work >"$errlog" 2>&1; then
  echo "MERGE-OK (merge commit): memory-fork @ $(git rev-parse --short HEAD)"
  rm -f "$errlog"; exit 0
fi
# Conflict or refusal: abort and leave main exactly as it was.
git merge --abort 2>/dev/null || true
echo "MERGE-ABORT: could not merge cron-work cleanly; main left intact. git said:"
sed 's/^/  /' "$errlog"
rm -f "$errlog"
exit 4
