#!/usr/bin/env bash
#
# Shared "never lose un-merged cron work" helpers for the daily-research deploy
# pipeline. Sourced by cron-sync-worktree.sh and cron-merge-to-main.sh — not run
# directly.
#
# The pipeline commits each day's work on `cron-work` and merges it into `main` at
# deploy time. When that merge could not happen (live tree parked off main, or a
# conflict), the commits used to survive only on `cron-work`, and the NEXT cycle's
# `git reset --hard main` discarded them into the reflog — GC-eligible and never
# deployed. (That silently lost 8 quick wins over 3 weeks.)
#
# These helpers close the hole conservatively — they never lose work and never ship
# anything an unattended deploy could not safely fast-forward:
#   cron_archive_unmerged       — snapshot un-merged commits to a UNIQUE, pushed
#                                 cron-archive/<date>-<sha> branch before any reset
#                                 can drop them. Returns non-zero if it cannot create
#                                 the local snapshot, so callers refuse to destroy
#                                 the source.
#   cron_ff_drain_archives      — fast-forward (only) recoverable archives onto main.
#                                 ff is safe by construction: never a merge commit,
#                                 never resurrects divergent history — so no age bound
#                                 or review is needed. Diverged archives are left for
#                                 the report / manual cherry-pick.
#   cron_prune_durable_archives — delete archives already contained in origin/main
#                                 (proven durable remotely) — the only safe deletion.
#   cron_unmerged_report        — one-line backlog summary for reports/briefings.
#
# Callers run `set -uo pipefail` without `-e`; these never abort the caller on a
# push/merge problem — a failed push still leaves the durable LOCAL snapshot.

ARCHIVE_PREFIX="cron-archive"

# refs/heads/cron-archive/* branches whose commits are NOT yet on main, oldest first
# (the date in the name sorts chronologically).
_cron_unmerged_archives() {
  local repo="$1" ref
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    git -C "$repo" merge-base --is-ancestor "$ref" main 2>/dev/null && continue
    echo "$ref"
  done < <(git -C "$repo" for-each-ref --format='%(refname:short)' --sort=refname \
             "refs/heads/$ARCHIVE_PREFIX/*" 2>/dev/null)
}

# cron_archive_unmerged <repo> <branch>
# If <branch> has commits not yet on main, snapshot it to a UNIQUE
# cron-archive/<date>-<shortsha> branch (idempotent: same tip -> same name, so it
# can never clobber a different snapshot) and best-effort push to origin. Echoes
# "<ref> (<status>)" when it archives; silent when there is nothing un-merged.
# Returns non-zero ONLY when the local snapshot could not be created — the caller
# must then NOT destroy <branch>, because the commits are not yet preserved.
cron_archive_unmerged() {
  local repo="$1" src="$2"
  git -C "$repo" rev-parse --verify --quiet "refs/heads/$src" >/dev/null 2>&1 || return 0
  git -C "$repo" merge-base --is-ancestor "$src" main 2>/dev/null && return 0
  local full sha existing ref
  full="$(git -C "$repo" rev-parse "$src" 2>/dev/null)" || return 1
  # Reuse an existing archive already pointing at this exact commit, so a change
  # that stays un-merged for several days is snapshotted once, not re-branched
  # every cycle (which would inflate the backlog count and litter the namespace).
  existing="$(git -C "$repo" for-each-ref --format='%(objectname) %(refname:short)' \
                "refs/heads/$ARCHIVE_PREFIX/*" 2>/dev/null | awk -v s="$full" '$1==s{print $2; exit}')"
  if [ -n "$existing" ]; then
    echo "$existing (already archived)"
    return 0
  fi
  sha="$(git -C "$repo" rev-parse --short "$src" 2>/dev/null)" || return 1
  ref="$ARCHIVE_PREFIX/$(date +%F)-$sha"
  # The local branch is the hard durability guarantee against the next reset, so
  # only this failing is fatal. (-f is safe: a given name only ever points at the
  # same sha, so it cannot overwrite a different snapshot.)
  git -C "$repo" branch -f "$ref" "$src" >/dev/null 2>&1 || return 1
  if git -C "$repo" push -f origin "$ref" >/dev/null 2>&1; then
    echo "$ref (pushed)"
  else
    echo "$ref (local only — push to origin failed)"
  fi
}

# cron_ff_drain_archives <repo>  (CALLER MUST BE ON main)
# Fast-forward each recoverable archive onto main. Only true fast-forwards are
# taken: if main has diverged from the archive, it is left for the report / a
# manual cherry-pick. No merge commits, no age heuristics — nothing stale can be
# silently resurrected into the deployed build.
cron_ff_drain_archives() {
  local repo="$1" ref before after
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    before="$(git -C "$repo" rev-parse HEAD)"
    git -C "$repo" merge --ff-only "$ref" >/dev/null 2>&1 || continue
    after="$(git -C "$repo" rev-parse HEAD)"
    # Only report a real advance: an earlier ff can absorb a later archive, whose
    # own ff then reports "Already up to date" (exit 0) without moving HEAD.
    [ "$before" != "$after" ] && echo "DRAIN-FF: landed $ref onto main @ ${after:0:9}"
  done < <(_cron_unmerged_archives "$repo")
}

# cron_prune_durable_archives <repo>
# Delete (local + origin) any archive whose commits are already contained in
# origin/main — i.e. durably shipped. This is the ONLY safe time to delete an
# archive: its purpose (a recoverable copy) is fulfilled once the work is on
# origin/main. No-op when origin/main is unknown.
cron_prune_durable_archives() {
  local repo="$1" ref
  git -C "$repo" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1 || return 0
  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    if git -C "$repo" merge-base --is-ancestor "$ref" refs/remotes/origin/main 2>/dev/null; then
      git -C "$repo" branch -D "$ref" >/dev/null 2>&1 || true
      git -C "$repo" push origin --delete "$ref" >/dev/null 2>&1 || true
      echo "PRUNE: $ref (now on origin/main)"
    fi
  done < <(git -C "$repo" for-each-ref --format='%(refname:short)' \
             "refs/heads/$ARCHIVE_PREFIX/*" 2>/dev/null)
}

# cron_unmerged_report <repo> -- one-line backlog summary for reports/briefings.
cron_unmerged_report() {
  local repo="$1" refs count oldest
  refs="$(_cron_unmerged_archives "$repo")"
  if [ -z "$refs" ]; then
    echo "UNMERGED BACKLOG: clean"
    return 0
  fi
  count="$(printf '%s\n' "$refs" | grep -c .)"
  oldest="$(printf '%s\n' "$refs" | head -1 | sed "s#^$ARCHIVE_PREFIX/##")"
  echo "UNMERGED BACKLOG: $count archive branch(es) not on main, oldest $oldest"
}
