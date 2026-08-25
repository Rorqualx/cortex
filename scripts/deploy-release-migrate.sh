#!/usr/bin/env bash
#
# One-time, idempotent, reversible migration to the atomic release layout
# (scripts/lib/deploy-release-swap.sh). After this, deploys build into the scratch `dist`
# dir without touching the running gateway and atomically promote on success.
#
# It:
#   1. Clones the current dist into dist.releases/r-<epoch>/dist and points dist.current -> it
#      (inner dist/ so the served realpath keeps a "/dist/" segment — see deploy-release-swap.sh).
#   2. Repoints the gateway launchd service (dist/index.js -> dist.current/index.js) and
#      the control-ui root config at dist.current (timestamped backups kept).
#   3. Retires the rebuild-restart watcher (the staged deploy owns the bounce now).
#   4. Reloads the gateway and verifies it boots via dist.current — AUTO-ROLLS-BACK the
#      plist/config/watcher and reverts to serving dist if it does not come up.
#
# Usage:
#   scripts/deploy-release-migrate.sh            migrate (idempotent)
#   scripts/deploy-release-migrate.sh status     show layout + where the plist/config point
#   scripts/deploy-release-migrate.sh rollback   undo: serve dist again, restore backups
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/deploy-build-core.sh
source "$ROOT/scripts/lib/deploy-build-core.sh"
# shellcheck source=scripts/lib/deploy-release-swap.sh
source "$ROOT/scripts/lib/deploy-release-swap.sh"

PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
WATCHER_PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.rebuild-restart.plist"
CONFIG="$HOME/.openclaw/openclaw.json"
UID_N="$(id -u)"
GW="ai.openclaw.gateway"
HEALTH_URL="${MIGRATE_HEALTH_URL:-https://127.0.0.1:18789/}"
BOOT_TIMEOUT="${MIGRATE_BOOT_TIMEOUT:-200}"

log() { echo "[release-migrate] $*"; }
die() { echo "[release-migrate] ERROR: $*" >&2; exit 1; }

gateway_up() {
  local code
  code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
  [ "$code" = "200" ]
}
wait_gateway_up() {
  local dl=$(( $(date +%s) + BOOT_TIMEOUT ))
  while [ "$(date +%s)" -lt "$dl" ]; do gateway_up && return 0; sleep 5; done
  return 1
}
reload_gateway() {
  launchctl bootout "gui/$UID_N/$GW" 2>/dev/null || true
  # bootout is ASYNC and the gateway drains for ~2-3s; a fixed `sleep 2` lets bootstrap
  # race the still-tearing-down job, which fails and leaves the gateway DOWN (the migration
  # boot-verify then times out). Wait until the job is actually unloaded, then bootstrap
  # with retries while launchd settles.
  local i=0
  while launchctl print "gui/$UID_N/$GW" >/dev/null 2>&1 && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
  local j=0 llog="/tmp/openclaw-migrate-launchctl.log"
  : >"$llog" 2>/dev/null || true
  while [ "$j" -lt 6 ]; do
    if launchctl bootstrap "gui/$UID_N" "$PLIST" >>"$llog" 2>&1; then echo "bootstrap ok (attempt $((j + 1)))" >>"$llog"; return 0; fi
    echo "bootstrap attempt $((j + 1)) failed (rc=$?)" >>"$llog"
    launchctl print "gui/$UID_N/$GW" >/dev/null 2>&1 && { echo "job already loaded; treating as bootstrapped" >>"$llog"; return 0; }
    sleep 2
    j=$((j + 1))
  done
  echo "all bootstrap attempts failed; kickstart -k last resort" >>"$llog"
  launchctl kickstart -k "gui/$UID_N/$GW" 2>/dev/null || true
}

# Rewrite the plist ProgramArguments entry that ends in /dist/index.js to /dist.current/…
# (or back), via python plistlib so the XML stays valid. Arg: the dist basename to target.
point_plist_at() { # $1 = "dist" (rollback) | "dist.current" (migrate)
  local want="$1"
  python3 - "$PLIST" "$ROOT" "$want" <<'PY'
import sys, plistlib
plist_path, root, want = sys.argv[1], sys.argv[2], sys.argv[3]
with open(plist_path, "rb") as f:
    d = plistlib.load(f)
args = d.get("ProgramArguments", [])
changed = False
for i, a in enumerate(args):
    if a.endswith("/dist/index.js") or a.endswith("/dist.current/index.js"):
        args[i] = f"{root}/{want}/index.js"
        changed = True
d["ProgramArguments"] = args
# Capture stderr for the dist.current attempt so an early crash (before the app logger,
# normally sent to /dev/null) is visible for diagnosis. The rollback restores the backup
# plist (StandardErrorPath back to /dev/null), so this only applies while migrated.
if want == "dist.current":
    d["StandardErrorPath"] = "/tmp/openclaw-gateway-boot-stderr.log"
with open(plist_path, "wb") as f:
    plistlib.dump(d, f)
print("changed" if changed else "no-entry-found")
PY
}

# Point gateway.controlUi.root at <root>/<want>/control-ui in openclaw.json (node edit).
point_config_at() { # $1 = "dist" | "dist.current"
  local want="$1"
  node -e '
    const fs=require("fs"); const [cfgPath,root,want]=process.argv.slice(1);
    const c=JSON.parse(fs.readFileSync(cfgPath,"utf8"));
    c.gateway=c.gateway||{}; c.gateway.controlUi=c.gateway.controlUi||{};
    c.gateway.controlUi.root=`${root}/${want}/control-ui`;
    fs.writeFileSync(cfgPath, JSON.stringify(c,null,2)+"\n");
    console.log("controlUi.root ->", c.gateway.controlUi.root);
  ' "$CONFIG" "$ROOT" "$want"
}

cmd="${1:-migrate}"

if [ "$cmd" = "status" ]; then
  echo "migrated: $(deploy_is_migrated "$ROOT" && echo yes || echo no)"
  echo "dist.current -> $(deploy_serving_release "$ROOT" || echo '(none)')"
  echo "releases: $(ls -d "$ROOT"/dist.releases/r-* 2>/dev/null | wc -l | tr -d ' ')"
  echo "plist runs: $(python3 -c "import plistlib;print([a for a in plistlib.load(open('$PLIST','rb')).get('ProgramArguments',[]) if a.endswith('index.js')])" 2>/dev/null)"
  echo "controlUi.root: $(node -e 'console.log(require(process.argv[1]).gateway?.controlUi?.root)' "$CONFIG" 2>/dev/null)"
  echo "watcher plist present: $([ -f "$WATCHER_PLIST" ] && echo yes || echo 'no (retired)')"
  exit 0
fi

if [ "$cmd" = "rollback" ]; then
  log "rolling back to serving dist/ directly"
  point_plist_at "dist" >/dev/null || true
  point_config_at "dist" >/dev/null || true
  # Restore the watcher if a backup exists.
  [ -f "$WATCHER_PLIST.pre-atomic-swap.bak" ] && mv -f "$WATCHER_PLIST.pre-atomic-swap.bak" "$WATCHER_PLIST" 2>/dev/null || true
  rm -f "$ROOT/dist.current" 2>/dev/null || true
  reload_gateway
  wait_gateway_up && log "rollback complete — gateway serving dist/ ($HEALTH_URL 200)" || die "gateway did not come up after rollback; inspect manually"
  exit 0
fi

# ---- migrate ----
deploy_dist_complete "$ROOT" || die "dist is incomplete (need dist/index.js + dist/control-ui/index.html) — build first"
[ -f "$PLIST" ] || die "gateway plist not found at $PLIST"
[ -f "$CONFIG" ] || die "config not found at $CONFIG"

if deploy_is_migrated "$ROOT" && python3 -c "import sys,plistlib;a=plistlib.load(open('$PLIST','rb')).get('ProgramArguments',[]);sys.exit(0 if any(x.endswith('/dist.current/index.js') for x in a) else 1)"; then
  log "already migrated (dist.current + plist point at the release layout); nothing to do"
  exit 0
fi

# Transactional migration: a failure that left a dangling dist.current (with the plist
# still on dist/) would flip every deploy into the unquiesced atomic-swap branch and crash
# the live gateway, so any failure before the reload verifies healthy must undo EVERYTHING
# and leave the system exactly as it was (serving dist/). A cleanup trap enforces that.
ts="$(date +%Y%m%d-%H%M%S)"
MIGRATE_DONE=0
PLIST_BAK=""
CONFIG_BAK=""
rel=""
relbase=""
migrate_cleanup() {
  release_deploy_lock   # always drop the deploy lock, whether we committed or rolled back
  [ "$MIGRATE_DONE" = 1 ] && return 0
  log "migration did not commit — undoing partial state (back to serving dist/)"
  [ -n "$PLIST_BAK" ] && [ -f "$PLIST_BAK" ] && cp "$PLIST_BAK" "$PLIST" 2>/dev/null || true
  [ -n "$CONFIG_BAK" ] && [ -f "$CONFIG_BAK" ] && cp "$CONFIG_BAK" "$CONFIG" 2>/dev/null || true
  [ -f "$WATCHER_PLIST.pre-atomic-swap.bak" ] && mv -f "$WATCHER_PLIST.pre-atomic-swap.bak" "$WATCHER_PLIST" 2>/dev/null || true
  rm -f "$ROOT/dist.current" 2>/dev/null || true
  [ -n "$relbase" ] && rm -rf "$relbase" 2>/dev/null || true
}
trap migrate_cleanup EXIT

# Serialize against deploy builds / healthcheck rebuilds — all mutate or clone dist, and an
# overlap can seed a release cloned one chunk short (the ERR_MODULE_NOT_FOUND that failed the
# first migration attempts). Wait up to ~10min for an in-flight build, then abort leaving
# production untouched (still serving dist/); rerun when idle.
migrate_waited=0
until try_acquire_deploy_lock; do
  [ "$migrate_waited" -ge 600 ] && die "a deploy build (pid=${DEPLOY_LOCK_HOLDER:-?}) has held the deploy lock >10min; aborting migration — rerun when idle"
  log "waiting for an in-flight deploy build to finish (pid=${DEPLOY_LOCK_HOLDER:-?}, ${migrate_waited}s)…"
  sleep 15
  migrate_waited=$((migrate_waited + 15))
done

log "seeding first release from current dist"
mkdir -p "$ROOT/dist.releases"
# Ensure dist has its plugin manifests BEFORE cloning (restore operates on the repo root,
# not a release dir), so the seeded release is complete.
restore_plugin_manifests "$ROOT" >/dev/null 2>&1 || true
relbase="$ROOT/dist.releases/r-$(date +%s)-$$"
rel="$relbase/dist"   # inner dist/ — keeps a "/dist/" segment in the served realpath
# clone_dist_to verifies the seeded release is COMPLETE (file count == dist), retrying and
# falling back to ditto — a release cloned one chunk short boots ERR_MODULE_NOT_FOUND.
clone_dist_to "$ROOT" "$rel" || die "could not make a complete clone of dist into $rel"
[ -f "$rel/control-ui/index.html" ] || die "seeded release missing control-ui — aborting before any infra change"
ln -sfn "$rel" "$ROOT/dist.current" || die "could not create dist.current symlink"
log "dist.current -> $rel"
node --check "$ROOT/dist.current/index.js" 2>/dev/null || log "warn: node --check on entry inconclusive (bundled entry may not be plain-parseable) — continuing"

log "backing up plist + config (suffix .pre-atomic-swap.$ts.bak)"
PLIST_BAK="$PLIST.pre-atomic-swap.$ts.bak"
CONFIG_BAK="$CONFIG.pre-atomic-swap.$ts.bak"
cp "$PLIST" "$PLIST_BAK" || die "plist backup failed"
cp "$CONFIG" "$CONFIG_BAK" || die "config backup failed"

log "repointing plist + control-ui root at dist.current"
[ "$(point_plist_at "dist.current")" = "changed" ] || die "could not find dist/index.js in plist"
point_config_at "dist.current" >/dev/null || die "could not update controlUi.root"

log "retiring rebuild-restart watcher (staged deploy owns the bounce now)"
launchctl bootout "gui/$UID_N/$GW.rebuild-restart" 2>/dev/null || true
[ -f "$WATCHER_PLIST" ] && mv -f "$WATCHER_PLIST" "$WATCHER_PLIST.pre-atomic-swap.bak" 2>/dev/null || true

log "reloading gateway onto dist.current (one migration bounce)…"
reload_gateway
if wait_gateway_up; then
  MIGRATE_DONE=1
  log "MIGRATED — gateway healthy, serving via dist.current -> $(basename "$relbase")/dist ($HEALTH_URL 200)"
  exit 0
fi

# Reload failed: restore infra, revert to serving dist/, reload again, and mark DONE so the
# trap does not re-run over this careful hand-rollback.
log "gateway did NOT come up after migration — AUTO-ROLLBACK"
cp "$PLIST_BAK" "$PLIST"
cp "$CONFIG_BAK" "$CONFIG"
[ -f "$WATCHER_PLIST.pre-atomic-swap.bak" ] && mv -f "$WATCHER_PLIST.pre-atomic-swap.bak" "$WATCHER_PLIST" 2>/dev/null || true
rm -f "$ROOT/dist.current" 2>/dev/null || true
[ -n "$relbase" ] && rm -rf "$relbase" 2>/dev/null || true
reload_gateway
MIGRATE_DONE=1
wait_gateway_up && die "migration failed and was rolled back — gateway serving dist/ again; investigate" \
  || die "migration failed AND rollback did not restore the gateway — inspect $PLIST and $CONFIG backups (.pre-atomic-swap.$ts.bak)"
