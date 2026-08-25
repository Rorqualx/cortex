#!/usr/bin/env bash
#
# Post-deploy gateway health check + bounded auto-recovery for the cron deploy pipeline.
#
# The deploy build crashes the gateway; launchd relaunches it on the new dist. This
# check confirms the relaunched gateway is ACTUALLY healthy and, when it is not, tries a
# bounded self-heal before giving up. Run DETACHED right before the deploy build so it
# OUTLIVES the crash, waits for the relaunch, and records the result:
#
#   nohup bash scripts/cron-deploy-healthcheck.sh >/dev/null 2>&1 &
#   ... run the deploy build ...
#
# Two failure modes are checked (an earlier version only did the first, so the
# 2026-08-24 outage — gateway up but telegram failed to register — read as HEALTHY):
#   1. Gateway RPC never comes back (crash-loop, e.g. exit-78 missing plugin manifest).
#   2. Gateway RPC is up but a CONFIGURED channel/plugin failed to register/load
#      (silent-failure: dashboard works, telegram is dead).
#
# On UNHEALTHY, auto-recovery (CRON_HEALTHCHECK_RECOVER=1, the default) runs a bounded
# ladder — restore dropped plugin manifests + bounce, then (if still degraded) sync deps
# + one clean rebuild — mirroring the manual repair the outage required. Single-flight so
# two overlapping deploys cannot recover at once. Set CRON_HEALTHCHECK_RECOVER=0 for
# detect-and-alert-only.
#
# Writes HEALTHY / RECOVERED / UNHEALTHY to memory/reports/deploy-health-YYYY-MM-DD.md
# (the 08:00 briefing reads it). Exit 0 healthy or recovered, 1 unhealthy.
#
# Env (testing): CRON_HEALTHCHECK_TIMEOUT, CRON_HEALTHCHECK_INTERVAL,
#   CRON_HEALTHCHECK_URL, CRON_HEALTHCHECK_REPORT, CRON_HEALTHCHECK_NO_NOTIFY,
#   CRON_HEALTHCHECK_RECOVER, CRON_HEALTHCHECK_RUNTIME_LOG_DIR.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/deploy-build-core.sh
source "$ROOT/scripts/lib/deploy-build-core.sh"
# shellcheck source=scripts/lib/deploy-release-swap.sh
source "$ROOT/scripts/lib/deploy-release-swap.sh"

TIMEOUT="${CRON_HEALTHCHECK_TIMEOUT:-240}"
INTERVAL="${CRON_HEALTHCHECK_INTERVAL:-10}"
REPORT="${CRON_HEALTHCHECK_REPORT:-$ROOT/memory/reports/deploy-health-$(date +%F).md}"
RUNTIME_LOG_DIR="${CRON_HEALTHCHECK_RUNTIME_LOG_DIR:-/tmp/openclaw}"
RECOVER="${CRON_HEALTHCHECK_RECOVER:-1}"
URL_ARG=()
[ -n "${CRON_HEALTHCHECK_URL:-}" ] && URL_ARG=(--url "$CRON_HEALTHCHECK_URL")
mkdir -p "$(dirname "$REPORT")" 2>/dev/null || true

probe="$(mktemp)"
trap 'rm -f "$probe"' EXIT

log() { echo "[deploy-healthcheck] $*"; }
report() { printf '## Deploy health %s\n%s\n\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$1" >>"$REPORT"; }
alert() {
  [ -n "${CRON_HEALTHCHECK_NO_NOTIFY:-}" ] && return 0
  command -v osascript >/dev/null 2>&1 || return 0
  # Strip quotes/backslashes/newlines: the message includes log-derived text that would
  # otherwise break out of the osascript string literal.
  local msg
  msg="$(printf '%s' "$1" | tr -d '"\\' | tr '\n' ' ')"
  osascript -e "display notification \"$msg\" with title \"OpenClaw cron\"" >/dev/null 2>&1 || true
}

rpc_up() { node "$ROOT/openclaw.mjs" gateway status --require-rpc --json "${URL_ARG[@]+"${URL_ARG[@]}"}" >"$probe" 2>/dev/null; }

# Runtime-log position tracking so a plugin-failure scan sees ONLY the boot after the
# most recent snapshot — the daily log accumulates every boot, and stale earlier-boot
# failures must not read as "still degraded" after a recovery bounce.
SCAN_LOG=""
SCAN_OFF=0
newest_rlog() { ls -t "$RUNTIME_LOG_DIR"/openclaw-*.log 2>/dev/null | head -1; }
snapshot_log_pos() {
  SCAN_LOG="$(newest_rlog)"
  SCAN_OFF=0
  [ -n "$SCAN_LOG" ] && SCAN_OFF="$(wc -c <"$SCAN_LOG" 2>/dev/null || echo 0)"
}
# Echo the current boot's failed-plugin descriptor ("(load: ...; register: ...)") if the
# gateway logged one, else nothing. Scoped to bytes written since the last snapshot; if
# the log rotated (new file) the whole new file is the current boot.
plugin_failures() {
  local rlog slice
  rlog="$(newest_rlog)"
  [ -n "$rlog" ] || return 0
  if [ "$rlog" = "$SCAN_LOG" ]; then
    slice="$(tail -c "+$((SCAN_OFF + 1))" "$rlog" 2>/dev/null)"
  else
    slice="$(cat "$rlog" 2>/dev/null)"
  fi
  printf '%s' "$slice" | grep -oE 'plugin\(s\) failed to initialize \([^)]*\)' | tail -1
}

probe_version() {
  python3 -c "import json,sys
raw=open('$probe').read(); i=raw.find('{')
print(json.loads(raw[i:]).get('version','') if i>=0 else '')" 2>/dev/null || true
}

bounce_gateway() { launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true; }
gateway_pid() { launchctl list 2>/dev/null | awk '$3=="ai.openclaw.gateway"{print $1}'; }

# Wait for the in-parallel deploy build to start (it launches just after we are
# dispatched) and then finish, so dist is stable and the pre-deploy gateway is dead
# before we assess. If the build never appears within the grace window, proceed.
wait_build_done() {
  # In atomic-swap mode the build finishes BEFORE we are dispatched (only the promote
  # bounce follows), so there is no build to wait for — the deploy sets this to skip it.
  [ -n "${CRON_HEALTHCHECK_SKIP_BUILD_WAIT:-}" ] && return 0
  local grace=$(( $(date +%s) + 30 ))
  while ! pgrep -f 'build-all\.mts' >/dev/null 2>&1 && [ "$(date +%s)" -lt "$grace" ]; do sleep 2; done
  local dl=$(( $(date +%s) + TIMEOUT ))
  while pgrep -f 'build-all\.mts' >/dev/null 2>&1 && [ "$(date +%s)" -lt "$dl" ]; do sleep "$INTERVAL"; done
}

# Wait until a gateway whose pid differs from $1 answers RPC — i.e. the post-crash /
# post-bounce boot, never the still-up old instance. Returns 0 when that boot is up, 1 on
# timeout (crash-loop: pid keeps changing but RPC never answers).
wait_for_boot() {
  local old="$1" dl=$(( $(date +%s) + TIMEOUT )) cur
  while [ "$(date +%s)" -lt "$dl" ]; do
    cur="$(gateway_pid)"
    [ -n "$cur" ] && [ "$cur" != "$old" ] && rpc_up && return 0
    sleep "$INTERVAL"
  done
  return 1
}

# --- assess the post-deploy boot -------------------------------------------
# The deploy build runs in parallel (we are dispatched just before it) and crashes the
# still-up OLD gateway only once it rewrites dist. Assessing immediately would probe that
# pre-deploy gateway and read HEALTHY before the deploy boot ever happens. So first wait
# for the build to finish (dist stable, old instance dead), then for a NEW gateway pid to
# answer RPC — only then is the boot we probe the post-deploy one. Snapshot before all
# that so the plugin-failure scan covers the new boot; note the "N plugin(s) failed to
# initialize" line is only ever emitted by a boot that reaches plugin init (a complete
# dist), never by the mid-build partial-dist crashes, so those do not pollute the scan.
snapshot_log_pos
old_pid="$(gateway_pid)"
wait_build_done
wait_for_boot "$old_pid" || true
rpc=1
rpc_up && rpc=0
fails="$(plugin_failures)"

if [ "$rpc" = 0 ] && [ -z "$fails" ]; then
  ver="$(probe_version)"
  report "HEALTHY — gateway running, RPC ok, all configured plugins registered${ver:+ (version $ver)}"
  log "HEALTHCHECK-PASS: healthy${ver:+ (version $ver)}"
  exit 0
fi

problem=""
[ "$rpc" != 0 ] && problem="gateway RPC down for ${TIMEOUT}s"
[ -n "$fails" ] && problem="${problem:+$problem; }plugin init failures $fails"
log "UNHEALTHY: $problem"

if [ "$RECOVER" != 1 ]; then
  report "UNHEALTHY — $problem. Auto-recovery disabled. Investigate immediately (the deploy may have left a broken dist)."
  alert "Deploy left the gateway UNHEALTHY ($problem)"
  echo "HEALTHCHECK-FAIL: $problem"
  exit 1
fi

# --- bounded auto-recovery (single-flight) ---------------------------------
LOCK="/tmp/openclaw-deploy-selfheal.lock.d"
if ! mkdir "$LOCK" 2>/dev/null; then
  log "another deploy self-heal is already in progress — not starting a second"
  report "UNHEALTHY — $problem. Another auto-recovery is already in progress; deferring to it."
  exit 1
fi
trap 'rm -f "$probe"; rm -rf "$LOCK"' EXIT

method=""

if deploy_is_migrated "$ROOT"; then
  # Step 1 — instant rollback to the previous release: the just-promoted one boots bad,
  # so revert the symlink to the last-good release (no rebuild). Safest, fastest recovery.
  snapshot_log_pos
  pre_pid="$(gateway_pid)"
  if rolled="$(rollback_release "$ROOT" 2>/dev/null)"; then
    log "recovery step 1 (migrated): rolled back to $(basename "$rolled"); bouncing"
    bounce_gateway
    wait_for_boot "$pre_pid" || true
    rpc_up && [ -z "$(plugin_failures)" ] && method="rollback to $(basename "$rolled")"
  else
    log "recovery step 1 (migrated): no previous release to roll back to"
  fi
  # Step 2 — still bad (or nothing to roll back to): sync deps, rebuild, promote the fresh
  # build. promote refuses an incomplete dist, so a broken rebuild never becomes live.
  if [ -z "$method" ]; then
    log "recovery step 2 (migrated): syncing deps + clean rebuild + promote"
    (cd "$ROOT" && CI=1 npm_config_verify_deps_before_run=false pnpm install) >/tmp/deploy-selfheal-install.log 2>&1 ||
      log "pnpm install failed (see /tmp/deploy-selfheal-install.log) — rebuilding against current deps anyway"
    build_dist_and_repair "$ROOT" >/tmp/deploy-selfheal-build.log 2>&1 || true
    snapshot_log_pos
    pre_pid="$(gateway_pid)"
    if new_rel="$(promote_release "$ROOT" 2>/tmp/deploy-selfheal-promote.log)"; then
      bounce_gateway
      wait_for_boot "$pre_pid" || true
      rpc_up && [ -z "$(plugin_failures)" ] && method="deps+rebuild ($(basename "$new_rel"))"
    else
      log "recovery step 2 (migrated): promote refused (see /tmp/deploy-selfheal-promote.log)"
    fi
  fi
else
  # LEGACY in-place recovery.
  # Step 1 — restore dropped plugin manifests (the exit-78 crash-loop cause) + bounce.
  snapshot_log_pos
  restored="$(restore_plugin_manifests "$ROOT")"
  log "recovery step 1 (legacy): restored $restored missing plugin manifest(s); bouncing gateway"
  pre_pid="$(gateway_pid)"
  bounce_gateway
  wait_for_boot "$pre_pid" || true
  rpc_up && [ -z "$(plugin_failures)" ] && method="manifest-restore (restored $restored)"
  # Step 2 — sync deps + one clean in-place rebuild + bounce.
  if [ -z "$method" ]; then
    log "recovery step 2 (legacy): manifest-restore insufficient — syncing deps + clean rebuild"
    (cd "$ROOT" && CI=1 npm_config_verify_deps_before_run=false pnpm install) >/tmp/deploy-selfheal-install.log 2>&1 ||
      log "pnpm install failed (see /tmp/deploy-selfheal-install.log) — rebuilding against current deps anyway"
    snapshot_log_pos
    pre_pid="$(gateway_pid)"
    build_dist_and_repair "$ROOT" >/tmp/deploy-selfheal-build.log 2>&1 || true
    bounce_gateway
    wait_for_boot "$pre_pid" || true
    rpc_up && [ -z "$(plugin_failures)" ] && method="deps+rebuild"
  fi
fi

if [ -n "$method" ]; then
  ver="$(probe_version)"
  report "RECOVERED via $method — gateway healthy after auto-recovery (deploy had left it: $problem)${ver:+ (version $ver)}."
  alert "Deploy self-healed the gateway ($method)"
  log "HEALTHCHECK-RECOVERED: $method"
  exit 0
fi

fails2="$(plugin_failures)"
report "UNHEALTHY-UNRECOVERABLE — auto-recovery (manifest-restore, then deps+rebuild) did not heal it. Was: $problem.${fails2:+ Still: $fails2.} Investigate immediately (see /tmp/deploy-selfheal-*.log)."
alert "Deploy UNHEALTHY — auto-recovery FAILED, manual fix needed"
log "HEALTHCHECK-FAIL-UNRECOVERABLE: $problem${fails2:+ / still $fails2}"
exit 1
