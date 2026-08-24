#!/usr/bin/env bash
#
# Deterministic validation gate for the cron "Validate & Deploy" agent.
#
# Two phases, both without model judgment:
#
#   1. Typecheck (hard pass/fail). Vitest transpiles without typechecking, so a
#      commit can be test-green and still break `pnpm build`. This lane is clean
#      on main, so any error here is new by definition — no baseline needed.
#   2. Tests (baseline diff). This branch carries pre-existing failures, so "did
#      the suite pass" is the wrong question; only NEW failing files count,
#      compared against scripts/cron-test-baseline.txt.
#
#   TESTGATE-PASS (exit 0) -> typecheck clean and failures all within the baseline
#   TESTGATE-FAIL (exit 1) -> typecheck error, or new failing file(s)
#   exit 2                 -> gate could not run (no results / no baseline)
#
# Usage:
#   bash scripts/cron-test-gate.sh                 # run the gate
#   bash scripts/cron-test-gate.sh --update-baseline   # record current failures as the baseline
#
# Run from the LIVE tree post-merge: tests and tsgo run from source and never
# touch dist, so this is safe to run in the live gateway tree.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BASELINE="$ROOT/scripts/cron-test-baseline.txt"
RESULTS="$(mktemp)"
trap 'rm -f "$RESULTS"' EXIT

# ── Phase 1: typecheck ────────────────────────────────────────────────────────
# Gate the exact lane that fails `pnpm build`. On 2026-08-02 a landed commit read
# fields off a Candidate union member that lacked them; the test gate passed
# (its tests only built the one lane that had those fields), build:plugin-sdk:dts
# failed, and main stayed unbuildable for hours. Nothing rebuilds on a schedule,
# so the break only surfaced when a rebuild under the live gateway turned it into
# an outage. Skipped for --update-baseline, which must be able to record a
# baseline even from a red tree.
if [ "${1:-}" != "--update-baseline" ]; then
  echo "Validate gate: typechecking the declaration lane that gates pnpm build..."
  if ! nice -n 19 node scripts/run-tsgo.mjs -p tsconfig.plugin-sdk.dts.json --declaration true; then
    echo "TESTGATE-FAIL: typecheck failed (build:plugin-sdk:dts) — pnpm build cannot succeed at this commit"
    exit 1
  fi
  echo "Typecheck: clean"
fi

echo "Validate gate: running unit-fast suite (failures compared to baseline, not pass/fail)..."
# Exit code is ignored on purpose — pre-existing failures are expected; the JSON
# reporter gives the deterministic failing-file set we actually compare.
#
# Resource cap: this gate runs IN-PROCESS on the box hosting the live gateway.
# An unbounded vitest fan-out (up to 16 workers) spikes RAM and has crash-killed
# the gateway mid-run (cron job recorded "interrupted by gateway restart" with no
# deploy). Cap workers low and de-prioritize CPU so the live gateway survives the
# gate; the gate is latency-tolerant, the gateway is not.
#
# `dot` reporter alongside `json` is load-bearing, not cosmetic: run-vitest.mjs
# terminates a run that emits nothing for DEFAULT_VITEST_NO_OUTPUT_TIMEOUT_MS
# (120s), and the json reporter writes only its final file — silent the whole run.
# With workers capped at 2 the suite runs silently well past 120s, so a json-only
# invocation was killed before writing $RESULTS, surfacing as the "no test results
# produced (runner error)" failure below. dot emits a mark per finished file on the
# child's stdout, resetting the watchdog while keeping it able to catch a real hang.
CI=1 OPENCLAW_VITEST_MAX_WORKERS="${CRON_GATE_VITEST_WORKERS:-2}" \
  nice -n 19 node scripts/run-vitest.mjs run \
  --config test/vitest/vitest.unit-fast.config.ts \
  --reporter=dot --reporter=json --outputFile="$RESULTS" >/dev/null 2>&1 || true

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
