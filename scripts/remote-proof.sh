#!/usr/bin/env bash
# Prove a branch on native Linux (CI truth) over plain ssh/scp — no MCP.
#
# The Mac cannot `pnpm build` (node-llama-cpp native postinstall fails under
# x86_64-Rosetta), so the autonomous cron offloads build + 7 tsgo lanes +
# behavior suite to huey (Linux). Fails SAFE: if the remote is unreachable it
# returns UNAVAILABLE (3) so the caller DEFERS the land rather than shipping
# unproven code.
#
# Remote layout (huey): node 22 at $REMOTE_NODE_BIN, pnpm via corepack, a
# self-provisioned proof clone at $PROOF_DIR (cloned from GitHub origin on first
# run). The cherry branch is built on the Mac's LOCAL main which may be ahead of
# origin, so the delta bundle is based on origin/main (the point huey can fetch
# independently from GitHub) and carries both unpushed-main commits and cherries.
#
# Exit codes:  0 = PASS   1 = FAIL   2 = usage/local error   3 = UNAVAILABLE
# Usage: scripts/remote-proof.sh <branch>
#
# Env: REMOTE_HOST (joe@192.168.50.185) · REMOTE_NODE_BIN (/home/joe/node22/bin)
#      PROOF_DIR (~/openclaw-proof) · FORK_URL · PROOF_TIMEOUT (5400) · POLL (25)

set -uo pipefail

BRANCH="${1:-}"
[ -z "$BRANCH" ] && { echo "usage: remote-proof.sh <branch>" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

REMOTE_HOST="${REMOTE_HOST:-joe@192.168.50.185}"
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-/home/joe/node22/bin}"
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

# --- 2. Ship the delta as a minimal git bundle (based on origin/main) --------
git fetch origin -q 2>/dev/null
BASE="$(git rev-parse origin/main 2>/dev/null)"   # bundle floor (huey gets this from GitHub)
[ -z "$BASE" ] && { log "cannot resolve origin/main"; exit 2; }
# Baseline = the cherry branch's pre-cherry base (local main), so the diff
# isolates ONLY the cherries — not unpushed local-main drift.
BASELINE_REF="$(git rev-parse "${BASELINE_REF:-main}" 2>/dev/null)"
[ -z "$BASELINE_REF" ] && { log "cannot resolve baseline ref (main)"; exit 2; }
if ! git merge-base --is-ancestor "$BASE" "$BRANCH" 2>/dev/null; then
  log "origin/main ($BASE) is not an ancestor of $BRANCH — rebase the cherry branch on origin/main first"; exit 2
fi
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
BASE=$BASE
BASELINE_REF=$BASELINE_REF

# Failing test files only: vitest prints a per-file summary line containing
# "failed" plus the file path; passing files never say "failed".
fail_files() { grep -E "failed" "\$1" 2>/dev/null | grep -oE "[A-Za-z0-9_./-]+\.(test|e2e\.test)\.ts" | sort -u; }

if [ ! -d "\$PROOF_DIR/.git" ]; then
  git clone $FORK_URL "\$PROOF_DIR" || { echo 'EXIT=90 (clone)'; exit 90; }
  git -C "\$PROOF_DIR" remote add upstream $UPSTREAM_URL 2>/dev/null || true
fi
cd "\$PROOF_DIR" || { echo 'EXIT=91 (cd)'; exit 91; }
git fetch origin -q || { echo 'EXIT=92 (fetch origin)'; exit 92; }

# --- Baseline (pre-cherry main; cached per sha) ---
# Fetch the bundle first so BASELINE_REF's objects (unpushed local-main commits)
# are present on huey, then baseline at the pre-cherry tip to isolate the cherries.
git fetch "$REMOTE_BUNDLE" "refs/heads/$BRANCH:refs/remotes/proof/$BRANCH" 2>/tmp/rp-fetch.err || { echo 'EXIT=94 (bundle fetch)'; exit 94; }
BDIR="\$PROOF_DIR/.proof-baseline-\$BASELINE_REF"
if [ ! -f "\$BDIR/tsgo.txt" ]; then
  echo "computing baseline for \$BASELINE_REF"
  git checkout -f -B baseline-tmp "\$BASELINE_REF" -q 2>/dev/null || { echo 'EXIT=93b (baseline checkout)'; exit 93; }
  rm -rf .artifacts/tsgo-cache; mkdir -p "\$BDIR"
  CI=1 nice -n 19 corepack pnpm install --frozen-lockfile >/tmp/rp-base-install.log 2>&1 || { echo 'EXIT=93 (base install)'; exit 93; }
  : > "\$BDIR/tsgo.txt"
  for lane in \$LANES; do
    c=\$(corepack pnpm run \$lane 2>&1 | grep -cE "error TS"); echo "\$lane \$c" >> "\$BDIR/tsgo.txt"
    rm -rf .artifacts/tsgo-cache
  done
  corepack pnpm test:fast >/tmp/rp-base-test.log 2>&1 || true
  fail_files /tmp/rp-base-test.log > "\$BDIR/testfail.txt"
fi

# --- Candidate (cherry branch) ---
git checkout -f -B proof-$STAMP proof/$BRANCH -q || { echo 'EXIT=95 (checkout cherry)'; exit 95; }
rm -rf .artifacts/tsgo-cache
CI=1 nice -n 19 corepack pnpm install --frozen-lockfile >/tmp/rp-install.log 2>&1 || { echo 'EXIT=96 (install)'; exit 96; }
BUILD_EXIT=0
nice -n 19 corepack pnpm build >/tmp/rp-build.log 2>&1 || BUILD_EXIT=\$?
echo "BUILD_EXIT=\$BUILD_EXIT"

# tsgo net-new diff
TSGO_REGRESS=0
for lane in \$LANES; do
  bc=\$(grep -E "^\$lane " "\$BDIR/tsgo.txt" | awk '{print \$2}'); bc=\${bc:-0}
  cc=\$(corepack pnpm run \$lane 2>&1 | grep -cE "error TS"); rm -rf .artifacts/tsgo-cache
  echo "TSGO \$lane base=\$bc cand=\$cc"
  [ "\$cc" -gt "\$bc" ] && TSGO_REGRESS=1
done

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
    TAIL="$(rsh "grep -E '^(BUILD_EXIT=|TSGO |NEWFAIL |EXIT=)' $RLOG 2>/dev/null" 2>/dev/null)"
    log "remote result:"; echo "$TAIL" >&2
    CODE="${MARK#EXIT=}"; CODE="${CODE%% *}"
    if [ "$CODE" = "0" ]; then echo "PROOF=PASS transport=huey"; echo "$TAIL"; exit 0
    else echo "PROOF=FAIL transport=huey"; echo "$TAIL"; exit 1; fi
  fi
  sleep "$POLL"; elapsed=$((elapsed + POLL))
done
log "timed out after ${PROOF_TIMEOUT}s"
echo "PROOF=FAIL transport=huey reason=timeout"
exit 1
