#!/usr/bin/env bash
#
# Upstream-sync readiness probe (Phase 4 self-monitoring).
#
# Runs the SHADOW merge engine (real merge in a throwaway worktree, measured and
# aborted — never lands), appends a dated metrics line to a workspace trend log,
# and prints a one-line summary for cron delivery. The `residual` count is the
# autonomy gauge: it should trend DOWN as the supervised resync seeds rerere and
# fork features are re-homed; when it reaches ~0 an autonomous merge could land
# autonomously. Read-only: this never commits, builds, or deploys.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${UPSTREAM_READINESS_LOG:-$HOME/.openclaw/workspace/memory/reports/upstream-readiness.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

stamp="$(date -u +%Y-%m-%dT%H:%MZ)"

json="$(node "$ROOT/scripts/upstream-merge-engine.mjs" 2>/dev/null)" || {
  echo "$stamp probe=FAILED" >>"$LOG" 2>/dev/null || true
  echo "upstream shadow readiness $stamp — probe FAILED (engine error)"
  exit 1
}

metrics="$(printf '%s' "$json" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
process.stdout.write(
  `behind=${r.behind} raw=${r.rawConflicts} auto=${r.autoResolved} ` +
  `residual=${r.residualConflicts} ready=${r.autonomousMergeReady}`,
);
')" || metrics="parse=FAILED"

echo "$stamp $metrics" >>"$LOG" 2>/dev/null || true
echo "📉 upstream shadow readiness $stamp — $metrics"
