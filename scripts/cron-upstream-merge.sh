#!/usr/bin/env bash
#
# Phase 3 — hybrid merge-gated (hourly) upstream sync for the cortex fork.
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
#   stage-init <date>     create the merge worktree + resync-staging/<date>, start the merge,
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
WORKTREE="${UPSTREAM_MERGE_WORKTREE:-$MAIN-upstream-merge}"
# An explicit env value is the operator's escape hatch and outranks the stage-time
# pins below; unset means "use the pin, else the live ref".
UPSTREAM_REF_OVERRIDE="${UPSTREAM_REF:-}"
BASELINE_REF_OVERRIDE="${BASELINE_REF:-}"
UPSTREAM_REF="${UPSTREAM_REF_OVERRIDE:-upstream/main}"
# Baseline main sha the huey proof diffs its error set against. `main` advances
# beneath an open staging branch most nights (the daily-research cron), and
# remote-proof rejects a baseline that is no longer an ancestor of the branch, so
# this is pinned when the merge is staged rather than re-resolved at prove time.
STAGE_BASELINE_REF="${BASELINE_REF_OVERRIDE:-main}"
# The ref whose blobs are "what merge=ours kept" — the main tip the branch was staged
# from. Deliberately NOT tied to BASELINE_REF: that knob re-points the huey proof
# baseline, and letting it also move this one turned the documented escape hatch into
# a way to silently empty the drift report and pass the export gate on zero files.
STAGE_OURS_REF="main"
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-/home/joe/node24/bin}"   # upstream needs node>=22.22.3
LOG="${UPSTREAM_MERGE_LOG:-$HOME/.openclaw/workspace/memory/reports/upstream-merge.log}"
# Scratch for the set-comparison plumbing (drift/dropped/ui listings). Overridable
# so a test run cannot clobber a concurrent run's intermediate files, and vice
# versa. Operator-facing logs keep their fixed /tmp paths; these are internal.
UM_TMP="${UPSTREAM_MERGE_TMPDIR:-/tmp}"
export REMOTE_NODE_BIN

cd "$MAIN" || { echo "MERGE-ABORT: main tree missing"; exit 2; }
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

stamp() { date -u +%Y-%m-%dT%H:%MZ; }
today() { date +%Y-%m-%d; }
log()   { echo "[upstream-merge] $*" >&2; }
ledger(){ echo "$(stamp) $*" >>"$LOG" 2>/dev/null || true; }

# The run must start from a clean main checkout; if the live tree is parked on a
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

# --- stage-time reference pins ----------------------------------------------
# UPSTREAM_REF is a moving remote-tracking ref, and `main` moves too. Every gate
# downstream of stage-init re-resolved both at prove time, so an ordinary
# `git fetch upstream` between staging and proving made the merge=ours export gate
# diff the staged merge against a FUTURE upstream and name 10 untouched files as
# dropped exports, while a landed cron commit made the proof reject its own baseline
# as "not an ancestor". Pin what the merge was actually built from; read it back when
# proving. Refs rather than a sidecar file: a ref also keeps the pinned upstream
# commit reachable if upstream force-pushes or prunes it away.
pin_ref() { printf 'refs/upstream-merge-pin/%s/%s' "$1" "$2"; }

write_stage_pins() {
  local branch="$1"
  git -C "$MAIN" update-ref "$(pin_ref "$branch" upstream)" "$2" 2>/dev/null \
    || log "could not pin upstream ref for $branch"
  git -C "$MAIN" update-ref "$(pin_ref "$branch" baseline)" "$3" 2>/dev/null \
    || log "could not pin baseline ref for $branch"
}

# Repoint UPSTREAM_REF / STAGE_BASELINE_REF at what the staged merge was built from.
# A branch staged before pinning existed (or staged by hand) has no pins; keep the
# live refs and SAY so rather than failing — a stale-ref gate failure is confusing,
# a silent one is worse.
load_stage_pins() {
  local branch="$1" up base
  up="$(git -C "$MAIN" rev-parse --verify -q "$(pin_ref "$branch" upstream)" 2>/dev/null)"
  base="$(git -C "$MAIN" rev-parse --verify -q "$(pin_ref "$branch" baseline)" 2>/dev/null)"
  if [ -n "$UPSTREAM_REF_OVERRIDE" ]; then
    log "UPSTREAM_REF forced by env to $UPSTREAM_REF (ignoring stage pin)"
  elif [ -n "$up" ]; then
    UPSTREAM_REF="$up"
  else
    log "no upstream pin for $branch — gates compare against the LIVE $UPSTREAM_REF"
  fi
  if [ -n "$BASELINE_REF_OVERRIDE" ]; then
    log "BASELINE_REF forced by env to $STAGE_BASELINE_REF (ignoring stage pin)"
  elif [ -n "$base" ]; then
    STAGE_BASELINE_REF="$base"
  fi
  # Independent of the proof-baseline override above: this one must always be the
  # staged tip when a pin exists.
  if [ -n "$base" ]; then
    STAGE_OURS_REF="$base"
  else
    # Without this the baseline silently stays the literal `main`, which the drift
    # gate and the huey proof both resolve live — reproducing the very ancestry
    # failure the pins exist to prevent, but with no line saying why.
    log "no baseline pin for $branch — using the LIVE main; if it advanced past this branch, proof will reject the baseline as 'not an ancestor'"
  fi
  log "stage pins: upstream=$UPSTREAM_REF baseline=$STAGE_BASELINE_REF"
}

# A pin outlives nothing but its branch: once the staging branch ref is gone the
# merge commit carries the provenance, so drop it and keep the namespace bounded.
prune_stage_pins() {
  local ref branch
  while read -r ref; do
    [ -n "$ref" ] || continue
    branch="${ref#refs/upstream-merge-pin/}"; branch="${branch%/upstream}"
    git -C "$MAIN" rev-parse --verify -q "refs/heads/$branch" >/dev/null 2>&1 && continue
    git -C "$MAIN" update-ref -d "$(pin_ref "$branch" upstream)" 2>/dev/null || true
    git -C "$MAIN" update-ref -d "$(pin_ref "$branch" baseline)" 2>/dev/null || true
  done < <(git -C "$MAIN" for-each-ref --format='%(refname)' refs/upstream-merge-pin/ 2>/dev/null \
    | grep '/upstream$' || true)
}

# Resolve the live upstream ref to an immutable sha for the rest of this process, so
# the merge, both drift reports, the export gate, and the pin all describe one tree.
freeze_upstream_ref() {
  local sha; sha="$(git -C "$MAIN" rev-parse --verify -q "${UPSTREAM_REF}^{commit}" 2>/dev/null)"
  [ -n "$sha" ] || {
    log "cannot resolve $UPSTREAM_REF"
    ledger "ERROR reason=upstream-ref-unresolvable ref=$UPSTREAM_REF"
    exit 2
  }
  UPSTREAM_REF="$sha"
}

# --- worktree lifecycle ------------------------------------------------------
# A worktree's node_modules is the expensive part of it, and `preflight`
# (protocol-gen + tsgo) cannot run at all without one. Wipe-and-recreate threw it
# away on every run, so the run could never pass its own gate — that is why the
# autonomous path never got past preflight. Reset with git instead and keep the deps.
# Returns non-zero when the tree cannot be reset in place; callers then recreate it.
reset_worktree_to() {
  local head="$1"
  [ -d "$WORKTREE" ] || return 1
  git -C "$WORKTREE" rev-parse --git-dir >/dev/null 2>&1 || return 1
  git -C "$WORKTREE" merge --abort 2>/dev/null || true
  git -C "$WORKTREE" rebase --abort 2>/dev/null || true
  git -C "$WORKTREE" checkout -f --detach "$head" >/dev/null 2>&1 || return 1
  git -C "$WORKTREE" reset -q --hard "$head" >/dev/null 2>&1 || return 1
  # -e node_modules is a gitignore pattern, so it spares the workspace packages'
  # nested node_modules too. Everything else untracked or ignored goes, leaving the
  # tree byte-identical to $head plus its installed dependencies.
  # An untracked file git cannot unlink (an interrupted build left a read-only dir)
  # otherwise survives into the merge, which aborts with "untracked working tree file
  # would be overwritten" and gets reported as a phantom conflict every night.
  # Reporting failure alone does NOT help: the recreate path cannot remove what clean
  # could not either (rm does not chmod), so it fails too and the run dies on
  # `worktree add` with a bare exit 2. Restore write permission and retry — that is
  # the only step that actually clears this state unattended.
  if ! git -C "$WORKTREE" clean -qfdx -e node_modules >/dev/null 2>&1; then
    chmod -R u+w "$WORKTREE" 2>/dev/null || true
    git -C "$WORKTREE" clean -qfdx -e node_modules >/dev/null 2>&1 || return 1
  fi
  return 0
}

fresh_worktree() {
  local head; head="$(git -C "$MAIN" rev-parse HEAD)"
  reset_worktree_to "$head" && return 0
  [ -d "$WORKTREE" ] && log "worktree unusable — recreating (dependencies reinstall at preflight)"
  git -C "$MAIN" worktree remove --force "$WORKTREE" 2>/dev/null || true
  rm -rf "$WORKTREE" 2>/dev/null || true
  git -C "$MAIN" worktree add --detach "$WORKTREE" "$head" >/dev/null 2>&1 || {
    # Unattended runs are read from the ledger, so this must never abort silently.
    log "worktree add failed — $WORKTREE could not be reclaimed (check permissions)"
    ledger "ERROR reason=worktree-unrecoverable path=$WORKTREE"
    exit 2
  }
}

# Release the worktree after a run WITHOUT deleting it: removing it drops the
# installed dependencies fresh_worktree exists to preserve. Left detached at main's
# HEAD and clean, so the operator's `git worktree list` stays honest and the next
# run starts warm.
release_worktree() {
  reset_worktree_to "$(git -C "$MAIN" rev-parse HEAD)" >/dev/null 2>&1 || true
}

# preflight runs protocol-gen and tsgo inside the worktree; both need node_modules,
# and the merge itself can move pnpm-lock.yaml. Install only when the lockfile the
# current node_modules was installed from no longer matches the tree — the stamp
# lives inside node_modules, so wiping the deps invalidates it automatically.
ensure_worktree_deps() {
  local wt="$1"
  local stamp="$wt/node_modules/.upstream-merge-lock-hash"
  # Fail closed: an unreadable lockfile means the short-circuit cannot be trusted, so
  # install rather than silently letting preflight run against whatever is on disk.
  local want; want="$(git -C "$wt" hash-object pnpm-lock.yaml 2>/dev/null)"
  if [ -d "$wt/node_modules" ] && [ -n "$want" ] && [ "$want" = "$(cat "$stamp" 2>/dev/null)" ]; then
    return 0
  fi
  # Resolve the package manager rather than assuming corepack: it ships with node on
  # huey but is absent on the operator's Mac (pnpm is installed directly), and cron's
  # PATH is narrower still. An unresolvable `corepack` failed the install instantly
  # with "No such file or directory", which reads as a dependency problem.
  # Probe usability, not mere presence: corepack ships with node but may be disabled,
  # or have no cached build of the packageManager-pinned pnpm and no network to fetch
  # one. Selecting it on `command -v` alone meant a broken corepack shadowed a
  # perfectly good pnpm and failed the run the same way a missing one did.
  local pm
  if command -v corepack >/dev/null 2>&1 && (cd "$wt" && corepack pnpm --version >/dev/null 2>&1); then
    pm="corepack pnpm"
  elif command -v pnpm >/dev/null 2>&1; then
    pm="pnpm"
  else
    log "neither corepack nor pnpm is on PATH — cannot install worktree dependencies"
    return 1
  fi
  log "installing worktree dependencies (lock $want, via $pm); reruns only when the lockfile moves"
  # shellcheck disable=SC2086 # $pm is a deliberate two-word command
  if ! (cd "$wt" && CI=1 npm_config_verify_deps_before_run=false \
    nice -n 19 $pm install --frozen-lockfile) >/tmp/um-worktree-install.log 2>&1; then
    log "worktree pnpm install failed (see /tmp/um-worktree-install.log):"
    tail -n 5 /tmp/um-worktree-install.log >&2 2>/dev/null || true
    return 1
  fi
  printf '%s\n' "$want" > "$stamp" 2>/dev/null || true
  return 0
}

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
  # core.quotePath=false for the same reason as report_merge_ours_drift: a quoted
  # non-ASCII path would be handed to `git rm --ignore-unmatch`, match nothing, and
  # fail silently while still being counted as dropped.
  git -C "$wt" -c core.quotePath=false ls-tree -r --name-only main ui | LC_ALL=C sort > "$UM_TMP/um-ui-main.txt"
  git -C "$wt" -c core.quotePath=false ls-files -- ui | LC_ALL=C sort -u > "$UM_TMP/um-ui-index.txt"
  # comm compares under its own collation, so it must run in the same locale the
  # inputs were sorted in. Sorting C and comparing under en_US.UTF-8 desynchronizes
  # the streams and yields near-garbage (measured: 447 phantom "dropped" files
  # against a true 2). ls-files also emits one line per conflict stage, so -u.
  LC_ALL=C comm -13 "$UM_TMP/um-ui-main.txt" "$UM_TMP/um-ui-index.txt" > "$UM_TMP/um-ui-extra.txt"
  local dropped; dropped="$(wc -l < "$UM_TMP/um-ui-extra.txt" | tr -d ' ')"
  if [ "$dropped" != 0 ]; then
    tr '\n' '\0' < "$UM_TMP/um-ui-extra.txt" | xargs -0 git -C "$wt" rm -q -f --ignore-unmatch --
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
#
# Writes the real-loss set to $UM_TMP/um-merge-ours-drift-code.txt for the export
# gate below. "Real loss" is narrower than "protected and upstream-changed":
#   - the `ours` driver only runs when BOTH sides changed. A protected file the
#     fork never edited merges to upstream normally, so it loses nothing
#     (verified: server-methods/chat.ts, fork delta 0, merged == upstream).
#   - `.gitattributes` also carries entries for paths that no longer exist here
#     and for files upstream has since renamed away.
# Reporting the wide set buried the 24 files that actually lose work under 15
# harmless ones plus rename noise.
report_merge_ours_drift() {
  local wt="$1" base="$2"
  : > "$UM_TMP/um-merge-ours-drift-code.txt"
  [ -n "$base" ] || { echo "MERGE-OURS-DRIFT-COUNT skipped (no merge base)"; return 0; }
  # --stdin batches one check-attr over the whole changed set; per-file forks over
  # an 8k-file upstream delta take minutes and invite SIGPIPE truncation.
  # core.quotePath=false: these paths are consumed programmatically. Quoted output
  # ("a\303\244.ts", with the quotes) fails every rev-parse below and the || continue
  # guards would then drop such a file from the loss report entirely.
  git -C "$wt" -c core.quotePath=false diff --name-only "$base" "$UPSTREAM_REF" 2>/dev/null \
    | git -C "$wt" -c core.quotePath=false check-attr merge --stdin 2>/dev/null \
    | sed -n 's/: merge: ours$//p' > "$UM_TMP/um-merge-ours-drift.txt"
  local all; all="$(wc -l < "$UM_TMP/um-merge-ours-drift.txt" | tr -d ' ')"
  # ui/ is fork-owned by policy (apply_fork_ui_ownership), not silently dropped.
  local f merged ours upstream
  while read -r f; do
    case "$f" in ui/*) continue ;; *.ts|*.tsx|*.mjs|*.swift|*.kt) ;; *) continue ;; esac
    merged="$(git -C "$wt" rev-parse ":0:$f" 2>/dev/null)" || continue
    # STAGE_BASELINE_REF, not `main`: the merge's first parent is the main tip the
    # branch was STAGED at, and that is what merge=ours kept. Reading live `main`
    # made every file the run landed after staging compare unequal, so
    # `[ "$merged" = "$ours" ] || continue` silently dropped it from the loss list —
    # blinding the one gate built for the class tsgo cannot see.
    ours="$(git -C "$wt" rev-parse "$STAGE_OURS_REF:$f" 2>/dev/null)" || continue
    upstream="$(git -C "$wt" rev-parse "$UPSTREAM_REF:$f" 2>/dev/null)" || continue
    # kept ours AND upstream's version differs => upstream's delta was discarded
    [ "$merged" = "$ours" ] || continue
    [ "$upstream" = "$ours" ] && continue
    echo "$f" >> "$UM_TMP/um-merge-ours-drift-code.txt"
  done < "$UM_TMP/um-merge-ours-drift.txt"
  local code; code="$(wc -l < "$UM_TMP/um-merge-ours-drift-code.txt" | tr -d ' ')"
  sed 's/^/  MERGE-OURS-DRIFT /' "$UM_TMP/um-merge-ours-drift-code.txt"
  echo "MERGE-OURS-DRIFT-COUNT $code code files losing upstream work ($all protected paths in the delta)"
}

# The exported NAMES of one object (`<rev>:<path>` or `:0:<path>`), sorted+unique.
# Names, not whole lines: upstream reformats constantly, and a line-level compare
# reads `export const S = Type.Object(` vs `export const S = closedObject(` as two
# different exports. On agents-models-skills.ts that alone reported ~80 phantom
# losses for a file whose exported surface is nearly identical.
sorted_export_names() {
  git -C "$1" show "$2" 2>/dev/null | awk '
    # Strip block comments before any rule sees the line. A commented-out `export`
    # is not an export, in both directions: a one-sided commented export invents a
    # phantom name, and a name living only inside a comment here would look present
    # and mask a real upstream loss. Anchoring on `/*` at line start would miss the
    # `code; /*` opening, so this tracks the state wherever the delimiter appears.
    {
      if (incomment) {
        if (match($0, /\*\//)) { incomment = 0; $0 = substr($0, RSTART + 2) } else { next }
      }
      # A template literal spans lines, so its body is scanned as code unless the
      # open-backtick state is carried the way incomment is. Generator sources are
      # in the protected set (scripts/build-all.mjs), and a body line starting with
      # `export ` would be emitted as a phantom name.
      if (intemplate) {
        if (match($0, /`/)) { intemplate = 0; $0 = substr($0, RSTART + 1) } else { next }
      }
      # Detect on a copy with string bodies blanked: a glob like "src/**/*.ts" or a
      # URL ending in /* would otherwise open comment mode and silently swallow every
      # export below it (966 such lines on this tree). mask_strings is length-
      # preserving, so match offsets apply unchanged to the real line.
      masked = mask_strings($0)
      while (match(masked, /\/\*/)) {
        cstart = RSTART
        # Locate the CLOSE on the raw line: a comment body is not code, so masking
        # it is wrong. `/* don'"'"'t use */` has an unbalanced quote that blanks its own
        # `*/` in the masked copy, and the comment would latch open — swallowing
        # every export below it in this revision only.
        rest = substr($0, cstart + 2)
        if (match(rest, /\*\//)) {
          $0 = substr($0, 1, cstart - 1) substr(rest, RSTART + 2)
          masked = mask_strings($0)
        } else {
          incomment = 1
          $0 = substr($0, 1, cstart - 1)
          unterminated_backtick = 0
          masked = $0
          break
        }
      }
      # Drop any line comment once, here, so no rule below has to think about it.
      $0 = substr($0, 1, length(masked))
      if (unterminated_backtick) { intemplate = 1 }
      if ($0 ~ /^[[:space:]]*$/) { next }
    }
    # Inside a multi-line `export { ... }` list, every identifier is exported,
    # or its alias when written `a as b`.
    inlist {
      # Close on a `}` in the masked copy, so one inside a string cannot end the
      # list early and drop every name on the lines below.
      inmask = mask_strings($0)
      if (match(inmask, /}/)) { $0 = substr($0, 1, RSTART - 1); inlist = 0 }
      emit_list($0); next
    }
    /^[[:space:]]*export([^A-Za-z0-9_]|$)/ {
      line = $0
      sub(/^[[:space:]]*export/, "", line)
      sub(/^[[:space:]]+/, "", line)
      if (line ~ /^default/)  { print "default"; next }
      # Star re-exports, including `export type * from` — matched before the
      # modifier strip, which would otherwise leave `* from "./x"` and emit the
      # phantom name `from`. `* as ns` exports the namespace binding, not `*`.
      if (line ~ /^(type[[:space:]]+)?\*/) {
        sub(/^type[[:space:]]+/, "", line)
        if (match(line, /^\*[[:space:]]+as[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*/)) {
          tail = substr(line, RSTART, RLENGTH)
          sub(/^\*[[:space:]]+as[[:space:]]+/, "", tail)
          print tail
        } else if (match(line, /["'"'"'][^"'"'"']+["'"'"']/)) {
          # Keyed by module specifier, so a barrel gaining a second
          # `export * from "./new"` is a new set element. A bare `*` for all of them
          # deduped through `sort -u` and the gate never saw the addition — the
          # invisible-to-tsgo class it exists to catch. The specifier is stable
          # across reformatting, so this cannot invent a one-sided phantom.
          print "*:" substr(line, RSTART + 1, RLENGTH - 2)
        } else {
          print "*"
        }
        next
      }
      # `export type { A, B }` is a grouped list, not a `type` declaration. Without
      # this the modifier strip below eats the `type` and the single-identifier
      # fallback returns only `A`, hiding every later name — and reading
      # `type { A as B }` as `A` instead of the exported `B`.
      if (line ~ /^type[[:space:]]*\{/) { sub(/^type[[:space:]]*/, "", line) }
      if (line ~ /^\{/) {
        sub(/^\{/, "", line)
        if (match(line, /}/)) { sub(/}.*/, "", line) } else { inlist = 1 }
        emit_list(line); next
      }
      # `export declare async function foo` and friends: drop modifiers, then the
      # first identifier is the exported name.
      # The `\*?` keeps generators: without it `export function* gen` fails the
      # strip and the fallback below returns the literal word `function`, so every
      # generator export collapses to one name and a renamed one is invisible.
      # `const enum` leads the alternation so it wins over bare `const`; otherwise
      # every const enum in a file extracts as the literal word `enum` and a rename
      # between two of them is invisible.
      sub(/^(declare[[:space:]]+)?(abstract[[:space:]]+)?(async[[:space:]]+)?(const[[:space:]]+enum|const|let|var|function|class|interface|enum|type|namespace)[[:space:]]*\*?[[:space:]]*/, "", line)
      # `export const { a, b } = x` binds every name in the pattern.
      if (line ~ /^[{[]/) {
        sub(/^[{[]/, "", line)
        sub(/[}\]].*/, "", line)
        emit_list(line); next
      }
      # Otherwise exactly one name, taken without splitting on commas. Splitting
      # here would invent phantom names from commas that are not separators, and
      # those outnumber the real multi-declarator exports by ~27x on this tree
      # (measured 2026-07-27: 82 `export const x: Foo<A, B> = ...` style lines
      # against 3 `export const A = 1, B = 2`). A phantom present on only one side
      # fails the gate over an unchanged export surface, so the trade is not close.
      # Accepted gap: the second name of those 3 declarator lists is not tracked.
      if (match(line, /[A-Za-z_$][A-Za-z0-9_$]*/)) {
        print substr(line, RSTART, RLENGTH)
      }
      next
    }
    # A copy of the line safe to scan for comment delimiters: quoted spans are
    # blanked and a line comment truncates the rest. Everything a `/*` could hide
    # behind must be neutralised here, because one unclosed `/*` latches comment
    # mode and drops every export below it — one-sided, that is either a phantom
    # missing export (spurious PREFLIGHT=FAIL) or a masked real loss.
    # Length is preserved up to the truncation point, so match offsets taken from
    # this copy address the same characters in the real line.
    # Accepted gap: regex literals. Recognising `/.../ ` needs real lexing, and a
    # regex containing an unclosed `/*` is far rarer than the forms handled here.
    function mask_strings(s,   out, i, c, q, n) {
      out = ""; q = ""; n = length(s)
      for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if (q != "") {
          # Escaped char: blank the pair so a `\"` cannot end masking early and
          # expose the rest of the literal to the comment scan.
          if (c == "\\") { out = out "  "; i++; continue }
          out = out ((c == q) ? c : " ")
          if (c == q) { q = "" }
        } else if (c == "\"" || c == "'"'"'" || c == "`") {
          q = c; out = out c
        } else if (c == "/" && substr(s, i + 1, 1) == "/") {
          unterminated_backtick = 0
          return out
        } else { out = out c }
      }
      # Signals an open template literal to the caller, which carries the state to
      # the next line.
      unterminated_backtick = (q == "`")
      return out
    }
    function emit_list(s,   parts, i, n, tok) {
      n = split(s, parts, ",")
      for (i = 1; i <= n; i++) {
        tok = parts[i]
        sub(/.*[[:space:]]as[[:space:]]+/, "", tok)   # `a as b` exports b
        # Inline type specifier `{ x, type T }` (typescript-eslint autofixes to
        # this form); without the strip the gsub below welds it into `typeT` and
        # a pure type-annotation refactor upstream reads as a renamed export.
        sub(/^[[:space:]]*type[[:space:]]+/, "", tok)
        # Destructuring rename `{ a: renamed }` binds `renamed`; without this the
        # gsub below welds the pair into `arenamed`, inventing a name and hiding
        # the real one. Grouped export lists never contain a colon.
        sub(/.*:[[:space:]]*/, "", tok)
        # Destructuring default `{ a = 1 }` binds `a`; the gsub would weld it to `a1`
        # and a default-only upstream change would fail the gate on a phantom.
        sub(/=.*/, "", tok)
        gsub(/[^A-Za-z0-9_$]/, "", tok)
        if (tok != "") print tok
      }
    }
  ' | LC_ALL=C sort -u
}

# Rank the discarded-upstream-work set. report_merge_ours_drift lists every file
# whose upstream changes the driver threw away, undifferentiated: 24 lines on
# 2026-08-03, of which only 5 touched the export surface. The other 19 are the
# documented cost of forking a file, and an unranked list hides the 5 that matter
# among them.
#
# This reports, it never gates. Measured on that merge, every export-adding file
# had already been rebased and all 17 left open were internal-only — so a coverage
# gate over the whole set would have manufactured 17 rebases and caught nothing.
# Churn is how much upstream work each freeze discards, which is what makes an
# internal-only file worth adopting deliberately rather than by rule.
report_merge_ours_priority() {
  local wt="$1" base="$2"
  [ -s "$UM_TMP/um-merge-ours-drift-code.txt" ] || return 0
  local f adds churn
  while read -r f; do
    # Export names are a TS-family concept; .kt/.swift stay in the drift report.
    case "$f" in *.ts | *.tsx | *.mjs) ;; *) continue ;; esac
    adds="$(LC_ALL=C comm -23 \
      <(sorted_export_names "$wt" "$UPSTREAM_REF:$f") \
      <(sorted_export_names "$wt" "$STAGE_OURS_REF:$f") | tr '\n' ' ')"
    churn="$(git -C "$wt" diff --numstat "$base" "$UPSTREAM_REF" -- "$f" 2>/dev/null |
      awk '{print $1 + $2; exit}')"
    # Sortable prefix, stripped by the cut below: export-surface files first, then
    # by how much upstream work the freeze discards.
    if [ -n "$(printf '%s' "$adds" | tr -d '[:space:]')" ]; then
      printf '0|%s|  MERGE-OURS-PRIORITY exports churn=%s %s: %s\n' \
        "${churn:-0}" "${churn:-0}" "$f" "$adds"
    else
      printf '1|%s|  MERGE-OURS-PRIORITY internal churn=%s %s\n' "${churn:-0}" "${churn:-0}" "$f"
    fi
  done < "$UM_TMP/um-merge-ours-drift-code.txt" | LC_ALL=C sort -t'|' -k1,1 -k2,2nr | cut -d'|' -f3-
}

# The pre-merge work queue. scripts/resync-ledger.mjs classifies every
# merge-relevant file from a read-only `git merge-tree` dry run — adopt / keep /
# auto / keep-ours / relocate / resolve — and tiers the resolve set by risk. It
# predicted exactly the 25 non-ui conflicts the 2026-08-03 resync then resolved by
# hand, before anything was staged, and nothing called it.
#
# ui/ is fork-owned by policy (apply_fork_ui_ownership), so its 319 entries are
# resolved by ownership rather than judgment; printing them would bury the code
# set 13:1. The full ledger keeps them.
report_resync_ledger() {
  local head_ref="$1"
  local md="$UM_TMP/um-resync-ledger.md"
  if ! node "$MAIN/scripts/resync-ledger.mjs" --upstream "$UPSTREAM_REF" --head "$head_ref" \
    --md "$md" >/dev/null 2>"$UM_TMP/um-ledger-err.txt"; then
    # Never skip silently: an unclassified conflict set reads exactly like an empty
    # one in the stage log, and the operator plans off this.
    echo "RESYNC-QUEUE skipped (planner failed) — conflict set unclassified"
    tail -n 3 "$UM_TMP/um-ledger-err.txt" 2>/dev/null
    return 0
  fi
  local queue
  queue="$(grep -E '^- \[' "$md" 2>/dev/null | grep -vE '^- \[[a-z]+/ui\] ' || true)"
  if [ -n "$queue" ]; then
    printf '%s\n' "$queue" | sed 's/^- /  RESYNC-QUEUE /'
  fi
  echo "RESYNC-QUEUE-COUNT $(printf '%s' "$queue" | grep -c .) code files need judgment (full ledger: $md)"
}

# The subset of merge=ours loss that breaks consumers instead of merely aging the
# file: upstream changed the module's EXPORTED surface and the merge kept our copy,
# so an upstream-adopted importer resolves against a stale module. tsgo is blind
# (the importer type-checks against the file that is actually there) and the tree
# stays green until something dereferences the missing symbol at runtime — this is
# how three protocol exports vanished on 2026-07-25. Ordinary internal upstream
# edits to a protected file are the accepted, documented cost of forking it; only
# the export surface fails the build for someone else, so only it gates.
# Resolution is per file: rebase it onto upstream and re-apply the fork delta.
check_merge_ours_export_drift() {
  local wt="$1" base="$2"
  # Never skip silently: this gate exists to catch loss nothing else sees, so a
  # skipped run must not read like a clean pass in the preflight log.
  if [ -z "$base" ]; then
    echo "EXPORT-DRIFT-GATE skipped (no merge base) — protected-file export loss unchecked"
    return 0
  fi
  if ! report_merge_ours_drift "$wt" "$base" >/dev/null 2>"$UM_TMP/um-drift-err.txt"; then
    echo "EXPORT-DRIFT-GATE skipped (drift report failed) — export loss unchecked"
    tail -n 3 "$UM_TMP/um-drift-err.txt" 2>/dev/null
    return 0
  fi
  local f hits missing
  hits=""
  while read -r f; do
    # `export` is a TS/JS keyword; the loss report also admits .swift/.kt, whose
    # public surface is spelled with visibility modifiers. Gating those here would
    # compare two empty sets and pass unconditionally — coverage a future reader
    # would assume is real. They stay in the report; only TS-family files gate.
    case "$f" in *.ts | *.tsx | *.mjs) ;; *) continue ;; esac
    # (upstream_now - base) - ours: an export upstream ADDED in this window that
    # the merge result lacks. Each term is load-bearing.
    #   - subtracting base skips long-standing fork divergence. The fork has
    #     deliberately dropped 32 SkillsCurator*/SkillsProposal* exports from
    #     agents-models-skills.ts since before this base; upstream changed none of
    #     them, so this merge drops nothing and the gate must stay quiet.
    #   - comparing against ours (not base) keeps the gate clearable: the operator
    #     hand-carries the new export in and it goes green. A base-vs-upstream
    #     compare never would — the base only advances when a merge lands, and the
    #     gate is what blocks landing.
    # A pure upstream rename still fires, correctly: the new name is absent here.
    missing="$(LC_ALL=C comm -23 \
      <(LC_ALL=C comm -23 \
        <(sorted_export_names "$wt" "$UPSTREAM_REF:$f") \
        <(sorted_export_names "$wt" "$base:$f")) \
      <(sorted_export_names "$wt" ":0:$f"))"
    if [ -n "$missing" ]; then
      hits="$hits $f"
    fi
  done < "$UM_TMP/um-merge-ours-drift-code.txt"
  [ -n "$hits" ] || return 0
  echo "PREFLIGHT=FAIL reason=merge-ours-export-drift files=$hits"
  echo "  merge=ours kept our copy of these; upstream exports symbols they lack."
  echo "  Rebase each onto $UPSTREAM_REF and re-apply only the fork delta; keeping"
  echo "  our stale copy leaves upstream-adopted importers resolving a dead symbol."
  return 1
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
  git -C "$wt" -c core.quotePath=false ls-tree -r --name-only "$UPSTREAM_REF" | LC_ALL=C sort > "$UM_TMP/um-up.txt"
  # The merge result is the INDEX, not HEAD: this runs mid-merge (--no-commit), so
  # HEAD is still pre-merge main and every upstream-new file would read as dropped.
  git -C "$wt" -c core.quotePath=false ls-files          | LC_ALL=C sort -u > "$UM_TMP/um-head.txt"
  git -C "$wt" -c core.quotePath=false ls-tree -r --name-only "$base"        | LC_ALL=C sort > "$UM_TMP/um-base.txt"
  # in upstream, not at the base (i.e. upstream-new), and not in the merge result.
  # LC_ALL=C on comm for the same reason as apply_fork_ui_ownership.
  LC_ALL=C comm -23 "$UM_TMP/um-up.txt" "$UM_TMP/um-base.txt" > "$UM_TMP/um-upnew.txt"
  LC_ALL=C comm -23 "$UM_TMP/um-upnew.txt" "$UM_TMP/um-head.txt" | grep -v '^ui/' > "$UM_TMP/um-dropped.txt" || true
  local dropped; dropped="$(wc -l < "$UM_TMP/um-dropped.txt" | tr -d ' ')"
  if [ "$dropped" != 0 ]; then
    head -20 "$UM_TMP/um-dropped.txt" | sed 's/^/  DROPPED-UPSTREAM /'
  fi
  echo "DROPPED-UPSTREAM-COUNT $dropped upstream-new files absent from the merge (full list: $UM_TMP/um-dropped.txt)"
}

# Measure the post-driver residual via the shadow engine (read-only; own worktree).
# Emits: BEHIND / RESIDUAL globals.
measure() {
  git -C "$MAIN" fetch upstream -q 2>/dev/null || log "fetch upstream failed (using cached)"
  # Freeze immediately after the fetch: everything from here on (engine measurement,
  # merge, drift reports, export gate) must describe the same upstream tree.
  freeze_upstream_ref
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
  # Landing is ff-only against LOCAL main, which succeeds even when origin/main has
  # moved on — the push at the end is then rejected and the run ends in
  # LAND-LOCAL-ONLY with main already advanced and the gateway not deployed. Check
  # before touching main, and re-fetch once in case the ref is merely stale.
  git -C "$MAIN" fetch origin -q 2>/dev/null || true
  if ! git -C "$MAIN" merge-base --is-ancestor origin/main "$ref" 2>/dev/null; then
    log "origin/main is not an ancestor of $ref — refusing to land (push would be rejected after main moved)"
    release_worktree
    ledger "DEFER reason=origin-ahead label=$label ref=$ref origin=$(git -C "$MAIN" rev-parse --short origin/main 2>/dev/null)"
    echo "UPSTREAM-MERGE DEFER: origin/main advanced beneath $ref; rebase the branch on origin/main and re-prove. main untouched."
    exit 3
  fi
  git -C "$MAIN" tag -f "main-backup-pre-upstream-merge" main >/dev/null 2>&1
  git -C "$MAIN" tag -f "upstream-merge-$date" main >/dev/null 2>&1
  if ! git -C "$MAIN" merge --ff-only "$ref" >/tmp/um-land.log 2>&1; then
    # An untracked live-tree file colliding with a new upstream path fails ff-only
    # persistently (not just a mid-run main advance), so surface the real git error.
    log "ff-only land blocked — main intact, deferring:"
    tail -n 5 /tmp/um-land.log >&2 2>/dev/null || true
    release_worktree
    ledger "DEFER reason=ff-blocked label=$label behind=${BEHIND:-?} ref=$ref (see /tmp/um-land.log)"
    exit 1
  fi
  # Regenerate the fork-config baseline for the new main and commit it.
  node "$MAIN/scripts/fork-config-snapshot.mjs" generate >/dev/null 2>&1 || true
  if [ -n "$(git -C "$MAIN" status --porcelain fork-config-baseline.json)" ]; then
    # scripts/committer was removed upstream (00a5db443aa); commit directly so the
    # regenerated baseline is not left uncommitted — a dirty tree makes the next
    # (now hourly) run SKIP on require_main_clean.
    git -C "$MAIN" add fork-config-baseline.json >/dev/null 2>&1 &&
      git -C "$MAIN" commit -q --no-verify \
        -m "chore(resync): regenerate fork-config baseline after upstream merge ($date)" >/dev/null 2>&1 || true
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
      git -C "$MAIN" add $asset_paths >/dev/null 2>&1 &&
        git -C "$MAIN" commit -q --no-verify \
          -m "chore(resync): refresh generated plugin bundle artifacts after upstream merge ($date)" >/dev/null 2>&1 || true
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
    release_worktree
    ledger "LAND-LOCAL-ONLY reason=push-failed label=$label main=$landed proof=PASS (see /tmp/um-push.log)"
    echo "UPSTREAM-MERGE LANDED LOCAL-ONLY: main @ $landed but push to origin FAILED; NOT deploying. Push manually, then run scripts/cron-deploy-build.sh."
    exit 1
  fi
  release_worktree
  ledger "LAND $label behind=${BEHIND:-?} main=$landed proof=PASS"
  # Deploy DETACHED, not `exec`. exec replaced this tick with the deploy, so when the
  # build crashed+respawned the gateway the successful land was recorded as a bogus
  # error receipt (timeout / "Gateway shutting down") — firing false failure alerts,
  # driving consecutive_errors up, and leaving running_at_ms stale when the crash
  # killed the replaced process. macOS has no setsid; nohup+disown backgrounds the
  # deploy, reparented to launchd on this tick's exit, so it survives both this exit
  # and the gateway crash it triggers. main is already durable on origin; the deploy's
  # own quiesce gate now sees this job finished and proceeds.
  nohup bash "$MAIN/scripts/cron-deploy-build.sh" </dev/null >/tmp/um-deploy.log 2>&1 &
  disown 2>/dev/null || true
  ledger "DEPLOY-DISPATCHED main=$landed (detached; /tmp/um-deploy.log)"
  echo "UPSTREAM-MERGE LANDED ($label): main @ $landed, Linux proof PASS. Deploy dispatched (detached)."
  exit 0
}

land_clean() {
  local date; date="$(today)"
  local branch="upstream-auto-merge/$date"
  fresh_worktree
  # The pre-merge tip is the proof baseline by construction; resolving `main` later
  # would pick up anything that landed while huey was busy and fail the ancestry check.
  local baseline_sha; baseline_sha="$(git -C "$WORKTREE" rev-parse HEAD)"
  STAGE_OURS_REF="$baseline_sha"
  [ -n "$BASELINE_REF_OVERRIDE" ] || STAGE_BASELINE_REF="$baseline_sha"
  # Real merge; residual is 0 (measured), so this completes without conflicts.
  # Same rerere scoping as stage_init: this path is only reached when the shadow
  # measurement said zero conflicts, so a rerere replay firing here would mean it
  # silently auto-resolved a conflict the measurement missed.
  if ! git -C "$WORKTREE" -c rerere.enabled=false \
    merge --no-ff --no-edit "$UPSTREAM_REF" >/tmp/um-merge.log 2>&1; then
    log "clean merge unexpectedly conflicted — deferring to resolution path"
    git -C "$WORKTREE" merge --abort 2>/dev/null || true
    release_worktree
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

  local pre pf_rc
  pre="$(preflight "$WORKTREE")"; pf_rc=$?
  if [ "$pf_rc" = 3 ]; then
    log "local preflight could not run (dependency install) — deferring, main untouched"
    release_worktree
    ledger "DEFER reason=preflight-deps behind=$BEHIND merge=$merge_sha"
    echo "UPSTREAM-MERGE DEFER: clean merge unjudged — local dependency install failed; main untouched."
    printf '%s\n' "$pre"
    exit 3
  fi
  if [ "$pf_rc" != 0 ]; then
    log "clean merge failed local preflight — NOT shipping to huey"
    release_worktree
    ledger "NO-LAND reason=preflight-failed behind=$BEHIND merge=$merge_sha"
    echo "UPSTREAM-MERGE NO-LAND: clean merge failed local preflight; main untouched."
    printf '%s\n' "$pre"
    exit 1
  fi
  printf '%s\n' "$pre"

  log "clean merge $merge_sha (branch $branch); proving on huey (node24)…"
  local proof rc
  proof="$(remote_proof "$branch")"; rc=$?
  if [ "$rc" = 3 ]; then
    log "proof UNAVAILABLE — deferring, main untouched"
    release_worktree
    ledger "DEFER reason=proof-unavailable behind=$BEHIND merge=$merge_sha"
    echo "UPSTREAM-MERGE DEFER: clean merge ready but Linux proof unavailable; main untouched."
    exit 3
  fi
  if [ "$rc" != 0 ]; then
    log "proof FAILED — NOT landing"
    release_worktree
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
  # stage-init is reachable without `route`, so freeze here too rather than trusting
  # a measurement that may have run hours ago against a different upstream tip.
  git -C "$MAIN" fetch upstream -q 2>/dev/null || log "fetch upstream failed (using cached)"
  freeze_upstream_ref
  fresh_worktree
  git -C "$WORKTREE" checkout -B "$branch" >/dev/null 2>&1
  # The pre-merge tip: the branch's baseline by construction, and the value the huey
  # proof must diff against no matter what lands on main while resolution is open.
  local baseline_sha; baseline_sha="$(git -C "$WORKTREE" rev-parse HEAD)"
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
  STAGE_OURS_REF="$baseline_sha"
  write_stage_pins "$branch" "$UPSTREAM_REF" "$baseline_sha"
  prune_stage_pins
  echo "STAGE-READY worktree=$WORKTREE branch=$branch conflicts=$conflicts (raw=$raw, ui-policy resolved $((raw - conflicts)), dropped $ui_dropped upstream-only ui files)"
  echo "STAGE-PINS upstream=$UPSTREAM_REF baseline=$baseline_sha (frozen; later gates and the huey proof read these, not the live refs)"
  echo "--- conflict files (resolve in $WORKTREE, then commit, then run: finish-land / stage-finish) ---"
  git -C "$WORKTREE" status --porcelain | grep -E '^(DD|AU|UD|UA|DU|AA|UU)' || true
  # Hunks where taking either side is wrong. Runs here because it is the only
  # window where both sides are still visible in the file.
  node "$MAIN/scripts/check-upstream-merge-delta.mjs" --repo "$WORKTREE" --conflicts 2>&1 |
    grep -vE '^COUNT-DISAGREEMENT-SCAN 0 ' || true
  echo "--- resolution rules (each cost a full cycle on 2026-08-03) ---"
  echo "  * three-way merges take ours from $STAGE_OURS_REF:<path>, never HEAD: for an"
  echo "    ordinary (non merge=ours) file HEAD is ALREADY the lossy merge result, so the"
  echo "    apply reports clean and restores nothing."
  echo "  * never 'git apply -3' to re-apply a fork delta; it reports success and changes"
  echo "    nothing. Use 'git merge-file -L ours -L base -L upstream'."
  echo "  * after every re-apply, grep back a known fork marker. An apply that silently"
  echo "    no-ops is indistinguishable from one that worked until tsgo runs."
  echo "  * measure tsgo BEFORE and after each batch. Unattributed fixes hide which"
  echo "    change helped, and rebase files in provider-before-consumer order."
  echo "--- classified work queue (read-only planner; ui/ resolved by ownership, omitted) ---"
  report_resync_ledger "$baseline_sha"
  echo "--- merge=ours files upstream changed (rebase these onto upstream, re-apply the fork delta) ---"
  report_merge_ours_drift "$WORKTREE" "$base"
  # Ranked view of the same set: the export-surface files are the ones that break
  # an adopted consumer, and they are invisible in an unranked 24-line list.
  report_merge_ours_priority "$WORKTREE" "$base"
  echo "--- upstream-new files absent from the merge (tsgo is blind to these) ---"
  local dropped_up; dropped_up="$(report_dropped_upstream_files "$WORKTREE" "$base")"
  printf '%s\n' "$dropped_up"
  echo "--- merge base for fork-delta extraction: $base ---"
  ledger "STAGE-INIT branch=$branch upstream=$UPSTREAM_REF baseline=$baseline_sha conflicts=$conflicts raw=$raw ui-dropped=$ui_dropped $(printf '%s' "$dropped_up" | sed -n 's/^DROPPED-UPSTREAM-COUNT \([0-9]*\).*/dropped-upstream=\1/p')"
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
  # Cheaper than protocol-gen and names the owning files, so it runs first; it also
  # covers the protected files protocol-gen never imports. Base off the pinned
  # baseline, not live `main`: once `main` contains the pinned upstream (the clean
  # auto-land path does exactly that overnight) `merge-base main $UPSTREAM_REF`
  # collapses to $UPSTREAM_REF itself, the drift diff becomes `X..X` = empty, and the
  # gate passes without inspecting a single file.
  local pf_base; pf_base="$(git -C "$MAIN" merge-base "$STAGE_OURS_REF" "$UPSTREAM_REF" 2>/dev/null)"
  # Once main already contains the pinned upstream (the clean auto-land does this
  # overnight), merge-base collapses to $UPSTREAM_REF, the drift diff becomes X..X,
  # and the gate returns 0 having inspected zero files. Refuse rather than pass:
  # a silently skipped gate is indistinguishable from a clean one.
  if [ -n "$pf_base" ] && [ "$pf_base" = "$(git -C "$MAIN" rev-parse "$UPSTREAM_REF" 2>/dev/null)" ]; then
    echo "PREFLIGHT=FAIL reason=degenerate-drift-base ours=$STAGE_OURS_REF upstream=$UPSTREAM_REF"
    echo "  the merge=ours export gate cannot run: its base collapsed onto upstream, so it"
    echo "  would inspect zero files. Re-stage so the baseline predates this upstream tip."
    return 1
  fi
  check_merge_ours_export_drift "$wt" "$pf_base" || return 1
  # Everything from here executes code from the worktree, so it needs node_modules.
  # This sits BELOW the two pure-git gates on purpose: a merge committed with
  # conflict markers in pnpm-lock.yaml used to kill the install first and get
  # reported as a dependency problem, hiding the marker the next gate names in
  # seconds — and it spent a multi-minute install to do it.
  # rc 3 = DEFER, not FAIL. The Mac's inability to install is the documented premise
  # of the whole huey harness (see remote-proof.sh), so a local install failure is
  # evidence about this machine, not a verdict on the merge. Reporting it as
  # NO-LAND blamed the candidate and buried a green merge; deferring costs a cycle
  # and says which it was.
  if ! ensure_worktree_deps "$wt"; then
    # pnpm names lockfile/manifest disagreement explicitly. That state is PRODUCED BY
    # THE MERGE (pnpm-lock.yaml is deliberately unprotected), so it is a candidate
    # defect and must fail, not defer — deferring it re-merges the same tip every
    # night and main stops advancing with nothing in the ledger saying why.
    if grep -qE "ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE_CONFIG_MISMATCH|specifiers in the lockfile don.t match|ERR_PNPM_NO_LOCKFILE" /tmp/um-worktree-install.log 2>/dev/null; then
      echo "PREFLIGHT=FAIL reason=merged-lockfile-inconsistent"
      echo "  the merged pnpm-lock.yaml does not match the merged manifests; regenerate it in the worktree:"
      echo "    (cd $wt && pnpm install --no-frozen-lockfile) && git -C $wt add pnpm-lock.yaml"
      grep -E "ERR_PNPM|specifiers in the lockfile|mismatched|were removed|were added" /tmp/um-worktree-install.log 2>/dev/null | head -8
      return 1
    fi
    echo "PREFLIGHT=DEFER reason=worktree-deps"
    echo "  local dependency install failed; the merge is unjudged. See /tmp/um-worktree-install.log"
    return 3
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
  # Everything downstream (preflight's export gate, both drift reports, the huey
  # baseline) must describe the tree this branch was staged against, not whatever
  # upstream/main and main happen to point at now.
  load_stage_pins "$branch"
  # Linked worktrees share refs, so $MAIN already sees $branch at the resolved merge HEAD.
  STAGED_BRANCH="$branch"
}

# Prove $STAGED_BRANCH on huey (node24). Non-green exits with the proof rc; main untouched.
prove_staged() {
  # Local gate first — a failure here costs seconds, the huey cycle costs ~10 min.
  local pre pf_rc
  pre="$(preflight "$WORKTREE")"; pf_rc=$?
  if [ "$pf_rc" = 3 ]; then
    # Local tooling problem, not a verdict on the branch: keep it resumable and say so.
    ledger "STAGE-PREFLIGHT branch=$STAGED_BRANCH result=DEFER"
    echo "STAGE deferred — local preflight could not run (dependency install). Branch kept, main untouched."
    printf '%s\n' "$pre"
    exit 3
  fi
  if [ "$pf_rc" != 0 ]; then
    ledger "STAGE-PREFLIGHT branch=$STAGED_BRANCH result=FAIL"
    echo "STAGE preflight failed — not shipping to huey. Fix in $WORKTREE, re-commit, re-run."
    printf '%s\n' "$pre"
    exit 1
  fi
  printf '%s\n' "$pre"
  log "proving $STAGED_BRANCH on huey (node24)…"
  local proof rc result
  proof="$(remote_proof "$STAGED_BRANCH")"; rc=$?
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
  release_worktree
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
# The assignments prefix an external command, so they are unambiguously exported —
# a `VAR=x remote_proof ...` prefix on the FUNCTION was not, which is how a
# hardcoded `BASELINE_REF=main` here silently swallowed every caller's override.
remote_proof() {
  BASELINE_REF="$STAGE_BASELINE_REF" REMOTE_NODE_BIN="$REMOTE_NODE_BIN" \
    bash "$MAIN/scripts/remote-proof.sh" "$1"
}

# --- dispatch ----------------------------------------------------------------
# Sourcing this file loads the functions without running anything, so the merge
# =ours loss reporting can be tested against real git fixtures. Executed normally
# BASH_SOURCE[0] == $0 and the dispatch runs as before; note that a bare `source`
# with no args would otherwise default to `route`, which mutates and deploys.
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
  return 0
fi

cmd="${1:-route}"

# Singleton for huey-proof paths. A tick's proof cycle (baseline+candidate on huey)
# runs ~40-50min, longer than the hourly cadence, so the scheduler can launch a fresh
# invocation while the previous one is still proving. Concurrent runs then collide on
# huey's PROOF_DIR lock (remote-proof EXIT=97) and burn the cycle. Skip this tick when
# a previous huey-using invocation still holds the lock; reclaim only when the recorded
# holder pid is dead. measure/stage-init are local-only and never take the lock.
case "$cmd" in
  route | finish-land | stage-finish)
    UM_LOCK_DIR="/tmp/openclaw-upstream-merge.lock.d"
    if ! mkdir "$UM_LOCK_DIR" 2>/dev/null; then
      um_holder="$(cat "$UM_LOCK_DIR/pid" 2>/dev/null || true)"
      if [ -n "$um_holder" ] && kill -0 "$um_holder" 2>/dev/null; then
        echo "UPSTREAM-MERGE SKIP: invocation pid=$um_holder still running; deferring this $cmd tick."
        exit 0
      fi
      echo "UPSTREAM-MERGE: reclaiming stale lock (holder pid=${um_holder:-none} not alive)"
      rm -rf "$UM_LOCK_DIR"
      mkdir "$UM_LOCK_DIR" 2>/dev/null || {
        echo "UPSTREAM-MERGE SKIP: lock race; deferring this $cmd tick."
        exit 0
      }
    fi
    printf '%s\n' "$$" >"$UM_LOCK_DIR/pid"
    trap 'rm -rf "$UM_LOCK_DIR"' EXIT
    ;;
esac
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
