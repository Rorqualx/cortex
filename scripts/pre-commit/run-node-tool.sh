#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

# Prefer the already-installed binary directly. `pnpm exec` runs a deps-status
# check first (verify-deps-before-run, on by default in pnpm v11); when it
# decides node_modules is stale it tries to purge+reinstall, which needs a TTY
# confirmation that git hooks don't have — aborting the commit with
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY. The hook only needs to run the
# formatter, not reconcile dependencies, so resolve the binary ourselves and
# skip pnpm entirely. Falls through to the package-manager paths below when the
# binary isn't hoisted to the root .bin (e.g. a workspace-local tool).
local_bin="$ROOT_DIR/node_modules/.bin/$tool"
if [[ -x "$local_bin" ]]; then
  exec "$local_bin" "$@"
fi

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  exec pnpm exec "$tool" "$@"
fi

if { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
  exec bunx --bun "$tool" "$@"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm exec -- "$tool" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx "$tool" "$@"
fi

echo "Missing package manager: pnpm, bun, or npm required." >&2
exit 1
