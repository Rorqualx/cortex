#!/usr/bin/env bash
#
# Schema-skew self-heal for the decoupled-deploy pipeline.
#
# Deploy is normally consolidated to the daily midnight cron (see cron-deploy-build.sh
# and the "Midnight Deploy" cron). That is safe for ordinary changes — landing to main
# never changes what the gateway serves. But a SQLite SCHEMA-VERSION BUMP is the one
# change that cannot wait for midnight: once ANY newer-schema process migrates the
# on-disk state DB (e.g. an `openclaw` CLI call auto-rebuilds the stale dist to the new
# version and opens the DB), the still-running OLDER gateway can no longer open that DB
# for new connections — every spawned cron/agent hits
#   SqliteSchemaVersionError: newer schema version N; this build supports N-1
# and times out. That is exactly what stranded the fork on 2026-08-27 (state DB migrated
# to v13 while the live gateway stayed on the v12 release r-1787811434).
#
# This check heals that specific, breaking skew: if the on-disk state DB schema version
# is NEWER than the version baked into the deployed runtime (dist.current), and the
# current source can satisfy it, dispatch a deploy to rebuild + promote + bounce the
# gateway onto the matching build. It does nothing (fast exit) when there is no skew, so
# ordinary days still deploy only at midnight.
#
# Idempotent + self-limiting: cron-deploy-build.sh holds a single-flight deploy lock, so
# overlapping ticks SKIP; once the deploy promotes the new release, db_ver <= deployed_ver
# and this exits SELFHEAL-OK.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DB="${OPENCLAW_STATE_DB:-$HOME/.openclaw/state/openclaw.sqlite}"

read_num() { grep -oE '[0-9]+' <<<"${1:-}" | head -1; }

# On-disk state DB schema version (the canonical primary row).
db_ver="$(sqlite3 "$STATE_DB" "SELECT schema_version FROM schema_meta WHERE meta_key='primary';" 2>/dev/null)"
db_ver="$(read_num "$db_ver")"

# Version the DEPLOYED runtime actually serves. dist.current is the atomic-swap symlink
# the gateway loads; grep the exported constant straight out of the built bundle. (This
# is a top-level export, not minified away in this build; if a future build renames it
# the grep yields empty and we SELFHEAL-SKIP rather than act on missing data.)
deployed_ver="$(read_num "$(grep -rhoE 'OPENCLAW_STATE_SCHEMA_VERSION *= *[0-9]+' "$ROOT/dist.current/" 2>/dev/null | head -1)")"

# Version the current SOURCE (HEAD) would build to — what a rebuild can satisfy.
src_ver="$(read_num "$(grep -oE 'OPENCLAW_STATE_SCHEMA_VERSION *= *[0-9]+' "$ROOT/src/state/openclaw-state-db-contract.ts" 2>/dev/null | head -1)")"

if [ -z "${db_ver:-}" ] || [ -z "${deployed_ver:-}" ] || [ -z "${src_ver:-}" ]; then
  echo "SELFHEAL-SKIP: could not read a version (db=${db_ver:-?} deployed=${deployed_ver:-?} src=${src_ver:-?}); not acting on missing data."
  exit 0
fi

if [ "$db_ver" -le "$deployed_ver" ]; then
  echo "SELFHEAL-OK: state DB schema v$db_ver <= deployed v$deployed_ver — the live runtime can open the DB; nothing to heal."
  exit 0
fi

# db_ver > deployed_ver: the live gateway is too old for the migrated DB — this is the
# breaking skew. A rebuild only helps if source is at least the DB version.
if [ "$src_ver" -lt "$db_ver" ]; then
  echo "SELFHEAL-ALERT: state DB schema v$db_ver > deployed v$deployed_ver, but source is only v$src_ver — a rebuild would NOT satisfy the DB (the DB was migrated by a build ahead of main). Manual intervention required; NOT deploying."
  command -v osascript >/dev/null 2>&1 && osascript -e 'display notification "Schema skew: state DB newer than source — manual fix needed" with title "OpenClaw self-heal"' >/dev/null 2>&1 || true
  exit 1
fi

echo "SELFHEAL-DEPLOY: state DB schema v$db_ver > deployed v$deployed_ver (source v$src_ver can satisfy it) — the live gateway cannot open the migrated DB; dispatching a deploy to bring the runtime to v$src_ver."
# Detached (mirrors land_and_deploy): the deploy bounces the gateway, which would kill an
# inline child. cron-deploy-build.sh's single-flight lock makes overlapping dispatches safe.
nohup env DEPLOY_CRON_JOB_ID="${SELFHEAL_DEPLOY_JOB_ID:-}" bash "$ROOT/scripts/cron-deploy-build.sh" </dev/null >/tmp/schema-selfheal-deploy.log 2>&1 &
disown 2>/dev/null || true
echo "SELFHEAL-DEPLOY: dispatched (detached; /tmp/schema-selfheal-deploy.log)."
exit 0
