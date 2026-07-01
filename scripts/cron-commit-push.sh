#!/usr/bin/env bash
# Final "commit & push" step for code-changing cron jobs.
#
# Ensures a cron's code work is never left uncommitted or unpushed: commits any
# residual changes in the given worktree, then pushes the branch to origin as a
# durable backup. Fail-soft — it commits locally even if the push fails, and
# never leaves a partial state, so it is safe to call at the very end of any
# code-changing cron routine.
#
# Usage: cron-commit-push.sh <worktree-dir> <branch> [<label>]
#   <worktree-dir>  the checkout the cron edited (e.g. .../openclaw-cron)
#   <branch>        the branch that worktree is on (e.g. cron-work)
#   <label>         short tag for the autosave commit message (default: cron)
#
# Exit: 0 = committed+pushed (or nothing to do) · 1 = push failed (work is
#       committed locally) · 2 = worktree missing or on the wrong branch.

set -uo pipefail

WT="${1:?usage: cron-commit-push.sh <worktree-dir> <branch> [label]}"
BRANCH="${2:?usage: cron-commit-push.sh <worktree-dir> <branch> [label]}"
LABEL="${3:-cron}"

cd "$WT" 2>/dev/null || { echo "[commit-push] worktree not found: $WT"; exit 2; }

cur="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
if [ "$cur" != "$BRANCH" ]; then
  echo "[commit-push] $WT is on '$cur', expected '$BRANCH' — refusing to auto-commit"; exit 2
fi

# Commit any residual changes (the routine should already commit per-item; this
# is the safety net for anything left dangling by an interruption). --no-verify:
# an autosave must not be blocked by format/lint hooks; this is a backup branch.
if [ -n "$(git status --porcelain)" ]; then
  git add -A || { echo "[commit-push] git add failed"; exit 1; }
  git commit --no-verify -m "chore(cron): ${LABEL} autosave $(date -u +%Y-%m-%dT%H:%MZ)" \
    || { echo "[commit-push] commit failed"; exit 1; }
  echo "[commit-push] committed residual changes on ${BRANCH}"
else
  echo "[commit-push] no residual changes"
fi

# Push the branch to origin as a durable backup. Nothing here writes main.
if git push -u origin "$BRANCH" >/tmp/cron-commit-push.log 2>&1; then
  echo "[commit-push] pushed ${BRANCH} -> origin"
  exit 0
fi
echo "[commit-push] push failed (work is committed locally on ${BRANCH}); see /tmp/cron-commit-push.log"
tail -3 /tmp/cron-commit-push.log
exit 1
