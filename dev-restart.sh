#!/usr/bin/env bash
# dev-restart.sh — Build UI + restart gateway from the local fork.
# Usage: ./dev-restart.sh [--ui-only] [--no-build]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BUILD=true
RESTART=true

for arg in "$@"; do
  case "$arg" in
    --ui-only)  RESTART=false ;;
    --no-build) BUILD=false ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if $BUILD; then
  echo "🔧 Building UI..."
  pnpm ui:build
  echo "✅ UI built"
fi

if $RESTART; then
  echo "🔄 Restarting gateway..."
  launchctl unload ~/Library/LaunchAgents/ai.openclaw.gateway.plist 2>/dev/null || true
  sleep 1
  launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
  echo "✅ Gateway restarted (fork: $SCRIPT_DIR/dist/index.js)"
fi
