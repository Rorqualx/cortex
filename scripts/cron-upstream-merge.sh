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
#   finish-land <date>    same, but lands ff-only into main + deploys on green proof.
#
# Two policies keep the residual bounded and honest (both learned the hard way on
# the 2026-07-22..25 runs, which never landed anything):
#   - ui/ is fork-owned; see apply_fork_ui_ownership. Without it ~92% of the
#     conflicts are the upstream Control-UI rearchitecture the fork has not adopted.
#   - merge=ours keeps our whole FILE, so upstream additions to a protected file
#     vanish silently; see report_merge_ours_drift, and rebase those files onto
#     upstream re-applying only the fork delta.
# Every path runs `preflight` locally before spending a huey cycle.
#
# Exit: 0 ok (up-to-date, clean landed, or stage step done) · 20 needs-resolution
#       (route only) · 3 proof UNAVAILABLE/deferred · non-zero local error.
set -uo pipefail

# Derive the repo root from the script's own location so a relocated checkout, a
# second machine, or a CI invocation works without editing this file; keep an env
# override matching the other knobs below.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAIN="${UPSTREAM_MERGE_MAIN:-$(cd "$SCRIPT_DIR/.." && pwd)}"
WORKTREE="${UPSTREAM_MERGE_WORKTREE:-$MAIN-upstream-nightly}"
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

# --- fork ownership of ui/ --------------------------------------------------
# Upstream rearchitected the Control UI into ui/src/{pages,lib,api}/**; this fork
# still ships the pre-rearchitecture ui/src/ui/** tree with its merge=ours
# customizations. Merging the two produces a hybrid that never builds: 2026-07-22
# through 2026-07-25 all died here, with ui/src accounting for ~92% of conflicts
# (622 of 678 on 07-25) while everything else was ~55 files of ordinary work.
# So ui/ is resolved by policy, not by the model: take main's tree wholesale and
# drop the upstream-only UI files the merge dragged in. Revisit only if the fork
# adopts upstream's UI architecture — see FORK-MERGE-GUIDE.md.
apply_fork_ui_ownership() {
  local wt="$1"
  git -C "$wt" checkout main -- ui 2>/dev/null || return 0
  git -C "$wt" ls-tree -r --name-only main ui | LC_ALL=C sort > /tmp/um-ui-main.txt
  git -C "$wt" ls-files -- ui | LC_ALL=C sort > /tmp/um-ui-index.txt
  comm -13 /tmp/um-ui-main.txt /tmp/um-ui-index.txt > /tmp/um-ui-extra.txt
  local dropped; dropped="$(wc -l < /tmp/um-ui-extra.txt | tr -d ' ')"
  if [ "$dropped" != 0 ]; then
    tr '\n' '\0' < /tmp/um-ui-extra.txt | xargs -0 git -C "$wt" rm -q -f --ignore-unmatch --
  fi
  echo "$dropped"
}

# `merge=ours` keeps OUR whole FILE, not our delta — so when upstream adds an
# export to a protected file, the merge silently drops it and every
# upstream-adopted consumer that imports it breaks at runtime. tsgo does not see
# this (the importing module type-checks against the stale file). On 2026-07-25
# this hid three dropped protocol exports until the protocol generator failed.
# List the protected files upstream actually touched so resolution rebases them
# onto upstream and re-applies only the fork delta.
report_merge_ours_drift() {
  local wt="$1" base="$2"
  # --stdin batches one check-attr over the whole changed set; per-file forks over
  # an 8k-file upstream delta take minutes and invite SIGPIPE truncation.
  git -C "$wt" diff --name-only "$base" "$UPSTREAM_REF" 2>/dev/null \
    | git -C "$wt" check-attr merge --stdin 2>/dev/null \
    | sed -n 's/: merge: ours$//p' > /tmp/um-merge-ours-drift.txt
  local all code
  all="$(wc -l < /tmp/um-merge-ours-drift.txt | tr -d ' ')"
  grep -E '\.(ts|tsx|mjs|swift|kt)$' /tmp/um-merge-ours-drift.txt > /tmp/um-merge-ours-drift-code.txt || true
  code="$(wc -l < /tmp/um-merge-ours-drift-code.txt | tr -d ' ')"
  sed 's/^/  MERGE-OURS-DRIFT /' /tmp/um-merge-ours-drift-code.txt
  echo "MERGE-OURS-DRIFT-COUNT $code code files ($all total)"
}

# Upstream files that are NEW since the merge base and absent from the merge
# result. tsgo cannot see this class at all: when a dropped module's consumers
# are dropped with it the tree still compiles, so the feature is simply missing
# and every lane stays green. The 2026-07-25 resync landed with 136 such files
# (101 prod), including whole subsystems and 27 files dropped into plugins the
# fork ships. `ui/` is excluded — it is fork-owned by policy, not dropped.
report_dropped_upstream_files() {
  local wt="$1" base="$2"
  [ -n "$base" ] || { echo "DROPPED-UPSTREAM-COUNT skipped (no merge base)"; return 0; }
  git -C "$wt" ls-tree -r --name-only "$UPSTREAM_REF" | LC_ALL=C sort > /tmp/um-up.txt
  git -C "$wt" ls-tree -r --name-only HEAD          | LC_ALL=C sort > /tmp/um-head.txt
  git -C "$wt" ls-tree -r --name-only "$base"       | LC_ALL=C sort > /tmp/um-base.txt
  # in upstream, not at the base (i.e. upstream-new), and not in the merge result
  comm -23 /tmp/um-up.txt /tmp/um-base.txt > /tmp/um-upnew.txt
  comm -23 /tmp/um-upnew.txt /tmp/um-head.txt | grep -v '^ui/' > /tmp/um-dropped.txt || true
  local dropped; dropped="$(wc -l < /tmp/um-dropped.txt | tr -d ' ')"
  if [ "$dropped" != 0 ]; then
    head -20 /tmp/um-dropped.txt | sed 's/^/  DROPPED-UPSTREAM /'
  fi
  echo "DROPPED-UPSTREAM-COUNT $dropped upstream-new files absent from the merge (full list: /tmp/um-dropped.txt)"
}

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
  # Fail closed on a non-numeric measurement — empty, or the literal "undefined"
  # that String(JSON.parse(...).behind) prints when the field is absent (error
  # payload). Otherwise an empty/`undefined` BEHIND is read as `${BEHIND:-0}`==0 in
  # route and silently reports UP-TO-DATE, or garbage flows into routing.
  for v in "$BEHIND" "$RESIDUAL"; do
    case "$v" in
      ''|*[!0-9]*)
        log "non-numeric behind/residual from shadow engine (behind='$BEHIND' residual='$RESIDUAL')"
        ledger "ERROR reason=measure-parse-failed"
        exit 2
        ;;
    esac
  done
}

# --- clean auto-land path ---------------------------------------------------
# residual==0: real-merge in the worktree, prove on Linux, and only on PASS
# advance main + deploy. Rollback tag is written before main moves.
# Land a proof-green ref (a clean merge sha, or an LLM-resolved staging branch) onto
# main and deploy. Shared by the clean-auto path and the resolved staged-land path.
# ff-only only (main never gets a second-parent merge here); rollback tags first;
# regen the fork-config baseline; push; then deploy LAST — the build crashes+respawns
# the gateway, so it must run only once origin durably holds the merge.
land_and_deploy() {
  local ref="$1" date="$2" label="$3"
  git -C "$MAIN" tag -f "main-backup-pre-upstream-merge" main >/dev/null 2>&1
  git -C "$MAIN" tag -f "upstream-merge-$date" main >/dev/null 2>&1
  if ! git -C "$MAIN" merge --ff-only "$ref" >/tmp/um-land.log 2>&1; then
    # An untracked live-tree file colliding with a new upstream path fails ff-only
    # persistently (not just a mid-run main advance), so surface the real git error.
    log "ff-only land blocked — main intact, deferring:"
    tail -n 5 /tmp/um-land.log >&2 2>/dev/null || true
    drop_worktree
    ledger "DEFER reason=ff-blocked label=$label behind=${BEHIND:-?} ref=$ref (see /tmp/um-land.log)"
    exit 1
  fi
  # Regenerate the fork-config baseline for the new main and commit it.
  node "$MAIN/scripts/fork-config-snapshot.mjs" generate >/dev/null 2>&1 || true
  if [ -n "$(git -C "$MAIN" status --porcelain fork-config-baseline.json)" ]; then
    "$MAIN/scripts/committer" "chore(resync): regenerate fork-config baseline after nightly upstream merge ($date)" fork-config-baseline.json >/dev/null 2>&1 || true
  fi
  # Same problem, different artifacts: a merge can take bundle outputs that do not
  # match the sources it merged, and every later build then re-dirties the tree —
  # which makes THIS script SKIP on the following night (it happened twice on
  # 2026-07-27). The generators are deterministic, so regenerating here settles
  # them in the landing commit stream instead of blocking the next run. Paths are
  # explicit so a broken generator cannot sweep unrelated files into the commit.
  # Only the tracked outputs; diffs-language-pack's 10MB viewer-runtime.js is
  # generated-but-untracked and must not be swept into a commit.
  local asset_paths="extensions/canvas/src/host/a2ui/.bundle.hash extensions/diffs/assets/viewer-runtime.js"
  # Commit ONLY on generator success. A crash partway (OOM, a dependency the merge
  # moved, cron's minimal PATH) leaves a truncated artifact that a dirtiness-only
  # check would read as a valid regeneration and then land AND deploy. A failed
  # generator must leave the tree alone; the next run's dirty-tree SKIP is the
  # cheap failure, committing garbage is not.
  if (cd "$MAIN" && node scripts/bundled-plugin-assets.mjs --phase build) >/tmp/um-assets.log 2>&1; then
    # shellcheck disable=SC2086 # word splitting is the intent: one arg per path
    if [ -n "$(git -C "$MAIN" status --porcelain -- $asset_paths)" ]; then
      # shellcheck disable=SC2086
      "$MAIN/scripts/committer" "chore(resync): refresh generated plugin bundle artifacts after nightly upstream merge ($date)" $asset_paths >/dev/null 2>&1 || true
    fi
  else
    # Restore rather than merely decline to commit: the generator may have crashed
    # mid-write, and land_and_deploy pushes and deploys right after this. Without
    # the checkout a truncated artifact would ship, and the next night would SKIP
    # on the dirty tree it left behind.
    # shellcheck disable=SC2086
    git -C "$MAIN" checkout -- $asset_paths >/dev/null 2>&1 || true
    log "plugin asset regeneration failed — artifacts restored (see /tmp/um-assets.log)"
  fi
  local landed; landed="$(git -C "$MAIN" rev-parse --short HEAD)"
  # Deploy-last is only safe once origin holds the merge; if the push fails the merge
  # lives ONLY on local disk, so skip the crash-prone deploy and record the true state.
  if ! git -C "$MAIN" push origin main >/tmp/um-push.log 2>&1; then
    log "push origin main failed — merge landed LOCAL-ONLY, skipping deploy:"
    tail -n 5 /tmp/um-push.log >&2 2>/dev/null || true
    drop_worktree
    ledger "LAND-LOCAL-ONLY reason=push-failed label=$label main=$landed proof=PASS (see /tmp/um-push.log)"
    echo "UPSTREAM-MERGE LANDED LOCAL-ONLY: main @ $landed but push to origin FAILED; NOT deploying. Push manually, then run scripts/cron-deploy-build.sh."
    exit 1
  fi
  drop_worktree
  ledger "LAND $label behind=${BEHIND:-?} main=$landed proof=PASS"
  echo "UPSTREAM-MERGE LANDED ($label): main @ $landed, Linux proof PASS. Deploying…"
  # Deploy LAST: this build crashes+respawns the gateway (kills this session);
  # a detached health watcher records the outcome. main is already durable on origin.
  exec bash "$MAIN/scripts/cron-deploy-build.sh"
}

land_clean() {
  local date; date="$(today)"
  local branch="upstream-auto-merge/$date"
  fresh_worktree
  # Real merge; residual is 0 (measured), so this completes without conflicts.
  # Same rerere scoping as stage_init: this path is only reached when the shadow
  # measurement said zero conflicts, so a rerere replay firing here would mean it
  # silently auto-resolved a conflict the measurement missed.
  if ! git -C "$WORKTREE" -c rerere.enabled=false \
    merge --no-ff --no-edit "$UPSTREAM_REF" >/tmp/um-merge.log 2>&1; then
    log "clean merge unexpectedly conflicted — deferring to resolution path"
    git -C "$WORKTREE" merge --abort 2>/dev/null || true
    drop_worktree
    ledger "DEFER reason=clean-merge-conflicted behind=$BEHIND"
    exit 20
  fi
  # Zero conflicts still means upstream's UI-architecture files were ADDED
  # alongside the fork's ui/src/ui tree; apply the same ownership policy here.
  local ui_dropped; ui_dropped="$(apply_fork_ui_ownership "$WORKTREE")"
  # Gate on the INDEX, not the dropped count. apply_fork_ui_ownership also stages
  # `checkout main -- ui`, which reverts upstream's edits to EXISTING fork ui
  # files; that path stages changes while dropping nothing. Amending only on
  # dropped>0 left those reverts uncommitted, so preflight validated a different
  # tree than the branch that got proved and landed, and upstream ui edits landed
  # anyway — the exact hybrid the ownership policy exists to prevent.
  if ! git -C "$WORKTREE" diff --cached --quiet HEAD; then
    git -C "$WORKTREE" commit -q --no-verify --amend --no-edit
    log "fork ui/ ownership applied to the clean merge (dropped $ui_dropped upstream-only ui files)"
  fi
  local merge_sha; merge_sha="$(git -C "$WORKTREE" rev-parse HEAD)"
  git -C "$WORKTREE" branch -f "$branch" "$merge_sha" >/dev/null 2>&1

  local pre
  if ! pre="$(preflight "$WORKTREE")"; then
    log "clean merge failed local preflight — NOT shipping to huey"
    drop_worktree
    ledger "NO-LAND reason=preflight-failed behind=$BEHIND merge=$merge_sha"
    echo "UPSTREAM-MERGE NO-LAND: clean merge failed local preflight; main untouched."
    printf '%s\n' "$pre"
    exit 1
  fi
  printf '%s\n' "$pre"

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

  # PROOF green -> land + deploy via the shared path.
  land_and_deploy "$merge_sha" "$date" clean
}

# --- staging helpers (agent-driven needs-resolution path) -------------------
stage_init() {
  local date="${1:-$(today)}"
  local branch="resync-staging/$date"
  # Protect committed resolution work from fresh_worktree's rm -rf. Gate on the dir
  # existing (always readable), NOT on git linkage — else a corrupt worktree would
  # skip the guard and get wiped. Only wipe a readable worktree that is 0 commits
  # ahead of main (a pristine auto-merge leftover — stays reentrant). Commits ahead
  # of main, or an unreadable linkage (rev-list fails -> "refuse"), refuse the wipe:
  # a same-day `checkout -B` would reset the branch ref and orphan the commits
  # (reflog-only recovery). Tradeoff: edited-but-uncommitted work isn't guarded here.
  if [ -d "$WORKTREE" ]; then
    local ahead; ahead="$(git -C "$WORKTREE" rev-list --count main..HEAD 2>/dev/null || echo refuse)"
    local held; held="$(git -C "$WORKTREE" symbolic-ref --short HEAD 2>/dev/null || echo '')"
    if [ "$ahead" != 0 ] && [ "$held" = "$branch" ]; then
      log "worktree $WORKTREE already holds today's resolution ($branch, ahead=$ahead) — resume it instead of restaging"
      ledger "STAGE-RESUME branch=$branch ahead=$ahead"
      echo "STAGE-RESUME worktree=$WORKTREE branch=$branch ahead=$ahead"
      return 0
    fi
    # A previous night's staging branch that never landed must not deadlock the
    # nightly: 2026-07-23 and 07-24 each left one behind, and 07-25's committed
    # resolution would have blocked tonight's run entirely. The branch ref keeps
    # the commits reachable, so only the worktree is reclaimed.
    if [ "$ahead" != 0 ]; then
      log "reclaiming stale worktree from '$held' (ahead=$ahead); branch ref keeps those commits"
      ledger "STAGE-RECLAIM stale=$held ahead=$ahead"
    fi
  fi
  fresh_worktree
  git -C "$WORKTREE" checkout -B "$branch" >/dev/null 2>&1
  # rerere replays cached resolutions from earlier passes; a poisoned entry silently
  # re-lands a bad merge, so this merge always resolves from scratch. Scoped with
  # `-c` on the invocation: linked worktrees share the repository config, so
  # `git config rerere.enabled false` here would disable rerere for the operator's
  # live checkout and every future worktree, and outlive this one.
  git -C "$WORKTREE" -c rerere.enabled=false \
    merge --no-commit --no-ff "$UPSTREAM_REF" >/tmp/um-stage-merge.log 2>&1 || true
  local raw; raw="$(git -C "$WORKTREE" status --porcelain | grep -cE '^(DD|AU|UD|UA|DU|AA|UU)' || true)"
  local ui_dropped; ui_dropped="$(apply_fork_ui_ownership "$WORKTREE")"
  local conflicts; conflicts="$(git -C "$WORKTREE" status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)' | wc -l | tr -d ' ')"
  local base; base="$(git -C "$MAIN" merge-base main "$UPSTREAM_REF" 2>/dev/null)"
  echo "STAGE-READY worktree=$WORKTREE branch=$branch conflicts=$conflicts (raw=$raw, ui-policy resolved $((raw - conflicts)), dropped $ui_dropped upstream-only ui files)"
  echo "--- conflict files (resolve in $WORKTREE, then commit, then run: finish-land / stage-finish) ---"
  git -C "$WORKTREE" status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)' || true
  echo "--- merge=ours files upstream changed (rebase these onto upstream, re-apply the fork delta) ---"
  report_merge_ours_drift "$WORKTREE" "$base"
  echo "--- upstream-new files absent from the merge (tsgo is blind to these) ---"
  local dropped_up; dropped_up="$(report_dropped_upstream_files "$WORKTREE" "$base")"
  printf '%s\n' "$dropped_up"
  echo "--- merge base for fork-delta extraction: $base ---"
  ledger "STAGE-INIT branch=$branch conflicts=$conflicts raw=$raw ui-dropped=$ui_dropped $(printf '%s' "$dropped_up" | sed -n 's/^DROPPED-UPSTREAM-COUNT \([0-9]*\).*/dropped-upstream=\1/p')"
}

# Cheap local gate before spending a ~10 minute huey cycle. On 2026-07-25 three
# proof runs were burned on states this would have rejected in seconds: an
# unresolved `,,` from a conflict, then a merge whose tsgo:core went 1 -> 696.
# Runs in the worktree, so it never touches the live tree's dist/.
preflight() {
  local wt="$1"
  local markers
  # Keep this list aligned with the extensions report_merge_ours_drift treats as
  # code: a stray marker in a .kt or .yml file passes an incomplete scan and then
  # burns the ~10 minute huey cycle this gate exists to save.
  markers="$(git -C "$wt" grep -lE '^(<{7}|={7}|>{7})( |$)' -- '*.ts' '*.tsx' '*.mjs' '*.json' '*.yaml' '*.yml' '*.swift' '*.kt' '*.sh' 2>/dev/null | head -20)"
  if [ -n "$markers" ]; then
    echo "PREFLIGHT=FAIL reason=conflict-markers"
    printf '%s\n' "$markers"
    return 1
  fi
  # The protocol generator actually imports the schema modules, so it catches the
  # dropped-export breakage that merge=ours hides from tsgo entirely.
  if ! (cd "$wt" && node --import tsx scripts/protocol-gen.ts >/tmp/um-preflight-protocol.log 2>&1); then
    echo "PREFLIGHT=FAIL reason=protocol-gen"
    tail -n 6 /tmp/um-preflight-protocol.log
    return 1
  fi
  local cand base_errors syntax union union_files
  (cd "$wt" && rm -rf .artifacts/tsgo-cache && node scripts/run-tsgo.mjs -p tsconfig.core.json >/tmp/um-preflight-tsgo.log 2>&1) || true
  # A syntax error aborts the whole check, so the error count stops meaning
  # anything: on 2026-07-27 one orphan `}` from a union-merged conflict reported
  # tsgo:core=1 while the tree actually had 284 errors, making the worst candidate
  # yet look cleaner than a healthy one. TS1xxx is TypeScript's grammar range, so
  # reject on presence and never let it reach the count comparison below.
  syntax="$(grep -E 'error TS1[0-9]{3}:' /tmp/um-preflight-tsgo.log | head -10 || true)"
  if [ -n "$syntax" ]; then
    echo "PREFLIGHT=FAIL reason=tsgo-syntax (error count is unusable until this parses)"
    printf '%s\n' "$syntax"
    return 1
  fi
  # Union-merge signature. When upstream extracts helpers into modules and imports
  # them while the fork still defines them locally, both hunks read as additive and
  # a resolver keeps BOTH — so the file imports and declares the same symbol. tsgo
  # names that collision exactly: TS2440 import-vs-local, TS2323 redeclared export,
  # TS2484 export-declaration conflict. Reporting the class and the owning files
  # beats the generic count, because the collateral swamps it: on 2026-07-27 these
  # 57 collisions dragged 145 more TS2304 "cannot find name" behind them, and the
  # real instruction — re-resolve two files, do not chase 284 errors — was invisible.
  union="$(grep -E 'error TS(2440|2323|2484):' /tmp/um-preflight-tsgo.log | head -10 || true)"
  if [ -n "$union" ]; then
    union_files="$(grep -E 'error TS(2440|2323|2484):' /tmp/um-preflight-tsgo.log | cut -d'(' -f1 | sort -u | tr '\n' ' ')"
    echo "PREFLIGHT=FAIL reason=union-merge files=$union_files"
    echo "  Both sides were kept: these files import a symbol they also declare."
    echo "  Re-resolve those files (adopt upstream's extraction OR keep the fork's"
    echo "  local definitions — not both); most other errors are downstream of this."
    printf '%s\n' "$union"
    return 1
  fi
  cand="$(grep -cE 'error TS' /tmp/um-preflight-tsgo.log || true)"
  # main has been at 0 since the 2026-07-26 resync landed; a stale non-zero
  # baseline silently grants the candidate that many free regressions.
  base_errors="${UPSTREAM_MERGE_TSGO_BASELINE:-0}"
  if [ "${cand:-0}" -gt "$base_errors" ]; then
    echo "PREFLIGHT=FAIL reason=tsgo-core cand=$cand baseline=$base_errors"
    grep -E 'error TS' /tmp/um-preflight-tsgo.log | head -20
    return 1
  fi
  echo "PREFLIGHT=PASS tsgo:core=$cand"
  return 0
}

# Guard the staging worktree and set STAGED_BRANCH (called directly, never in $() —
# an `exit` from here must escape the whole script, not just a subshell). Refuses a
# missing/detached worktree, a non-staging branch, a mismatched requested date, or any
# unresolved/uncommitted merge, so no downstream step proves+lands stale state. Reading
# the branch from the worktree (not a today-derived arg) survives a past-midnight resolve.
resolve_staged_branch() {
  local want_date="$1"
  if ! git -C "$WORKTREE" rev-parse --git-dir >/dev/null 2>&1; then
    log "worktree $WORKTREE missing — run stage-init first"; exit 2
  fi
  local branch; branch="$(git -C "$WORKTREE" symbolic-ref --short HEAD 2>/dev/null)"
  if [ -z "$branch" ]; then
    log "worktree $WORKTREE is not on a staging branch (detached?) — run stage-init"; exit 2
  fi
  case "$branch" in
    resync-staging/*) ;;
    *) log "worktree is on '$branch', not a resync-staging/* branch — refusing"; exit 2 ;;
  esac
  if [ -n "$want_date" ] && [ "$branch" != "resync-staging/$want_date" ]; then
    log "requested date $want_date but worktree is on $branch — refusing (re-stage to change)"; exit 2
  fi
  if [ -n "$(git -C "$WORKTREE" status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)')" ]; then
    log "unresolved conflicts remain in $WORKTREE — resolve + commit first"; exit 2
  fi
  if [ -n "$(git -C "$WORKTREE" status --porcelain --untracked-files=no)" ]; then
    log "worktree has an uncommitted merge — commit the resolution first"; exit 2
  fi
  # Linked worktrees share refs, so $MAIN already sees $branch at the resolved merge HEAD.
  STAGED_BRANCH="$branch"
}

# Prove $STAGED_BRANCH on huey (node24). Non-green exits with the proof rc; main untouched.
prove_staged() {
  # Local gate first — a failure here costs seconds, the huey cycle costs ~10 min.
  local pre
  if ! pre="$(preflight "$WORKTREE")"; then
    ledger "STAGE-PREFLIGHT branch=$STAGED_BRANCH result=FAIL"
    echo "STAGE preflight failed — not shipping to huey. Fix in $WORKTREE, re-commit, re-run."
    printf '%s\n' "$pre"
    exit 1
  fi
  printf '%s\n' "$pre"
  log "proving $STAGED_BRANCH on huey (node24)…"
  local proof rc result
  proof="$(BASELINE_REF=main remote_proof "$STAGED_BRANCH")"; rc=$?
  if [ "$rc" != 0 ]; then
    # Separate "the candidate is red" from "we could not reach the prover", so a
    # transport outage is never read back as a code failure in the ledger.
    # remote-proof.sh documents 3 = UNAVAILABLE (transport) and 2 = usage/local
    # error; mapping 2 to a transport label would triage a local misinvocation as
    # a network outage, which is the inverse of what this split is for.
    case "$rc" in
      3) result=UNAVAILABLE ;;
      2) result=LOCAL-ERROR ;;
      *) result=FAIL ;;
    esac
    ledger "STAGE-PROOF branch=$STAGED_BRANCH result=$result rc=$rc"
    echo "STAGE proof not green (rc=$rc, $result) — branch kept local, NOT landed. main untouched."
    echo "$proof"
    exit "$rc"
  fi
}

# Collision / manual path: prove + push the branch, then STOP with the land command.
# The LLM chooses this when it flags a convergent product-collision it must not auto-pick.
stage_finish() {
  resolve_staged_branch "${1:-}"
  prove_staged
  git -C "$MAIN" push -f origin "$STAGED_BRANCH" >/tmp/um-stage-push.log 2>&1 || log "push staging branch failed"
  drop_worktree
  local tip; tip="$(git -C "$MAIN" rev-parse --short "$STAGED_BRANCH")"
  ledger "STAGE-READY-TO-LAND branch=$STAGED_BRANCH tip=$tip proof=PASS"
  echo "STAGE-READY-TO-LAND: $STAGED_BRANCH @ $tip — Linux proof PASS, pushed to origin. main untouched."
  echo "  Land with:  git -C $MAIN checkout main && git -C $MAIN merge --ff-only $STAGED_BRANCH"
}

# Autonomous path: prove the resolved branch and, ONLY on green, land it to main +
# deploy. The LLM chooses this when it converged with NO flagged product-collision;
# huey proof is the correctness gate, land_and_deploy does the ff-only land + deploy.
finish_land() {
  resolve_staged_branch "${1:-}"
  prove_staged
  # Keep the proof-green branch on origin as a durable record before landing.
  git -C "$MAIN" push -f origin "$STAGED_BRANCH" >/tmp/um-stage-push.log 2>&1 || log "push staging branch failed (landing from local)"
  land_and_deploy "$STAGED_BRANCH" "${STAGED_BRANCH#resync-staging/}" staged
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
  finish-land)  require_main_clean; finish_land "${2:-}";;
  *) echo "usage: cron-upstream-merge.sh {route|measure|stage-init <date>|stage-finish <date>|finish-land <date>}" >&2; exit 2;;
esac
