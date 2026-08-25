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

# build_dist_and_repair <root> — run the bundle build, then repair any dist artifacts it
# dropped (plugin manifests, control-ui) so $root/dist is a COMPLETE build. Returns the
# build's own exit code and sets DEPLOY_DIST_REPAIRED=1 iff a repair was needed. Does NOT
# bounce, promote, quiesce, lock, or dispatch a health watcher — the caller decides how to
# activate the result (legacy in-place bounce, or clone+swap promote). In the migrated
# release layout the build writes the scratch `dist` dir, NOT the serving release, so it no
# longer crashes the running gateway; in legacy mode it still rewrites the live dist.
DEPLOY_DIST_REPAIRED=0
build_dist_and_repair() {
  local root="$1"
  DEPLOY_DIST_REPAIRED=0
  echo "==> Building the bundle into dist/ ..."
  rm -f "$HOME/.openclaw/update-check.json"
  # Build the bundle directly instead of `pnpm build` so pnpm 11's verify-deps pre-run
  # install does not fire (it can wedge for minutes and re-runs native postinstalls that
  # fail under x64/Rosetta node). OPENCLAW_DEPLOY_BUILD=1 marks this as the one sanctioned
  # in-place build so the build-suicide guard (scripts/lib/assert-build-safe.mjs) stands down.
  (cd "$root" && env OPENCLAW_DEPLOY_BUILD=1 CI=1 npm_config_verify_deps_before_run=false node --import tsx scripts/build-all.mts)
  local build_rc=$?

  local restored
  restored="$(restore_plugin_manifests "$root")"
  [ "$restored" -gt 0 ] && { echo "==> restored $restored dropped plugin manifest(s) after the build"; DEPLOY_DIST_REPAIRED=1; }

  # control-ui verify + retry rather than a fire-and-forget rebuild: ui:build wipes
  # dist/control-ui via emptyOutDir at the START, so an interrupted attempt leaves NO
  # index.html — only treat it as fixed once the assets are confirmed present.
  if [ ! -f "$root/dist/control-ui/index.html" ]; then
    echo "==> control-ui wiped by the build; rebuilding..."
    local attempt
    for attempt in 1 2; do
      (cd "$root" && CI=1 npm_config_verify_deps_before_run=false pnpm ui:build) || true
      [ -f "$root/dist/control-ui/index.html" ] && { DEPLOY_DIST_REPAIRED=1; break; }
      echo "==> ui:build attempt $attempt left control-ui empty (interrupted emptyOutDir?)."
    done
    [ -f "$root/dist/control-ui/index.html" ] || echo "DEPLOY-WARN: control-ui still missing after 2 rebuilds; fix pnpm ui:build." >&2
  fi
  return "$build_rc"
}
