#!/usr/bin/env bash
#
# Atomic release layout for the in-place deploy, so a build never touches the running
# gateway and a failed build never ships.
#
# Layout (all under the repo root, all gitignored like dist itself):
#   dist                      real dir — the build's scratch/output target (unchanged; the
#                             build cleans + rewrites it every run)
#   dist.releases/r-<epoch>/dist  promoted releases (verified clones of dist at promote time)
#   dist.current              symlink -> dist.releases/r-<active>/dist  (what the gateway serves)
#
# Why each release is served from an INNER `dist/` dir (dist.releases/r-<id>/dist), not the
# release dir itself: the packaged runtime finds its own root by locating the "/dist/" path
# segment in its module path (fileURLToPath(import.meta.url)) — that is how it resolves the
# SQLite read-only worker, the control-ui root, plugin entrypoints, session archive workers,
# etc. (~10 core files, e.g. src/infra/runtime-worker-url.ts). A release served from
# ".../dist.releases/r-<id>/" has NO "/dist/" segment ("dist.releases" != "dist"), so those
# resolvers fall through and the gateway crash-loops with ERR_MODULE_NOT_FOUND on the worker.
# Serving from ".../dist.releases/r-<id>/dist/" restores a real "/dist/" segment, so the
# whole runtime resolves with zero core changes.
#
# The gateway is launched as dist.current/index.js; Node realpaths the symlink at load, so
# a RUNNING gateway is pinned to its release dir and is unaffected when dist.current is
# repointed. That is what makes the swap safe: the deploy builds into `dist` (never the
# serving release), verifies, clones dist into a new release, atomically repoints
# dist.current, and only then bounces. A failed or incomplete build simply never promotes,
# so the live gateway keeps serving the last-good release.
#
# Sourcing this file needs restore_plugin_manifests from deploy-build-core.sh; callers
# source that first.

# deploy_is_migrated <root> — true once the atomic layout is in place (dist.current is a
# symlink). Deploys fall back to legacy in-place behavior until then.
deploy_is_migrated() { [ -L "$1/dist.current" ]; }

# deploy_serving_release <root> — the release dir dist.current points at (empty if none).
deploy_serving_release() { readlink "$1/dist.current" 2>/dev/null; }

# deploy_dist_complete <root> — is $root/dist a complete, bootable build?
deploy_dist_complete() { [ -f "$1/dist/index.js" ] && [ -f "$1/dist/control-ui/index.html" ]; }

# clone_dist_to <root> <dest> — make a COMPLETE copy of <root>/dist at <dest>, VERIFIED by
# file count. An incomplete release boots ERR_MODULE_NOT_FOUND on the missing chunk (a real
# migration failure: a release cloned short of one file), so this never leaves a partial
# release live: fast instant APFS clonefile (cp -cR) with a retry, then a `ditto` fallback
# (bulletproof full copy), else fail leaving no dest. Returns 0 on a verified copy.
clone_dist_to() {
  local root="$1" dest="$2" want got attempt
  want="$(find "$root/dist" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [ "${want:-0}" -gt 0 ] || return 1
  mkdir -p "$(dirname "$dest")" 2>/dev/null || true   # dest may be <base>/dist with <base> new
  for attempt in 1 2; do
    rm -rf "$dest" 2>/dev/null || true
    cp -cR "$root/dist" "$dest" 2>/dev/null || true
    got="$(find "$dest" -type f 2>/dev/null | wc -l | tr -d ' ')"
    [ "$got" = "$want" ] && return 0
  done
  rm -rf "$dest" 2>/dev/null || true
  ditto "$root/dist" "$dest" 2>/dev/null || true
  got="$(find "$dest" -type f 2>/dev/null | wc -l | tr -d ' ')"
  [ "$got" = "$want" ] && return 0
  rm -rf "$dest" 2>/dev/null || true
  return 1
}

# _deploy_repoint_current <root> <release> — atomically point dist.current at <release>
# (create a temp symlink in the same dir, then rename over the existing one — rename(2)
# within a dir is atomic). `mv -h` is REQUIRED: without it, mv follows an existing
# dist.current symlink-to-dir and moves the temp link INSIDE the release dir instead of
# replacing the symlink, leaving dist.current pointing at the old release (a silent no-op
# swap). `-h` renames onto the symlink itself. macOS/BSD mv only; this is macOS deploy infra.
_deploy_repoint_current() {
  local root="$1" rel="$2" tmp="$1/.dist.current.tmp.$$"
  ln -sfn "$rel" "$tmp" && mv -fh "$tmp" "$root/dist.current" && return 0
  rm -f "$tmp" 2>/dev/null || true
  return 1
}

# promote_release <root> — clone the freshly-built $root/dist into a new release and
# atomically repoint dist.current at it. Restores dropped plugin manifests first and
# REFUSES to promote an incomplete dist (so a half-built dist can never become live).
# Echoes the new release dir on success. Does NOT bounce — the caller bounces after any
# quiesce. Prunes old releases (keeps the newest DEPLOY_RELEASES_KEEP, default 4).
promote_release() {
  local root="$1"
  restore_plugin_manifests "$root" >/dev/null
  if ! deploy_dist_complete "$root"; then
    echo "REFUSE-PROMOTE: dist is incomplete (index.js or control-ui/index.html missing) — keeping current release" >&2
    return 1
  fi
  mkdir -p "$root/dist.releases" 2>/dev/null || true
  # PID-suffixed base so a deploy promote and a concurrent healthcheck-recovery promote in
  # the same second cannot target the same release. Served dir is the INNER dist/ (see header
  # — keeps a "/dist/" segment in the runtime path so worker/asset resolution works).
  local base="$root/dist.releases/r-$(date +%s)-$$"
  local rel="$base/dist"
  # clone_dist_to verifies the clone is complete (file count == dist) and falls back from the
  # instant APFS clonefile to ditto if it is short — an incomplete release boots
  # ERR_MODULE_NOT_FOUND on the missing chunk and must never go live.
  if ! clone_dist_to "$root" "$rel"; then
    rm -rf "$base" 2>/dev/null || true
    echo "REFUSE-PROMOTE: could not make a complete clone of dist into $rel" >&2
    return 1
  fi
  # Pin the release's own package.json beside its dist/. src/version.ts resolves VERSION
  # from "../package.json" relative to the served dist; without this copy it climbs to the
  # live tree's package.json, so a version bump landed on main (no deploy) flips VERSION under
  # the running release, the state-DB schema fast path (schema_meta.app_version == VERSION)
  # stops matching, and every write-mode CLI/spawned process hits the Gateway-owner fence
  # ("device identity required" from the CLI). Observed 2026-09-05.
  cp "$root/package.json" "$base/package.json" 2>/dev/null || {
    rm -rf "$base" 2>/dev/null || true
    echo "REFUSE-PROMOTE: could not pin package.json into $base" >&2
    return 1
  }
  # Ship the workspace template pack beside dist/. Pinning package.json above makes the release
  # dir the resolved package root (resolveOpenClawPackageRoot stops at the first "openclaw"
  # package.json walking up from the served dist/). The runtime resolves workspace bootstrap
  # templates from "<packageRoot>/docs/reference/templates" (src/agents/workspace-templates.ts),
  # and the npm package contract ships them there (check-openclaw-package-tarball REQUIRED_TARBALL
  # _ENTRIES). Without this copy, isolated-session bootstrap fails with "Missing workspace
  # template: AGENTS.md ()" for every cron/spawned agent. Observed 2026-09-05 after the pin.
  if [ -d "$root/docs/reference/templates" ]; then
    mkdir -p "$base/docs/reference" 2>/dev/null && cp -R "$root/docs/reference/templates" "$base/docs/reference/templates" 2>/dev/null || {
      rm -rf "$base" 2>/dev/null || true
      echo "REFUSE-PROMOTE: could not pin workspace templates into $base" >&2
      return 1
    }
  else
    rm -rf "$base" 2>/dev/null || true
    echo "REFUSE-PROMOTE: source workspace templates missing at $root/docs/reference/templates" >&2
    return 1
  fi
  if ! _deploy_repoint_current "$root" "$rel"; then
    rm -rf "$base" 2>/dev/null || true
    echo "REFUSE-PROMOTE: could not repoint dist.current" >&2
    return 1
  fi
  prune_releases "$root" "${DEPLOY_RELEASES_KEEP:-4}"
  echo "$rel"
}

# rollback_release <root> — repoint dist.current at the newest release that is NOT the
# current one (instant recovery to the last-good build). Echoes the release, or fails if
# there is no previous release. Does NOT bounce — the caller bounces.
rollback_release() {
  local root="$1" curbase b found=0 prevrel=""
  # dist.current -> <base>/dist; select in base space, then repoint at the predecessor's
  # inner dist/. Releases newest-first by mtime; the predecessor is the base immediately
  # AFTER the current one (the next-older). Selecting "newest that isn't current" would
  # oscillate between the two newest instead of stepping back in time.
  curbase="$(dirname "$(deploy_serving_release "$root")")"
  for b in $(ls -dt "$root"/dist.releases/r-* 2>/dev/null); do
    if [ "$found" = 1 ]; then prevrel="$b/dist"; break; fi
    [ "$b" = "$curbase" ] && found=1
  done
  [ -n "$prevrel" ] && [ -d "$prevrel" ] || { echo "no previous release to roll back to" >&2; return 1; }
  _deploy_repoint_current "$root" "$prevrel" || return 1
  echo "$prevrel"
}

# --- offline agent-schema migration (stopped-writer `doctor --fix`) ---------
# The agent-DB identity/schema migration (src/state/openclaw-agent-db-schema.ts ensureAgentSchema)
# requires stopped-writer maintenance and fires exactly when an agent DB's SQLite user_version is
# below OPENCLAW_AGENT_SCHEMA_VERSION. The gateway boot fail-closes on it ("requires stopped-writer
# maintenance ... run openclaw doctor --fix") and crash-loops, and NOTHING else in the deploy runs
# that migration — so a schema-bearing release must migrate offline before it serves (the recurring
# 2026-08-29/08-30 midnight-deploy outage). Shared by the proactive deploy path and the
# healthcheck's reactive step-0.
DEPLOY_GATEWAY_LABEL="gui/$(id -u)/ai.openclaw.gateway"

# deployed_agent_schema_version <root> — the OPENCLAW_AGENT_SCHEMA_VERSION the release expects.
# The deploy builds dist from the checkout, so the source literal IS the deployed target (dist is
# minified/hard to parse); read it there. Echoes the integer, or nothing when unreadable.
deployed_agent_schema_version() {
  grep -oE 'OPENCLAW_AGENT_SCHEMA_VERSION = [0-9]+' \
    "$1/src/state/openclaw-agent-db-contract.ts" 2>/dev/null | grep -oE '[0-9]+' | head -1
}

# agent_schema_migration_pending <root> — true when any on-disk agent DB is BELOW the deployed
# schema version, i.e. exactly the `userVersion < targetVersion` condition under which
# ensureAgentSchema demands the stopped-writer lease and boot refuses. Read-only PRAGMA reads are
# safe against the still-running gateway (WAL allows concurrent readers). Fail SAFE: on any
# uncertainty (no target, no sqlite3, unreadable DB) return true so the offline path runs rather
# than risk a crash-loop.
agent_schema_migration_pending() {
  local root="$1" target db v
  target="$(deployed_agent_schema_version "$root")"
  [ -n "$target" ] || return 0
  command -v sqlite3 >/dev/null 2>&1 || return 0
  local agents_dir="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/agents"
  for db in "$agents_dir"/*/agent/openclaw-agent.sqlite; do
    [ -f "$db" ] || continue
    v="$(sqlite3 "$db" 'PRAGMA user_version;' 2>/dev/null)"
    [ -n "$v" ] || return 0
    [ "$v" -lt "$target" ] 2>/dev/null && return 0
  done
  return 1
}

# run_offline_agent_migration <root> — hold the gateway DOWN and run `doctor --fix` so the
# stopped-writer migration completes; leaves the gateway down (the caller brings it up, e.g. via
# bounce_gateway's bootstrap fallback, then verifies). bootout stops launchd KeepAlive from
# respawning a writer mid-migration. `doctor --fix` (= --repair) applies without prompting, so it
# never blocks in a detached deploy. Returns doctor's exit code.
run_offline_agent_migration() {
  local root="$1" rc dl
  launchctl bootout "$DEPLOY_GATEWAY_LABEL" 2>/dev/null || true
  dl=$(( $(date +%s) + 30 ))
  while launchctl print "$DEPLOY_GATEWAY_LABEL" >/dev/null 2>&1 && [ "$(date +%s)" -lt "$dl" ]; do sleep 1; done
  node "$root/openclaw.mjs" doctor --fix >/tmp/deploy-agent-migration.log 2>&1
  rc=$?
  return "$rc"
}

# prune_releases <root> [keep] — keep the newest <keep> releases (current always kept),
# remove older ones. Never removes the release dist.current points at.
prune_releases() {
  local root="$1" keep="${2:-4}" curbase b i=0
  curbase="$(dirname "$(deploy_serving_release "$root")")"
  for b in $(ls -dt "$root"/dist.releases/r-* 2>/dev/null); do
    [ "$b" = "$curbase" ] && continue
    i=$((i + 1))
    [ "$i" -ge "$keep" ] && rm -rf "$b" 2>/dev/null || true
  done
}
