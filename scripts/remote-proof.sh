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
# Env: REMOTE_HOST (joe@192.168.50.185) · REMOTE_NODE_BIN (/home/joe/node24/bin)
#      PROOF_DIR (~/openclaw-proof) · FORK_URL · PROOF_TIMEOUT (5400) · POLL (25)

set -uo pipefail

BRANCH="${1:-}"
[ -z "$BRANCH" ] && { echo "usage: remote-proof.sh <branch>" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

REMOTE_HOST="${REMOTE_HOST:-joe@192.168.50.185}"
# node24, not huey's node22 (22.19.0): the repo preinstall guard requires
# node>=22.22.3, so a node22 proof dies in `pnpm install` before any lane runs.
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-/home/joe/node24/bin}"
PROOF_DIR="${PROOF_DIR:-\$HOME/openclaw-proof}"
FORK_URL="${FORK_URL:-https://github.com/Rorqualx/cortex.git}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/openclaw/openclaw.git}"
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=8}"
PROOF_TIMEOUT="${PROOF_TIMEOUT:-5400}"
POLL="${POLL:-25}"
LANES="tsgo:core tsgo:extensions tsgo:core:test tsgo:extensions:test tsgo:test:src tsgo:test:ui tsgo:test:packages"

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
PROOF_DIR=$PROOF_DIR
LANES="$LANES"
BASELINE_REF=$BASELINE_REF

# Failing test files only. Match vitest's per-file summary line
# "<path>.test.ts (N tests | M failed)" after stripping ANSI SGR codes; a bare
# grep for "failed" false-positives on stderr log lines that merely contain the
# word (e.g. a test that logs "...failed delivery"), spuriously flagging a passing
# upstream-only file as a regression.
fail_files() { sed -E "s/\x1b\[[0-9;]*[a-zA-Z]//g" "\$1" 2>/dev/null | grep -oE "[A-Za-z0-9_./-]+\.(test|e2e\.test)\.ts \([0-9]+ tests?[^)]*[0-9]+ failed" | grep -oE "[A-Za-z0-9_./-]+\.(test|e2e\.test)\.ts" | sort -u; }

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
# PARTIAL tsgo.txt that the bare `-f` check happily reused — the missing test lanes
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
  for lane in \$LANES; do
    c=\$(corepack pnpm run \$lane 2>&1 | grep -cE "error TS"); echo "\$lane \$c" >> "\$BDIR/tsgo.txt.tmp"
    rm -rf .artifacts/tsgo-cache
  done
  corepack pnpm test:fast >/tmp/rp-base-test.log 2>&1 || true
  fail_files /tmp/rp-base-test.log > "\$BDIR/testfail.txt"
  # Atomic publish: tsgo.txt appears only after every lane + test:fast finished, so a
  # killed recompute cannot leave a partial-but-present cache.
  mv "\$BDIR/tsgo.txt.tmp" "\$BDIR/tsgo.txt"
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
BUILD_EXIT=0
nice -n 19 corepack pnpm build >/tmp/rp-build.log 2>&1 || BUILD_EXIT=\$?
echo "BUILD_EXIT=\$BUILD_EXIT"

# tsgo net-new diff
TSGO_REGRESS=0
for lane in \$LANES; do
  bc=\$(grep -E "^\$lane " "\$BDIR/tsgo.txt" | awk '{print \$2}'); bc=\${bc:-0}
  # Candidate lanes run right after \`pnpm build\`; its emitted dist/tsbuildinfo can
  # inflate the FIRST incremental typecheck with transient errors a clean re-run does
  # not reproduce (2026-08-12: phantom :test counts false-failed a clean merge, wedging
  # the auto-land gate). Start each lane from a clean cache; confirm any apparent
  # regression with one more clean run before trusting it — a real type error repeats,
  # transient inflation does not, so only the disagreeing lane pays the re-run.
  rm -rf .artifacts/tsgo-cache
  cc=\$(corepack pnpm run \$lane 2>&1 | grep -cE "error TS")
  if [ "\$cc" -gt "\$bc" ]; then
    rm -rf .artifacts/tsgo-cache
    cc=\$(corepack pnpm run \$lane 2>&1 | grep -cE "error TS")
  fi
  echo "TSGO \$lane base=\$bc cand=\$cc"
  [ "\$cc" -gt "\$bc" ] && TSGO_REGRESS=1
done
rm -rf .artifacts/tsgo-cache

# behavior net-new failing-file diff
corepack pnpm test:fast >/tmp/rp-test.log 2>&1 || true
fail_files /tmp/rp-test.log > /tmp/rp-cand-testfail.txt
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
