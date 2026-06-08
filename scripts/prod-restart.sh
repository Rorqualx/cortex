#!/usr/bin/env bash
# Production gateway restart: kill leftovers, rebuild, relaunch gateway.
# For use with fork development and production gateway management.

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
      log "  --help|-h     Show this help"
      log ""
      log "This script:"
      log "  1. Kills all OpenClaw processes"
      log "  2. Stops the gateway service"
      log "  3. Rebuilds the project (unless --no-build)"
      log "  4. Starts the production gateway"
      log ""
      log "Use --daemon when calling from inside the gateway (agent restart)."
      log "Uses scripts/daemon-restart.py for process detachment."
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
  esac
done

# If --daemon was requested, re-exec through the Python daemonizer.
# This double-forks to orphan from the gateway process tree.
if [[ "${DAEMON:-0}" -eq 1 && "${DAEMONIZED:-0}" -ne 1 ]]; then
  DAEMON_SCRIPT="${ROOT_DIR}/scripts/daemon-restart.py"
  if [[ ! -f "$DAEMON_SCRIPT" ]]; then
    fail "daemon-restart.py not found at $DAEMON_SCRIPT"
  fi
  # Pass all args except --daemon to the daemonizer
  FILTERED_ARGS=()
  FILTERED_ARGS=()
  for a in "$@"; do
    [[ "$a" != "--daemon" ]] && FILTERED_ARGS+=("$a")
  done
  python3 "$DAEMON_SCRIPT" ${FILTERED_ARGS[@]+"${FILTERED_ARGS[@]}"}
  log_green "Restart daemonized. Log: /tmp/prod-restart.log"
  exit 0
fi

if [[ "${DAEMONIZED:-0}" -ne 1 ]]; then
  step "Killing all OpenClaw processes..."
  # Kill gateway processes
  pkill -f "openclaw.*gateway" 2>/dev/null || true
  pkill -f "node.*dist/index.js gateway" 2>/dev/null || true
  pkill -f "run-node.mjs gateway" 2>/dev/null || true

  # Stop launch agent if loaded
  launchctl bootout gui/"$UID"/ai.openclaw.gateway 2>/dev/null || true

  # Wait a moment for processes to die
  sleep 1

  # Verify no processes remain
  REMAINING=$(pgrep -f "openclaw.*gateway" 2>/dev/null | wc -l || echo "0")
  if [[ "$REMAINING" -gt 0 ]]; then
    log_yellow "Warning: Some processes may still be running"
    pgrep -f "openclaw.*gateway" 2>/dev/null || true
  else
    log_green "All processes cleaned up"
  fi
else
  step "Skipping kill step (daemonized — already killed by parent)"
fi

# Rebuild unless --no-build
if [[ "${NO_BUILD:-0}" -eq 1 ]]; then
  step "Skipping rebuild (--no-build specified)"
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

# Start gateway
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
  # No launchd plist loaded — start directly
  if pnpm openclaw gateway start; then
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
