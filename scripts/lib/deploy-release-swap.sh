#!/usr/bin/env bash
#
# Atomic release layout for the in-place deploy, so a build never touches the running
# gateway and a failed build never ships.
#
# Layout (all under the repo root, all gitignored like dist itself):
#   dist                    real dir — the build's scratch/output target (unchanged; the
#                           build cleans + rewrites it every run)
#   dist.releases/r-<epoch> promoted releases (clones of dist taken at promote time)
#   dist.current            symlink -> dist.releases/r-<active>  (what the gateway serves)
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
  # PID-suffixed so a deploy promote and a concurrent healthcheck-recovery promote in the
  # same second cannot target the same release dir.
  local rel="$root/dist.releases/r-$(date +%s)-$$"
  # clone_dist_to verifies the clone is complete (file count == dist) and falls back from the
  # instant APFS clonefile to ditto if it is short — an incomplete release boots
  # ERR_MODULE_NOT_FOUND on the missing chunk and must never go live.
  if ! clone_dist_to "$root" "$rel"; then
    echo "REFUSE-PROMOTE: could not make a complete clone of dist into $rel" >&2
    return 1
  fi
  if ! _deploy_repoint_current "$root" "$rel"; then
    rm -rf "$rel" 2>/dev/null || true
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
  local root="$1" cur r found=0 prev=""
  cur="$(deploy_serving_release "$root")"
  # Releases newest-first by mtime; the predecessor is the one immediately AFTER the
  # current in that order (the next-older). Selecting "newest that isn't current" would
  # oscillate between the two newest instead of stepping back in time.
  for r in $(ls -dt "$root"/dist.releases/r-* 2>/dev/null); do
    if [ "$found" = 1 ]; then prev="$r"; break; fi
    [ "$r" = "$cur" ] && found=1
  done
  [ -n "$prev" ] || { echo "no previous release to roll back to" >&2; return 1; }
  _deploy_repoint_current "$root" "$prev" || return 1
  echo "$prev"
}

# prune_releases <root> [keep] — keep the newest <keep> releases (current always kept),
# remove older ones. Never removes the release dist.current points at.
prune_releases() {
  local root="$1" keep="${2:-4}" cur r i=0
  cur="$(deploy_serving_release "$root")"
  for r in $(ls -dt "$root"/dist.releases/r-* 2>/dev/null); do
    [ "$r" = "$cur" ] && continue
    i=$((i + 1))
    [ "$i" -ge "$keep" ] && rm -rf "$r" 2>/dev/null || true
  done
}
