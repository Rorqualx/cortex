# Upstream Resync Ledger — 2026-08-22

Branch: `resync-staging/2026-08-22` (worktree `../openclaw-upstream-nightly`)
Base (main): `aa430596278` → upstream tip `5ddf381` (behind = 0 after merge)
Delta: **438 commits** upstream (295 fix / 70 perf / 26 test / 15 feat / 14 refactor / 6 improve).
Fork 1014 ahead. Hardening-heavy delta.

## How this branch was built

The nightly cron (`scripts/cron-upstream-merge.sh`) staged the bulk merge to upstream
`70c2be7` (10 non-ui conflicts + 313 ui files resolved by fork-ownership policy) and
committed reconciliation fixups (`877a8f01736`..`fa3aabafb95`). This session **topped it
up with the 20 newest upstream commits** (`70c2be7..5ddf381`) and drove the whole thing
to validated / land-ready.

## ui/ ownership (policy, not judgment)

`ui/` is fork-owned: the fork ships the pre-rearchitecture `ui/src/ui/**` tree; upstream
ships `ui/src/{pages,lib,api,app}/**`. The merge takes main's `ui/` wholesale and drops
upstream-only ui files. **`HEAD:ui` is byte-identical to `main:ui` (tree `3f645486`)** — so
every ui-only tsgo lane matches main's baseline by construction. (43 upstream-only ui files
dropped in the top-up merge.)

## Top-up conflicts (20 commits) — reconciled this session

| File | Verdict | Notes |
| --- | --- | --- |
| `packages/gateway-protocol/src/sessions-patch-result.ts` | ENHANCE-OURS | Keep fork `session-row.js` `GatewayAgentRuntime` import (upstream relocated it to `agents-models-skills.js`); graft upstream #127951 `contextWindow`/`contextWindows` optional fields so the result stays a superset. |
| `scripts/build-all.mts` | KEEP-BOTH (additive) | Fork `WINDOWS_BUILD_MAX_OLD_SPACE_MB` + `PLUGIN_SDK_DTS_CACHE_INPUTS` and upstream #128007 `RUN_NODE_SKIP_DTS_BUILD_ENV` are independent consts, each consumed once — not a union-trap. |

## Keystone graft — upstream #127951 (context-window switch)

The merge adopted the feature's consumer runtime (auto-merged) but kept-ours the shared
type defs → **29 cascading tsgo:core errors**, all `contextWindow`/`contextWindows` missing.
Grafted the fields into the shared types (commit `c6b15819f78`); cascade collapsed 29 → 0:

- `src/shared/session-types.ts` — new `GatewayContextWindowOption` type.
- `src/gateway/session-utils.types.ts` — `GatewaySessionsDefaults` + `GatewaySessionRow`.
- `packages/gateway-protocol/src/schema/agents-models-skills.ts` — `GatewayContextWindowOptionSchema` + `ModelChoiceSchema` fields.
- `src/config/sessions/types.ts` — `SessionEntry.contextWindow`.
- `src/plugins/session-entry-slot-keys.ts` — reserved-slot exhaustiveness guard.
- (`model-catalog.types.ts`, `session-entry-selection.ts` already carried the fields.)

## merge=ours drift fix — upstream #128018

`packages/gateway-protocol/src/schema/logs-chat.ts` was kept-ours while the upstream test
was adopted → grafted the 4 `Static<>` type exports (`ChatHistoryParams/DeltaResult/
ResetResult/CursorResult`). tsgo:test:packages 4 → 0. (commit `fe4a80e7aaa`)

## Verification (Mac) — zero merge-caused failures

7 tsgo lanes (cache cleared):
- **core 0** ✓ · **extensions 0** ✓ · **test:packages 0** ✓ · **test:ui 0** ✓
- **core:test 8** / **test:src 8** — proven main-identical baseline (7 `agent-bundle-mcp-runtime.test.ts` strict-null + 1 `system-prompt.test.ts` sessionUrl); ran `tsgo:core:test` on `main` → identical 8. Not merge-caused.
- **extensions:test 22** — memory-l3 `Signals` baseline; memory-l3 untouched by the merge.
- `protocol-gen` clean (no dropped protocol exports).
- `fork-config-snapshot verify` — only tsconfig/package drift (upstream-additive: `koffi` dep, plugin-sdk export, tsconfig path); lockfile frozen-consistent; baseline regenerated + re-verified clean.
- **autoreview** (claude-fable-5, high) on the +67/-4 reconciliation judgment diff — **CLEAN, "patch is correct."**

## Production LOC

Reconciliation *judgment* this session: +67 / -4 (all additive type grafts + 2 resolutions).
Full branch vs main non-ui/non-test: +39737 / -14277 — this is the adopted **upstream** delta
(438 commits, already reviewed upstream), not fork-authored surface.

## Linux proof (huey, Node 24)

`scripts/remote-proof.sh` — build + `test:fast`, baseline-diffed against main. [in progress]

## Fork follow-ups (NOT resync scope)

1. `agent-bundle-mcp-runtime.test.ts` — 7 strict-null / `ImageContent|TextContent.text` errors on **main baseline** (new since 08-20; main's own drift). Small, bounded test-only fix.
2. `system-prompt.test.ts` sessionUrl — long-standing baseline (per 08-20 ledger).
3. Carried from 08-20: memory-wiki → `memory-tool-contract` migration; port desired upstream ui features to fork `ui/src/ui`; secret-state vault classification; realtime-session-policy 6→9 tool assertion.
