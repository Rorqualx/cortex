#!/usr/bin/env bash
#
# Deterministic test gate for the cron "Validate & Deploy" agent.
#
# This branch carries pre-existing test failures, so "did the suite pass" is the
# wrong question. Instead this gate runs the fast unit suite and compares the set
# of FAILING test files against a committed baseline (scripts/cron-test-baseline.txt).
# It fails only on NEW failing files — a regression introduced by today's commits —
# with no model judgment involved.
#
#   TESTGATE-PASS (exit 0) -> failures are all within the baseline
#   TESTGATE-FAIL (exit 1) -> new failing file(s) not in the baseline
#   exit 2                 -> gate could not run (no results / no baseline)
#
# Usage:
#   bash scripts/cron-test-gate.sh                 # run the gate
#   bash scripts/cron-test-gate.sh --update-baseline   # record current failures as the baseline
#
# Run from the LIVE tree post-merge: tests run from source and never touch dist,
# so this is safe to run in the live gateway tree.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BASELINE="$ROOT/scripts/cron-test-baseline.txt"
RESULTS="$(mktemp)"
trap 'rm -f "$RESULTS"' EXIT

echo "Test gate: running unit-fast suite (failures compared to baseline, not pass/fail)..."
# Exit code is ignored on purpose — pre-existing failures are expected; the JSON
# reporter gives the deterministic failing-file set we actually compare.
#
# Resource cap: this gate runs IN-PROCESS on the box hosting the live gateway.
# An unbounded vitest fan-out (up to 16 workers) spikes RAM and has crash-killed
# the gateway mid-run (cron job recorded "interrupted by gateway restart" with no
# deploy). Cap workers low and de-prioritize CPU so the live gateway survives the
# gate; the gate is latency-tolerant, the gateway is not.
CI=1 OPENCLAW_VITEST_MAX_WORKERS="${CRON_GATE_VITEST_WORKERS:-2}" \
  nice -n 19 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.unit-fast.config.ts \
  --reporter=json --outputFile="$RESULTS" >/dev/null 2>&1 || true

[ -s "$RESULTS" ] || { echo "TESTGATE-FAIL: no test results produced (runner error)"; exit 2; }

current="$(
  python3 - "$RESULTS" "$ROOT" <<'PY'
import json, os, sys
results, root = sys.argv[1], sys.argv[2].rstrip(os.sep) + os.sep
data = json.load(open(results))
fails = set()
for t in data.get("testResults", []):
    if t.get("status") == "failed":
        name = t.get("name", "")
        if name.startswith(root):
            name = name[len(root):]
        if name:
            fails.add(name)
print("\n".join(sorted(fails)))
PY
)"

if [ "${1:-}" = "--update-baseline" ]; then
  printf '%s\n' "$current" | sed '/^$/d' | sort -u > "$BASELINE"
  echo "Baseline updated: $(grep -c . "$BASELINE" 2>/dev/null || echo 0) failing file(s) recorded in ${BASELINE#"$ROOT"/}"
  exit 0
fi

[ -f "$BASELINE" ] || { echo "TESTGATE-FAIL: no baseline at ${BASELINE#"$ROOT"/}; seed it with --update-baseline"; exit 2; }

new="$(comm -23 <(printf '%s\n' "$current" | sed '/^$/d' | sort -u) <(sort -u "$BASELINE"))"
if [ -n "$new" ]; then
  echo "TESTGATE-FAIL: new test failures introduced (not in baseline):"
  printf '  %s\n' $new
  exit 1
fi
echo "TESTGATE-PASS: no new test failures (current failures within baseline of $(grep -c . "$BASELINE" 2>/dev/null || echo 0) file(s))"
exit 0
