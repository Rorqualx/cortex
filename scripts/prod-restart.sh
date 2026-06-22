#!/usr/bin/env bash
# Production gateway restart: kill leftovers, rebuild, relaunch gateway.
# For use with fork development and production gateway management.
#
# IMPORTANT: When called from inside the gateway, this script MUST be
# invoked with --daemon (or no flags, which auto-detects). The daemon
# mode double-forks via daemon-restart.py so the restart process
# survives the gateway being killed. Without it, pkill kills the
# restart script itself.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
step() { log "==> $1"; }

# Ensure local node binaries are discoverable
export PATH="${ROOT_DIR}/node_modules/.bin:${PATH}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

log_green() { printf "${GREEN}%s${NC}\n" "$*"; }
log_yellow() { printf "${YELLOW}%s${NC}\n" "$*"; }
log_red() { printf "${RED}%s${NC}\n" "$*"; }

for arg in "$@"; do
  case "${arg}" in
    --help|-h)
      log "Usage: $(basename "$0") [options]"
      log ""
      log "Options:"
      log "  --daemon      Detach via double-fork (survives gateway death)"
      log "  --no-build    Skip rebuild step"
      log "  --ui-only     Build only the Control UI (fast)"
      log "  --force|-f    Restart even with active sessions"
      log "  --skip-active-check  Skip active session check"
      log "  --help|-h     Show this help"
      log ""
      log "This script:"
      log "  1. Daemonizes if --daemon (or auto-detected from inside gateway)"
      log "  2. Kills all OpenClaw processes"
      log "  3. Rebuilds the project (unless --no-build)"
      log "  4. Starts the production gateway"
      log ""
      log "When called from inside a gateway session (agent restart), always"
      log "use --daemon. The script auto-detects this if OPENCLAW_SESSION_ID"
      log "or GATEWAY_PID is set."
      log ""
      log "Uses scripts/daemon-restart.py for process detachment."
      log "Log: /tmp/prod-restart.log"
      exit 0
      ;;
    --daemon)
      DAEMON=1
      ;;
    --daemonized)
      # Internal flag — already running as a daemon, skip re-fork
      DAEMONIZED=1
      ;;
    --no-build)
      NO_BUILD=1
      ;;
    --ui-only)
      UI_ONLY=1
      ;;
    --force|-f)
      FORCE=1
      ;;
    --skip-active-check)
      SKIP_ACTIVE_CHECK=1
      ;;
  esac
done

# ── Auto-detect: if we're running inside the gateway, force daemon mode ──
# The gateway sets these env vars when it spawns tool commands.
if [[ "${DAEMONIZED:-0}" -ne 1 ]]; then
  if [[ -n "${OPENCLAW_SESSION_ID:-}" || -n "${GATEWAY_PID:-}" ]]; then
    DAEMON=1
  elif [[ "${OPENCLAW_SERVICE_KIND:-}" == "gateway" ]]; then
    DAEMON=1
  elif [[ -n "${OPENCLAW_GATEWAY_SERVICE_PID:-}" ]]; then
    DAEMON=1
  fi
fi

# ── Daemon fork ────────────────────────────────────────────────────────
# If --daemon was requested, re-exec through the Python daemonizer.
# This double-forks to orphan from the gateway process tree.
if [[ "${DAEMON:-0}" -eq 1 && "${DAEMONIZED:-0}" -ne 1 ]]; then
  DAEMON_SCRIPT="${ROOT_DIR}/scripts/daemon-restart.py"
  if [[ ! -f "$DAEMON_SCRIPT" ]]; then
    fail "daemon-restart.py not found at $DAEMON_SCRIPT"
  fi
  # Pass all args except --daemon to the daemonizer
  FILTERED_ARGS=()
  for a in "$@"; do
    [[ "$a" != "--daemon" ]] && FILTERED_ARGS+=("$a")
  done
  python3 "$DAEMON_SCRIPT" ${FILTERED_ARGS[@]+"${FILTERED_ARGS[@]}"}
  log_green "Restart daemonized. Log: /tmp/prod-restart.log"
  exit 0
fi

# ── Check for active sessions ──────────────────────────────────────────
# Before killing processes, check if any sessions have active file claims.
# This prevents killing the gateway while agents are mid-write.
if [[ "${SKIP_ACTIVE_CHECK:-0}" -ne 1 && "${FORCE:-0}" -ne 1 ]]; then
  if command -v node &>/dev/null; then
    ACTIVE_CHECK=$(node -e "
      try {
        const reg = require('${ROOT_DIR}/dist/session-awareness/session-activity-registry.js');
        const guard = require('${ROOT_DIR}/dist/session-awareness/restart-guard.js');
        const result = guard.checkRestartSafety();
        if (!result.safe) {
          console.log(JSON.stringify(result));
          process.exit(1);
        }
        console.log('SAFE');
      } catch (e) {
        // Module may not exist yet (first build) — skip check
        console.log('SKIP');
      }
    " 2>/dev/null || echo 'SKIP')

    if [[ "$ACTIVE_CHECK" != "SAFE" && "$ACTIVE_CHECK" != "SKIP" ]]; then
      log_yellow "⚠️  Active sessions detected:"
      echo "$ACTIVE_CHECK" | node -e "
        let data = '';
        process.stdin.on('data', (c) => data += c);
        process.stdin.on('end', () => {
          try {
            const r = JSON.parse(data);
            console.log(r.summary);
          } catch { console.log(data); }
        });
      " 2>/dev/null || echo "$ACTIVE_CHECK"
      log_yellow ""
      log_yellow "Use --force to override, or wait for sessions to complete."
      if [[ "${CI:-}" != "true" ]]; then
        exit 1
      fi
      log_yellow "CI detected — continuing anyway."
    fi
  fi
fi

# ── Check for in-flight cron runs ──────────────────────────────────────
# Killing the gateway also kills every running cron job (research scans,
# skill-forge, the nightly upstream-merge). Refuse to restart while any cron
# job is in-flight unless forced. Reads the persisted runningAtMs marker, so it
# works here in the detached restart process (cross-process, no gateway needed).
if [[ "${SKIP_ACTIVE_CHECK:-0}" -ne 1 && "${FORCE:-0}" -ne 1 ]]; then
  if bash "${ROOT_DIR}/scripts/cron-restart-safe-wait.sh" --once; then
    :
  else
    rc=$?
    if [[ "$rc" -eq 3 ]]; then
      log_yellow "⚠️  Cron job(s) currently running (see above)."
      log_yellow "Use --force to override, or wait for the run(s) to finish."
      if [[ "${CI:-}" != "true" ]]; then
        exit 1
      fi
      log_yellow "CI detected — continuing anyway."
    fi
    # rc=2 (no db / no sqlite3) is a soft skip — nothing to block on.
  fi
fi

# ── Kill old gateway ───────────────────────────────────────────────────
# This runs INSIDE the daemonized process (or directly if called outside).
# We are already orphaned from the old gateway, so killing it won't kill us.

step "Killing all OpenClaw processes..."

# Save our own PID to avoid suicide
SELF_PID=$$

# Kill gateway processes (but not ourselves)
if [[ "$(uname)" == "Darwin" ]]; then
  # macOS: use pgrep/pkill carefully
  GATEWAY_PIDS=$(pgrep -f "node.*dist/index.js gateway" 2>/dev/null || true)
  for pid in $GATEWAY_PIDS; do
    if [[ "$pid" -ne "$SELF_PID" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Also try the generic openclaw pattern
  OPENCLAW_PIDS=$(pgrep -f "openclaw.*gateway" 2>/dev/null || true)
  for pid in $OPENCLAW_PIDS; do
    if [[ "$pid" -ne "$SELF_PID" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
fi

# Stop launchd agent if loaded, and remove the plist so the next start
# creates a fresh service definition pointing to the current repo build.
launchctl bootout gui/"$UID"/ai.openclaw.gateway 2>/dev/null || true
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist 2>/dev/null || true

# Wait for processes to die
sleep 2

# Force kill any stragglers
GATEWAY_PIDS=$(pgrep -f "node.*dist/index.js gateway" 2>/dev/null || true)
for pid in $GATEWAY_PIDS; do
  if [[ "$pid" -ne "$SELF_PID" ]]; then
    log_yellow "Force killing straggler PID $pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
done

sleep 1

# Verify
REMAINING=$(pgrep -f "node.*dist/index.js gateway" 2>/dev/null | grep -v "^${SELF_PID}$" | wc -l | tr -d '[:space:]' || echo "0")
if [[ "$REMAINING" -gt 0 ]]; then
  log_yellow "Warning: ${REMAINING} gateway processes may still be running"
  pgrep -af "node.*dist/index.js gateway" 2>/dev/null | grep -v "^${SELF_PID}" || true
else
  log_green "All gateway processes cleaned up"
fi

# ── Build ──────────────────────────────────────────────────────────────
if [[ "${NO_BUILD:-0}" -eq 1 ]]; then
  step "Skipping rebuild (--no-build specified)"
elif [[ "${UI_ONLY:-0}" -eq 1 ]]; then
  step "Building UI only..."
  cd "${ROOT_DIR}"
  if pnpm ui:build; then
    log_green "UI build completed successfully"
  else
    log_red "UI build failed!"
    exit 1
  fi
else
  step "Rebuilding project..."
  cd "${ROOT_DIR}"
  if pnpm build; then
    log_green "Build completed successfully"
  else
    log_red "Build failed!"
    exit 1
  fi
fi

# ── Verify UI assets exist after build ─────────────────────────────────
if [[ ! -f "${ROOT_DIR}/dist/control-ui/index.html" ]]; then
  step "Control UI assets missing after build; running pnpm ui:build..."
  cd "${ROOT_DIR}"
  if pnpm ui:build; then
    log_green "Control UI build completed successfully"
  else
    log_red "Control UI build failed!"
    exit 1
  fi
fi

# ── Start gateway ──────────────────────────────────────────────────────
step "Starting production gateway..."
cd "${ROOT_DIR}"

# Prefer launchd if the plist is loaded — cleaner than raw process management
if launchctl print gui/"$UID"/ai.openclaw.gateway &>/dev/null; then
  step "Launching via launchd (kickstart -k)..."
  launchctl kickstart -k gui/"$UID"/ai.openclaw.gateway
  sleep 3
  if launchctl print gui/"$UID"/ai.openclaw.gateway &>/dev/null; then
    log_green "Gateway started via launchd"
  else
    log_red "launchd kickstart failed, falling back to direct start"
    pnpm openclaw gateway start
  fi
else
  # No launchd plist loaded — install fresh service and start it
  step "Installing gateway service..."
  if pnpm openclaw gateway install && pnpm openclaw gateway start; then
    log_green "Gateway started successfully"
  else
    log_red "Failed to start gateway!"
    exit 1
  fi
fi

# Wait for gateway to initialize
sleep 3

# Show status
step "Gateway status:"
pnpm openclaw gateway status 2>/dev/null | grep -E "(Dashboard|Listening|Connectivity|Runtime)" || true

log ""
log_green "✓ Production gateway is running!"
log ""
log "UI should be accessible at:"
log "  - http://localhost:18789/"
log ""
