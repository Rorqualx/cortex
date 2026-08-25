#!/usr/bin/env bash
#
# Shared core of an in-place deploy build: the bundle build plus the dist repairs that
# must happen before the crash-relaunched gateway boots on it. Sourced by
# cron-deploy-build.sh (the deploy) and cron-deploy-healthcheck.sh (auto-recovery) so
# there is ONE canonical build+repair path, not two that drift.
#
# The in-place `pnpm build` rewrites dist/ and crashes the live gateway; launchd
# relaunches it on the fresh dist — so the build IS the deploy. Two dist artifacts get
# dropped by that build and, if not restored, boot a broken gateway:
#   * dist/extensions/*/openclaw.plugin.json — a missing manifest fails config
#     validation with exit 78 ("plugin manifest not found") and crash-loops the gateway
#     (the 2026-08-24 multi-hour outage). The deploy previously restored control-ui but
#     NOT these manifests, so a build that dropped them shipped a crash-looping gateway.
#   * dist/control-ui/index.html — vite emptyOutDir wipes it; a wiped root is a cached
#     503 the crash-relaunch cannot clear on its own.

# restore_plugin_manifests <root> — copy each source openclaw.plugin.json into its built
# dist plugin dir when the build emitted the dir but dropped the manifest. Only touches
# plugins the build actually produced (dist dir present); leaves source-only / non-built
# plugins alone. Echoes the count restored.
restore_plugin_manifests() {
  local root="$1" n=0 src id dist
  for src in "$root"/extensions/*/openclaw.plugin.json; do
    [ -e "$src" ] || continue
    id="$(basename "$(dirname "$src")")"
    dist="$root/dist/extensions/$id"
    if [ -d "$dist" ] && [ ! -f "$dist/openclaw.plugin.json" ]; then
      cp "$src" "$dist/openclaw.plugin.json" 2>/dev/null && n=$((n + 1))
    fi
  done
  printf '%s' "$n"
}

# run_deploy_build_step <root> — run the in-place bundle build, then repair any dist
# artifacts it dropped (plugin manifests, control-ui) and bounce ONCE if a repair was
# needed so the gateway boots on the complete dist instead of crash-looping or serving a
# cached empty root. Returns the build's own exit code (the caller decides what to do
# with a failed build). Does NOT quiesce, lock, or dispatch a health watcher — that is
# the deploy wrapper's job; recovery reuses just this core.
run_deploy_build_step() {
  local root="$1"
  echo "==> Building (this crashes the gateway; launchd relaunches on the fresh dist = deploy complete)..."
  rm -f "$HOME/.openclaw/update-check.json"
  # Build the bundle directly instead of `pnpm build` so pnpm 11's verify-deps pre-run
  # install does not fire (it can wedge for minutes and re-runs native postinstalls that
  # fail under x64/Rosetta node). OPENCLAW_DEPLOY_BUILD=1 marks this as the one sanctioned
  # in-place build so the build-suicide guard (scripts/lib/assert-build-safe.mjs) stands down.
  (cd "$root" && env OPENCLAW_DEPLOY_BUILD=1 CI=1 npm_config_verify_deps_before_run=false node --import tsx scripts/build-all.mts)
  local build_rc=$?

  local restored
  restored="$(restore_plugin_manifests "$root")"
  [ "$restored" -gt 0 ] && echo "==> restored $restored dropped plugin manifest(s) after the build"

  # control-ui verify + retry rather than a fire-and-forget rebuild: ui:build wipes
  # dist/control-ui via emptyOutDir at the START, so an interrupted attempt leaves NO
  # index.html — only treat it as fixed once the assets are confirmed present.
  local ui_fixed=0
  if [ ! -f "$root/dist/control-ui/index.html" ]; then
    echo "==> control-ui wiped by the build; rebuilding..."
    local attempt
    for attempt in 1 2; do
      (cd "$root" && CI=1 npm_config_verify_deps_before_run=false pnpm ui:build) || true
      [ -f "$root/dist/control-ui/index.html" ] && { ui_fixed=1; break; }
      echo "==> ui:build attempt $attempt left control-ui empty (interrupted emptyOutDir?)."
    done
    [ "$ui_fixed" = 1 ] || echo "DEPLOY-WARN: control-ui still missing after 2 rebuilds; NOT bouncing onto an empty root. Fix pnpm ui:build." >&2
  fi

  # Bounce once if we repaired dist so the gateway boots on the complete dist. If nothing
  # was dropped, the build's own crash-relaunch already booted the fresh dist.
  if [ "$restored" -gt 0 ] || [ "$ui_fixed" = 1 ]; then
    echo "==> repaired dist; bouncing the gateway to boot on the complete dist..."
    launchctl kickstart -k "gui/$(id -u)/ai.openclaw.gateway" 2>/dev/null || true
  fi
  return "$build_rc"
}
