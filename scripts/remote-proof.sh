#!/usr/bin/env bash
# Prove a branch on native Linux (CI truth) over plain ssh/scp — no MCP.
#
# The Mac cannot `pnpm build` (node-llama-cpp native postinstall fails under
# x86_64-Rosetta), so the autonomous cron offloads build + 7 tsgo lanes +
# behavior suite to huey (Linux). Fails SAFE: if the remote is unreachable it
# returns UNAVAILABLE (3) so the caller DEFERS the land rather than shipping
# unproven code.
#
# Remote layout (huey): node 24 at $REMOTE_NODE_BIN, pnpm via corepack, a
# self-provisioned proof clone at $PROOF_DIR (cloned from GitHub origin on first
# run). The cherry branch is built on the Mac's LOCAL main which may be ahead of
# origin, so the delta bundle is based on origin/main (the point huey can fetch
# independently from GitHub) and carries both unpushed-main commits and cherries.
#
# Exit codes:  0 = PASS   1 = FAIL   2 = usage/local error   3 = UNAVAILABLE
# Usage: scripts/remote-proof.sh <branch>
#
# Env: REMOTE_HOST (joe@192.168.50.185) · REMOTE_NODE_BIN (/home/joe/node24x/bin)
#      PROOF_DIR (~/openclaw-proof) · FORK_URL · PROOF_TIMEOUT (10800) · POLL (25)

set -uo pipefail

BRANCH="${1:-}"
[ -z "$BRANCH" ] && { echo "usage: remote-proof.sh <branch>" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

REMOTE_HOST="${REMOTE_HOST:-joe@192.168.50.185}"
# node 24.20 (node24x), not huey's node22 (22.19.0) or node24 (24.15.0): upstream
# ce0e84d0732 raised the engine floor to >=24.16.0 <25 || >=26.1.0 (lossless
# SQLite reads), so a 24.15 proof now dies in write-cli-startup-metadata.
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-/home/joe/node24x/bin}"
PROOF_DIR="${PROOF_DIR:-\$HOME/openclaw-proof}"
FORK_URL="${FORK_URL:-https://github.com/Rorqualx/cortex.git}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/openclaw/openclaw.git}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=8}"
# Every land creates a new baseline sha, so the first proof after a land builds AND
# tests the baseline cold before the candidate (~110 min total on huey as of
# 2026-09-05); 5400s only ever fit the warm-cache re-prove and timed out the cold
# run while it was still green. The remote job keeps running past this poll cap.
PROOF_TIMEOUT="${PROOF_TIMEOUT:-10800}"
POLL="${POLL:-25}"
# Direct lanes are one tsgo project each; sharded lanes are views over the core test
# shards. The candidate runs the two groups in separate checkouts (see "Candidate").
LANES_DIRECT="tsgo:core tsgo:extensions tsgo:extensions:test"
LANES_SHARDED="tsgo:core:test tsgo:test:src tsgo:test:ui tsgo:test:packages"
LANES="$LANES_DIRECT $LANES_SHARDED"

log() { echo "[remote-proof] $*" >&2; }
rsh() { ssh $SSH_OPTS "$REMOTE_HOST" "$@"; }

# --- 1. Reachability (fail safe to UNAVAILABLE) ------------------------------
if ! rsh 'true' 2>/dev/null; then
  log "huey ($REMOTE_HOST) unreachable over ssh — returning UNAVAILABLE"
  echo "PROOF=UNAVAILABLE transport=none"
  exit 3
fi

# --- 2. Ship the delta as a minimal git bundle (floored at the origin merge-base) --
git fetch origin -q 2>/dev/null
# Bundle floor: the newest commit huey can already fetch from GitHub itself. Use the
# merge-base rather than origin/main, so a push to origin beneath an open branch does
# not wedge the bundle — the range then carries exactly what huey lacks either way.
BASE="$(git merge-base origin/main "$BRANCH" 2>/dev/null)"
[ -z "$BASE" ] && { log "no common history between origin/main and $BRANCH"; exit 2; }
# Baseline = the cherry branch's pre-cherry base (local main), so the diff
# isolates ONLY the cherries — not unpushed local-main drift.
BASELINE_REF="$(git rev-parse "${BASELINE_REF:-main}" 2>/dev/null)"
[ -z "$BASELINE_REF" ] && { log "cannot resolve baseline ref (main)"; exit 2; }
if ! git merge-base --is-ancestor "$BASELINE_REF" "$BRANCH" 2>/dev/null; then
  log "baseline ($BASELINE_REF) is not an ancestor of $BRANCH — the branch must be cherries on top of main"; exit 2
fi
BUNDLE="/tmp/remote-proof-$(git rev-parse --short "$BRANCH").bundle"
git bundle create "$BUNDLE" "${BASE}..${BRANCH}" 2>/tmp/rp-bundle.err || { log "bundle create failed:"; cat /tmp/rp-bundle.err >&2; exit 2; }
REMOTE_BUNDLE="/tmp/$(basename "$BUNDLE")"
scp $SSH_OPTS "$BUNDLE" "$REMOTE_HOST:$REMOTE_BUNDLE" >/dev/null 2>&1 || { log "scp bundle failed"; exit 3; }

STAMP="$(git rev-parse --short "$BRANCH")"
RLOG="/tmp/remote-proof-$STAMP.log"

# --- 3. Remote proof script (self-provisioning; detached; survives SSH death) -
# Validation is ERROR-SET DIFF vs a cached baseline (the fork ships a known-red
# tsgo baseline and environmental test failures; raw exit codes are meaningless).
# Fails only on NET-NEW tsgo errors or NET-NEW failing test files vs origin/main.
rsh "cat > /tmp/remote-proof-$STAMP.sh" <<EOF
#!/usr/bin/env bash
set -uo pipefail
export PATH=$REMOTE_NODE_BIN:\$PATH
export npm_config_verify_deps_before_run=false
# Cap vitest workers on the prover. huey has 24 cores, so the default local
# scheduler picks ~18 workers; that many concurrent test files each forking a
# child_process (e.g. the agent-schema-inspection worker) exhausts fork/IPC
# resources into a runaway child-spawn loop that spins one worker at ~250% CPU
# and hangs the whole vitest.unit lane (2026-09-18). 3 matches the CI scheduler's
# proven-safe count. Override via OPENCLAW_VITEST_MAX_WORKERS to tune/serialize.
export OPENCLAW_VITEST_MAX_WORKERS=\${OPENCLAW_VITEST_MAX_WORKERS:-3}
# huey's cgroup layout is unreadable by the tsdown heap preflight (upstream's
# readProcessMemoryCapacity returns unresolved -> sentinel 1MB -> build aborts
# before any output). huey has 16GB RAM and the build peaks near 4.7GB, so an
# explicit 8192MB ceiling is safe and bypasses the unresolvable cgroup read.
# Override by setting OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB when invoking the prover.
export OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB=\${OPENCLAW_TSDOWN_MAX_OLD_SPACE_MB:-8192}
PROOF_DIR=$PROOF_DIR
LANES="$LANES"
LANES_DIRECT="$LANES_DIRECT"
LANES_SHARDED="$LANES_SHARDED"
BASELINE_REF=$BASELINE_REF

# Failing test files only. Match vitest's per-file summary line
# "<path>.test.ts (N tests | M failed)" after stripping ANSI SGR codes; a bare
# grep for "failed" false-positives on stderr log lines that merely contain the
# word (e.g. a test that logs "...failed delivery"), spuriously flagging a passing
# upstream-only file as a regression.
fail_files() { sed -E "s/\x1b\[[0-9;]*[a-zA-Z]//g" "\$1" 2>/dev/null | grep -oE "[A-Za-z0-9_./-]+\.(test|e2e\.test)\.ts \([0-9]+ tests?[^)]*[0-9]+ failed" | grep -oE "[A-Za-z0-9_./-]+\.(test|e2e\.test)\.ts" | sort -u; }

# tsgo error SET for one lane: file + code + message, positions stripped so an edit
# elsewhere in a file does not read as a new error. The core test shard runner stops
# at its first failing shard, so the lanes it backs (core:test, test:src, test:ui,
# test:packages) reported only that shard's errors -- a count masked 162 real baseline
# errors as 5 (2026-09-30). Run every shard on its own; SHARD_CACHE holds per-config
# results for one tree so the grouped lanes reuse core:test's shard runs.
SHARD_CACHE=/tmp/rp-tsgo-shards
# A tsgo run that exits non-zero without printing any diagnostic did not typecheck
# (e.g. a stale .artifacts/dist-artifacts.lock refused every lane on 2026-09-30, which
# recorded an empty "clean" baseline). Fail loudly instead of reading it as zero errors.
tsgo_diagnostics() {
  local tmp rc; tmp=\$(mktemp); "\$@" > "\$tmp" 2>&1; rc=\$?
  if [ "\$rc" -ne 0 ] && ! grep -q "error TS" "\$tmp"; then
    echo "EXIT-DETAIL tsgo run produced no diagnostics (rc=\$rc): \$*"
    tail -3 "\$tmp" | sed 's/^/EXIT-DETAIL   /'
    rm -f "\$tmp"; return 1
  fi
  grep -E "error TS" "\$tmp" | sed -E 's/\(([0-9]+),[0-9]+\)//'; rm -f "\$tmp"
}
lane_errors() {
  local lane="\$1" group="" acc cfgs cfg out
  case "\$lane" in
    tsgo:core:test) group=all ;;
    tsgo:test:src) group=src ;;
    tsgo:test:ui) group=ui ;;
    tsgo:test:packages) group=packages ;;
  esac
  acc=\$(mktemp)
  if [ -z "\$group" ]; then
    rm -rf .artifacts/tsgo-cache
    tsgo_diagnostics corepack pnpm run "\$lane" > "\$acc" || { cat "\$acc" >&2; rm -f "\$acc"; return 1; }
  else
    mkdir -p "\$SHARD_CACHE"
    cfgs=\$(node --import tsx --input-type=module -e "const m = await import('./scripts/lib/tsgo-core-test-shards.mts'); for (const s of m.TSGO_CORE_TEST_SHARDS) if ('\$group' === 'all' || s.group === '\$group') console.log(s.config);")
    [ -n "\$cfgs" ] || { echo "EXIT-DETAIL no tsgo shards resolved for \$lane" >&2; rm -f "\$acc"; return 1; }
    for cfg in \$cfgs; do
      out="\$SHARD_CACHE/\$(basename "\$cfg")"
      if [ ! -f "\$out" ]; then
        rm -rf .artifacts/tsgo-cache
        tsgo_diagnostics node scripts/run-tsgo.mjs -p "\$cfg" > "\$out.tmp" || { cat "\$out.tmp" >&2; rm -f "\$out.tmp" "\$acc"; return 1; }
        mv "\$out.tmp" "\$out"
      fi
      cat "\$out" >> "\$acc"
    done
  fi
  sort -u "\$acc"; rm -f "\$acc"
}
# Error sets for the named lanes, computed from the tree in the cwd into \$1. The
# stderr capture is per lane so two callers can fill one directory concurrently.
lane_sets_into() {
  local dir="\$1" lane; shift
  for lane in "\$@"; do
    lane_errors "\$lane" > "\$dir/\$lane.txt" 2>"\$dir/\$lane.err" || {
      cat "\$dir/\$lane.err"; echo "EXIT=98 (tsgo lane \$lane did not typecheck)"; return 98; }
  done
}
write_lane_sets() {
  rm -rf "\$SHARD_CACHE" "\$1"; mkdir -p "\$1"
  lane_sets_into "\$1" \$LANES || exit 98
  rm -rf "\$SHARD_CACHE" .artifacts/tsgo-cache
}
# A typecheck-only checkout of the candidate beside \$PROOF_DIR. Build, tests, and every
# tsgo run take the checkout's exclusive dist-artifact lock, so one tree can only run
# them back to back; separate trees are what lets them overlap. The proof flock above
# means no live process can own a lock found here, so a leftover one is from a killed
# run and is cleared rather than failing every lane.
side_tree() {
  if [ ! -e "\$1/.git" ]; then
    git -C "\$PROOF_DIR" worktree prune
    git -C "\$PROOF_DIR" worktree add -f --detach "\$1" proof-$STAMP || return 1
  fi
  ( cd "\$1" && git checkout -f --detach proof-$STAMP -q \
      && rm -rf .artifacts/tsgo-cache .artifacts/dist-artifacts.lock \
      && CI=1 nice -n 19 corepack pnpm install --frozen-lockfile )
}

if [ ! -d "\$PROOF_DIR/.git" ]; then
  git clone $FORK_URL "\$PROOF_DIR" || { echo 'EXIT=90 (clone)'; exit 90; }
  git -C "\$PROOF_DIR" remote add upstream $UPSTREAM_URL 2>/dev/null || true
fi
cd "\$PROOF_DIR" || { echo 'EXIT=91 (cd)'; exit 91; }
# \$PROOF_DIR is a single shared checkout: the candidate checkout below rewrites the
# one working tree, so two overlapping runs make each other's build and tsgo lanes
# measure the wrong tree — and a PASS computed that way feeds an ff-only land plus a
# production deploy. A Mac-side poll timeout leaves the remote job running, so overlap
# is reachable in normal operation. Serialize; do not try to make racing safe.
exec 9>/tmp/openclaw-proof.lock 2>/dev/null || { echo 'EXIT=97 (cannot open proof lock)'; exit 97; }
flock -n 9 || { echo 'EXIT=97 (another proof run holds \$PROOF_DIR)'; exit 97; }
git fetch origin -q || { echo 'EXIT=92 (fetch origin)'; exit 92; }

# --- Baseline (pre-cherry main; cached per sha) ---
# Fetch the bundle first so BASELINE_REF's objects (unpushed local-main commits)
# are present on huey, then baseline at the pre-cherry tip to isolate the cherries.
# Proof refs are write-once scratch: nothing reads them after the checkout below, and
# each run rebuilds its own from a bundle. Without the '+' a fetch into an EXISTING
# ref is rejected as non-fast-forward the moment a branch is amended or re-staged,
# which wedges that branch behind EXIT=94 until someone deletes the ref on huey by
# hand (11 had to be cleared that way on 2026-08-01). Prune the others while here: a
# leftover 'proof/a' also blocks creating 'proof/a/b'.
# Safe to sweep unconditionally now that the lock above serializes runs: nothing else
# can hold a ref here. It must STAY unconditional — a leftover 'proof/a' blocks
# CREATING 'proof/a/b', and a landed-only guard pruned 0 of 2 refs in practice.
for stale in \$(git for-each-ref --format='%(refname)' refs/remotes/proof/ 2>/dev/null); do
  [ "\$stale" = "refs/remotes/proof/$BRANCH" ] && continue
  git update-ref -d "\$stale" 2>/dev/null || true
done
# EXIT-DETAIL prefix, not indentation: the Mac-side poller returns only lines matching
# ^(BUILD_EXIT=|TSGO |NEWFAIL |EXIT-DETAIL |EXIT=), so an indented error was filtered
# out and the operator saw a bare EXIT=94 — the ssh-and-read-the-log step this was
# added to remove.
git fetch "$REMOTE_BUNDLE" "+refs/heads/$BRANCH:refs/remotes/proof/$BRANCH" 2>/tmp/rp-fetch.err \
  || { echo 'EXIT=94 (bundle fetch)'; sed 's/^/EXIT-DETAIL /' /tmp/rp-fetch.err 2>/dev/null; exit 94; }
BDIR="\$PROOF_DIR/.proof-baseline-\$BASELINE_REF"
# The cache is valid ONLY when tsgo.txt has one line per lane AND testfail.txt exists.
# A baseline run killed mid-loop (e.g. the Mac poller was stopped) used to leave a
# PARTIAL tsgo.txt that the bare \`-f\` check happily reused — the missing test lanes
# then defaulted to 0 and false-failed every candidate against this main sha (poisoned
# 2026-08-22, breaking the hourly cron's proof). Publish tsgo.txt LAST via atomic mv so
# an interrupted recompute leaves no valid-looking cache.
LANE_COUNT=\$(echo \$LANES | wc -w)
if [ ! -f "\$BDIR/tsgo.txt" ] || [ ! -f "\$BDIR/testfail.txt" ] \
   || [ "\$(wc -l < "\$BDIR/tsgo.txt" 2>/dev/null | tr -d ' ')" != "\$LANE_COUNT" ]; then
  echo "computing baseline for \$BASELINE_REF"
  rm -rf "\$BDIR"
  git checkout -f -B baseline-tmp "\$BASELINE_REF" -q 2>/dev/null || { echo 'EXIT=93b (baseline checkout)'; exit 93; }
  rm -rf .artifacts/tsgo-cache; mkdir -p "\$BDIR"
  CI=1 nice -n 19 corepack pnpm install --frozen-lockfile >/tmp/rp-base-install.log 2>&1 || { echo 'EXIT=93 (base install)'; exit 93; }
  : > "\$BDIR/tsgo.txt.tmp"
  write_lane_sets "\$BDIR/tsgo-sets"
  for lane in \$LANES; do echo "\$lane \$(wc -l < "\$BDIR/tsgo-sets/\$lane.txt" | tr -d ' ')" >> "\$BDIR/tsgo.txt.tmp"; done
  touch "\$BDIR/tsgo-sets.done"
  corepack pnpm test:fast >/tmp/rp-base-test.log 2>&1 || true
  fail_files /tmp/rp-base-test.log > "\$BDIR/testfail.txt"
  # Atomic publish: tsgo.txt appears only after every lane + test:fast finished, so a
  # killed recompute cannot leave a partial-but-present cache.
  mv "\$BDIR/tsgo.txt.tmp" "\$BDIR/tsgo.txt"
fi

# Caches written before error sets existed hold only (masked) counts: add the sets
# without redoing the baseline test run.
if [ ! -f "\$BDIR/tsgo-sets.done" ]; then
  echo "computing baseline tsgo error sets for \$BASELINE_REF"
  git checkout -f -B baseline-tmp "\$BASELINE_REF" -q 2>/dev/null || { echo 'EXIT=93b (baseline checkout)'; exit 93; }
  CI=1 nice -n 19 corepack pnpm install --frozen-lockfile >/tmp/rp-base-install.log 2>&1 || { echo 'EXIT=93 (base install)'; exit 93; }
  write_lane_sets "\$BDIR/tsgo-sets"
  touch "\$BDIR/tsgo-sets.done"
fi

# --- Candidate (cherry branch) ---
git checkout -f -B proof-$STAMP proof/$BRANCH -q || { echo 'EXIT=95 (checkout cherry)'; exit 95; }
# The same accumulation on the local side is unbounded — 23 of these had piled up by
# 2026-08-01, each pinning a whole merge history. Prune after the checkout so the
# current branch is HEAD and \`git branch -D\` refuses to delete it.
for old in \$(git for-each-ref --format='%(refname:short)' 'refs/heads/proof-*' 2>/dev/null); do
  [ "\$old" = "proof-$STAMP" ] && continue
  git branch -qD "\$old" 2>/dev/null || true
done
rm -rf .artifacts/tsgo-cache
CI=1 nice -n 19 corepack pnpm install --frozen-lockfile >/tmp/rp-install.log 2>&1 || { echo 'EXIT=96 (install)'; exit 96; }
# The candidate's three long phases are independent, so they overlap: build then tests
# in \$PROOF_DIR, direct tsgo lanes in one side tree, sharded lanes in another (~75 min
# of typecheck used to sit serially between a 16 min build and the test run). The side
# trees are never built, like the baseline tree when its sets were taken.
TSGO_A="\$PROOF_DIR-tsgo-a"; TSGO_B="\$PROOF_DIR-tsgo-b"
: >/tmp/rp-side-install.log
for tree in "\$TSGO_A" "\$TSGO_B"; do
  side_tree "\$tree" >>/tmp/rp-side-install.log 2>&1 || { echo 'EXIT=96 (side-tree install)'; exit 96; }
done
rm -rf "\$SHARD_CACHE" /tmp/rp-cand-sets; mkdir -p /tmp/rp-cand-sets
( cd "\$TSGO_A" && lane_sets_into /tmp/rp-cand-sets \$LANES_DIRECT ) >/tmp/rp-tsgo-a.log 2>&1 &
TSGO_A_PID=\$!
( cd "\$TSGO_B" && lane_sets_into /tmp/rp-cand-sets \$LANES_SHARDED ) >/tmp/rp-tsgo-b.log 2>&1 &
TSGO_B_PID=\$!

BUILD_EXIT=0
nice -n 19 corepack pnpm build >/tmp/rp-build.log 2>&1 || BUILD_EXIT=\$?
echo "BUILD_EXIT=\$BUILD_EXIT"

# behavior net-new failing-file diff
corepack pnpm test:fast >/tmp/rp-test.log 2>&1 || true
fail_files /tmp/rp-test.log > /tmp/rp-cand-testfail.txt

TSGO_A_RC=0; wait "\$TSGO_A_PID" || TSGO_A_RC=\$?
TSGO_B_RC=0; wait "\$TSGO_B_PID" || TSGO_B_RC=\$?
if [ "\$TSGO_A_RC" != 0 ] || [ "\$TSGO_B_RC" != 0 ]; then
  grep -hE '^EXIT-DETAIL ' /tmp/rp-tsgo-a.log /tmp/rp-tsgo-b.log
  echo "EXIT=98 (\$(grep -hE '^EXIT=98' /tmp/rp-tsgo-a.log /tmp/rp-tsgo-b.log | head -1 | sed -E 's/^EXIT=98 \(//; s/\)\$//'))"; exit 98
fi

# tsgo net-new diff: an error is a regression only when the candidate's error set
# gains an entry the baseline lacks. A lane with new entries is recomputed once from a
# clean cache before it counts (transient first-run errors, 2026-08-12).
TSGO_REGRESS=0
for lane in \$LANES; do
  base_set="\$BDIR/tsgo-sets/\$lane.txt"; cand_set="/tmp/rp-cand-sets/\$lane.txt"
  new=\$(comm -13 "\$base_set" "\$cand_set" | wc -l | tr -d ' ')
  if [ "\$new" -gt 0 ]; then
    rm -rf "\$SHARD_CACHE"
    ( cd "\$TSGO_B" && lane_errors "\$lane" ) > "\$cand_set" 2>/tmp/rp-lane-err.txt || {
      cat /tmp/rp-lane-err.txt; echo "EXIT=98 (tsgo lane \$lane did not typecheck)"; exit 98; }
    rm -rf "\$SHARD_CACHE"
    new=\$(comm -13 "\$base_set" "\$cand_set" | wc -l | tr -d ' ')
  fi
  echo "TSGO \$lane base=\$(wc -l < "\$base_set" | tr -d ' ') cand=\$(wc -l < "\$cand_set" | tr -d ' ') new=\$new"
  if [ "\$new" -gt 0 ]; then
    TSGO_REGRESS=1
    comm -13 "\$base_set" "\$cand_set" | head -20 | sed 's/^/TSGO   + /'
  fi
done
rm -rf "\$SHARD_CACHE"
NEWFAIL=\$(comm -13 "\$BDIR/testfail.txt" /tmp/rp-cand-testfail.txt)
TEST_REGRESS=0
if [ -n "\$NEWFAIL" ]; then TEST_REGRESS=1; while read -r f; do [ -n "\$f" ] && echo "NEWFAIL \$f"; done <<<"\$NEWFAIL"; fi

if [ "\$BUILD_EXIT" = 0 ] && [ "\$TSGO_REGRESS" = 0 ] && [ "\$TEST_REGRESS" = 0 ]; then echo "EXIT=0"; else echo "EXIT=1"; fi
EOF

rsh "rm -f $RLOG; setsid bash /tmp/remote-proof-$STAMP.sh </dev/null >$RLOG 2>&1 & echo launched" >/dev/null 2>&1
log "remote proof launched (stamp $STAMP); polling $RLOG every ${POLL}s up to ${PROOF_TIMEOUT}s"

# --- 4. Poll the remote log for the terminal EXIT= marker --------------------
elapsed=0
while [ "$elapsed" -lt "$PROOF_TIMEOUT" ]; do
  MARK="$(rsh "grep -E '^EXIT=' $RLOG 2>/dev/null | tail -1" 2>/dev/null)"
  if [ -n "$MARK" ]; then
    TAIL="$(rsh "grep -E '^(BUILD_EXIT=|TSGO |NEWFAIL |EXIT-DETAIL |EXIT=)' $RLOG 2>/dev/null" 2>/dev/null)"
    log "remote result:"; echo "$TAIL" >&2
    CODE="${MARK#EXIT=}"; CODE="${CODE%% *}"
    # 97 = another run holds the shared proof checkout. Contention, not a red
    # candidate, so it surfaces as UNAVAILABLE and makes the caller defer.
    if [ "$CODE" = "97" ]; then echo "PROOF=UNAVAILABLE transport=huey reason=proof-lock-held"; echo "$TAIL"; exit 3; fi
    if [ "$CODE" = "0" ]; then echo "PROOF=PASS transport=huey"; echo "$TAIL"; exit 0
    else echo "PROOF=FAIL transport=huey"; echo "$TAIL"; exit 1; fi
  fi
  sleep "$POLL"; elapsed=$((elapsed + POLL))
done
log "timed out after ${PROOF_TIMEOUT}s"
echo "PROOF=FAIL transport=huey reason=timeout"
exit 1
