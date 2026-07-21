#!/usr/bin/env bash
#
# Phase 3 — hybrid merge-gated nightly upstream sync for the cortex fork.
#
# Replaces the OOM-prone per-commit cherry-pick classifier
# (scripts/upstream-divergence-report.mjs) with the REAL `git merge upstream/main`
# in a throwaway worktree (merge=ours + rerere active), measured via the shadow
# engine. It NEVER re-classifies thousands of commits, so it does not OOM.
#
# Routing (see the `route` subcommand):
#   up-to-date        behind==0                     -> report, done. main untouched.
#   clean-landable    residual==0 AND Linux proof ✓ -> land main + deploy (deterministic).
#   needs-resolution  residual>0                    -> exit 20; the calling agent stages a
#                                                      resync-staging/<date> branch, resolves
#                                                      the bounded residual (openclaw-upstream-resync
#                                                      skill), proves it, pushes it — never lands.
#
# The LLM only owns needs-resolution. Everything else is deterministic. main is
# advanced ONLY on a zero-conflict, Linux-proof-green merge, and a rollback tag is
# written first. Linux proof runs on huey under node24 (upstream requires
# node>=22.22.3; huey's default node22 is 22.19.0 and fails install).
#
# Subcommands:
#   route                 fetch + measure + route (default). clean path lands+deploys inline.
#   measure               fetch + measure only; print decision JSON. Read-only.
#   stage-init <date>     create nightly worktree + resync-staging/<date>, start the merge,
#                         print the residual conflict list for the agent to resolve.
#   stage-finish <date>   after the agent resolved+committed in the worktree: prove on huey,
#                         push the branch, print the one-line land command. Never touches main.
#
# Exit: 0 ok (up-to-date, clean landed, or stage step done) · 20 needs-resolution
#       (route only) · 3 proof UNAVAILABLE/deferred · non-zero local error.
set -uo pipefail

MAIN="/Users/joederas/Documents/Cline/code/claudy/openclaw"
WORKTREE="${UPSTREAM_MERGE_WORKTREE:-/Users/joederas/Documents/Cline/code/claudy/openclaw-upstream-nightly}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-/home/joe/node24/bin}"   # upstream needs node>=22.22.3
LOG="${UPSTREAM_MERGE_LOG:-$HOME/.openclaw/workspace/memory/reports/upstream-merge-nightly.log}"
export REMOTE_NODE_BIN

cd "$MAIN" || { echo "MERGE-ABORT: main tree missing"; exit 2; }
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

stamp() { date -u +%Y-%m-%dT%H:%MZ; }
today() { date +%Y-%m-%d; }
log()   { echo "[upstream-merge] $*" >&2; }
ledger(){ echo "$(stamp) $*" >>"$LOG" 2>/dev/null || true; }

# The nightly must run from a clean main checkout; if the live tree is parked on a
# resync/other branch (operator work), do nothing — never merge into their branch.
require_main_clean() {
  local cur; cur="$(git -C "$MAIN" rev-parse --abbrev-ref HEAD)"
  if [ "$cur" != "main" ]; then
    log "live tree on '$cur', not main — skipping (operator work in progress)"
    ledger "SKIP reason=not-on-main branch=$cur"
    exit 0
  fi
  if [ -n "$(git -C "$MAIN" status --porcelain --untracked-files=no)" ]; then
    log "live tree has uncommitted tracked changes — skipping to avoid clobbering"
    ledger "SKIP reason=dirty-tree"
    exit 0
  fi
}

fresh_worktree() {
  git -C "$MAIN" worktree remove --force "$WORKTREE" 2>/dev/null || true
  rm -rf "$WORKTREE" 2>/dev/null || true
  git -C "$MAIN" worktree add --detach "$WORKTREE" HEAD >/dev/null 2>&1 \
    || { log "worktree add failed"; exit 2; }
}

drop_worktree() { git -C "$MAIN" worktree remove --force "$WORKTREE" 2>/dev/null || true; }

# Measure the post-driver residual via the shadow engine (read-only; own worktree).
# Emits: BEHIND / RESIDUAL globals.
measure() {
  git -C "$MAIN" fetch upstream -q 2>/dev/null || log "fetch upstream failed (using cached)"
  local json
  json="$(node "$MAIN/scripts/upstream-merge-engine.mjs" --upstream "$UPSTREAM_REF" 2>/dev/null)" \
    || { log "shadow engine failed"; ledger "ERROR reason=engine-failed"; exit 2; }
  BEHIND="$(printf '%s' "$json"  | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).behind))')"
  RESIDUAL="$(printf '%s' "$json" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).residualConflicts))')"
  RESIDUAL_JSON="$json"
}

# --- clean auto-land path ---------------------------------------------------
# residual==0: real-merge in the worktree, prove on Linux, and only on PASS
# advance main + deploy. Rollback tag is written before main moves.
land_clean() {
  local date; date="$(today)"
  local branch="upstream-auto-merge/$date"
  fresh_worktree
  # Real merge; residual is 0 (measured), so this completes without conflicts.
  if ! git -C "$WORKTREE" merge --no-ff --no-edit "$UPSTREAM_REF" >/tmp/um-merge.log 2>&1; then
    log "clean merge unexpectedly conflicted — deferring to resolution path"
    git -C "$WORKTREE" merge --abort 2>/dev/null || true
    drop_worktree
    ledger "DEFER reason=clean-merge-conflicted behind=$BEHIND"
    exit 20
  fi
  local merge_sha; merge_sha="$(git -C "$WORKTREE" rev-parse HEAD)"
  git -C "$WORKTREE" branch -f "$branch" "$merge_sha" >/dev/null 2>&1

  log "clean merge $merge_sha (branch $branch); proving on huey (node24)…"
  local proof rc
  proof="$(BASELINE_REF=main remote_proof "$branch")"; rc=$?
  if [ "$rc" = 3 ]; then
    log "proof UNAVAILABLE — deferring, main untouched"
    drop_worktree
    ledger "DEFER reason=proof-unavailable behind=$BEHIND merge=$merge_sha"
    echo "UPSTREAM-MERGE DEFER: clean merge ready but Linux proof unavailable; main untouched."
    exit 3
  fi
  if [ "$rc" != 0 ]; then
    log "proof FAILED — NOT landing"
    drop_worktree
    ledger "NO-LAND reason=proof-failed behind=$BEHIND merge=$merge_sha"
    echo "UPSTREAM-MERGE NO-LAND: clean merge failed Linux proof; main untouched."
    echo "$proof"
    exit 1
  fi

  # PROOF green -> land. Rollback safety FIRST.
  git -C "$MAIN" tag -f "main-backup-pre-upstream-merge" main >/dev/null 2>&1
  git -C "$MAIN" tag -f "upstream-merge-$date" main >/dev/null 2>&1
  if ! git -C "$MAIN" merge --ff-only "$merge_sha" >/tmp/um-land.log 2>&1; then
    log "ff-only land failed (main advanced mid-run) — main intact, deferring"
    drop_worktree
    ledger "DEFER reason=ff-race behind=$BEHIND merge=$merge_sha"
    exit 1
  fi
  # Regenerate the fork-config baseline for the new main and commit it.
  node "$MAIN/scripts/fork-config-snapshot.mjs" generate >/dev/null 2>&1 || true
  if [ -n "$(git -C "$MAIN" status --porcelain fork-config-baseline.json)" ]; then
    "$MAIN/scripts/committer" "chore(resync): regenerate fork-config baseline after nightly upstream merge ($date)" fork-config-baseline.json >/dev/null 2>&1 || true
  fi
  git -C "$MAIN" push origin main >/tmp/um-push.log 2>&1 || log "push origin main failed (landed locally)"
  drop_worktree

  local landed; landed="$(git -C "$MAIN" rev-parse --short HEAD)"
  ledger "LAND clean behind=$BEHIND merge=${merge_sha:0:11} main=$landed proof=PASS"
  echo "UPSTREAM-MERGE LANDED (clean): main @ $landed (+$BEHIND upstream commits), Linux proof PASS. Deploying…"
  # Deploy LAST: this build crashes+respawns the gateway (kills this session);
  # the detached health watcher records the outcome. main is already durable on origin.
  exec bash "$MAIN/scripts/cron-deploy-build.sh"
}

# --- staging helpers (agent-driven needs-resolution path) -------------------
stage_init() {
  local date="${1:-$(today)}"
  local branch="resync-staging/$date"
  fresh_worktree
  git -C "$WORKTREE" checkout -B "$branch" >/dev/null 2>&1
  git -C "$WORKTREE" merge --no-commit --no-ff "$UPSTREAM_REF" >/tmp/um-stage-merge.log 2>&1 || true
  local conflicts; conflicts="$(git -C "$WORKTREE" status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)' | wc -l | tr -d ' ')"
  echo "STAGE-READY worktree=$WORKTREE branch=$branch conflicts=$conflicts"
  echo "--- conflict files (resolve in $WORKTREE, then commit, then run: stage-finish $date) ---"
  git -C "$WORKTREE" status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)' || true
  ledger "STAGE-INIT branch=$branch conflicts=$conflicts"
}

stage_finish() {
  local date="${1:-$(today)}"
  local branch="resync-staging/$date"
  # Guard: the agent must have resolved every conflict and committed the merge.
  if [ -n "$(git -C "$WORKTREE" status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)')" ]; then
    log "unresolved conflicts remain in $WORKTREE — resolve + commit before stage-finish"
    exit 2
  fi
  if [ -n "$(git -C "$WORKTREE" status --porcelain --untracked-files=no)" ]; then
    log "worktree has an uncommitted merge — commit the resolution before stage-finish"
    exit 2
  fi
  git -C "$MAIN" branch -f "$branch" "$(git -C "$WORKTREE" rev-parse HEAD)" >/dev/null 2>&1
  log "proving $branch on huey (node24)…"
  local proof rc
  proof="$(BASELINE_REF=main remote_proof "$branch")"; rc=$?
  if [ "$rc" != 0 ]; then
    ledger "STAGE-PROOF branch=$branch result=$([ "$rc" = 3 ] && echo UNAVAILABLE || echo FAIL)"
    echo "STAGE proof not green (rc=$rc) — branch kept local, NOT pushed. main untouched."
    echo "$proof"
    exit "$rc"
  fi
  git -C "$MAIN" push -f origin "$branch" >/tmp/um-stage-push.log 2>&1 || log "push staging branch failed"
  drop_worktree
  local tip; tip="$(git -C "$MAIN" rev-parse --short "$branch")"
  ledger "STAGE-READY-TO-LAND branch=$branch tip=$tip proof=PASS"
  echo "STAGE-READY-TO-LAND: $branch @ $tip — Linux proof PASS, pushed to origin. main untouched."
  echo "  Land with:  git -C $MAIN checkout main && git -C $MAIN merge --ff-only $branch"
}

# remote-proof wrapper (forces node24). Prints proof output on stdout, returns its rc.
remote_proof() {
  REMOTE_NODE_BIN="$REMOTE_NODE_BIN" bash "$MAIN/scripts/remote-proof.sh" "$1"
}

# --- dispatch ----------------------------------------------------------------
cmd="${1:-route}"
case "$cmd" in
  route)
    require_main_clean
    measure
    log "behind=$BEHIND residual=$RESIDUAL"
    if [ "${BEHIND:-0}" = 0 ]; then
      ledger "UP-TO-DATE"
      echo "UPSTREAM-MERGE UP-TO-DATE: main is current with $UPSTREAM_REF."
      exit 0
    fi
    if [ "${RESIDUAL:-1}" = 0 ]; then
      land_clean
    fi
    # residual>0: hand off to the agent's resolution path.
    ledger "NEEDS-RESOLUTION behind=$BEHIND residual=$RESIDUAL"
    echo "UPSTREAM-MERGE NEEDS-RESOLUTION: behind=$BEHIND residual=$RESIDUAL"
    printf '%s\n' "$RESIDUAL_JSON"
    exit 20
    ;;
  measure)
    measure
    printf '%s\n' "$RESIDUAL_JSON"
    ;;
  stage-init)   require_main_clean; stage_init "${2:-}";;
  stage-finish) stage_finish "${2:-}";;
  *) echo "usage: cron-upstream-merge.sh {route|measure|stage-init <date>|stage-finish <date>}" >&2; exit 2;;
esac
