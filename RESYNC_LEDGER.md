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

## +5 top-up (443 total) — 2026-08-22 later

Folded in 5 more upstream commits (`5ddf381..` tip). ui/ by policy (8 dropped). One
non-ui conflict:
- `control-ui-bootstrap-contract.ts`: keep-both — fork `timeFormat`/`chatMessageMaxWidth`
  + upstream #127711 `environment?: ControlUiEnvironment`. The feature's config schema
  (`zod-schema.gateway`, `types.gateway`, help/hints/labels) + `control-ui.ts` producer
  auto-merged and consume the field, so it is load-bearing; UI consumer is fork-owned
  (degrades gracefully via the HTML env attribute). tsgo all lanes clean/baseline.

## Linux proof (huey, Node 24) — `scripts/remote-proof.sh`

First run (tip e6668) caught two Linux-only signals the Mac can't:
1. **Build fail — control-ui startup JS gzip 585538 B** > 583689 baseline+tolerance, under
   the 589824 B hard ceiling. ui/ == main, so growth is non-ui runtime bundled into the
   startup path (gateway-protocol schema additions + 438-commit package delta). **Bumped
   the baseline to 585538 B** (documented step; sanctioned `--update-baseline` mechanism).
2. **NEWFAIL `audit-event-writer.test.ts` — environmental flake, NOT merge-caused.** The
   prod file + test are byte-identical to main; the failing subtest is a timing-bound
   "nonblocking under a held write lock" assertion; it passes 3/3 locally and passed in
   the proof's own main-baseline phase; the candidate failed once under post-build
   contention. All 7 tsgo lanes matched baseline on Linux (base==cand).

Re-proof on the +5 tip (baseline bump applied) — [in progress].

## Fork follow-ups (NOT resync scope)

1. `agent-bundle-mcp-runtime.test.ts` — 7 strict-null / `ImageContent|TextContent.text` errors on **main baseline** (new since 08-20; main's own drift). Small, bounded test-only fix.
2. `system-prompt.test.ts` sessionUrl — long-standing baseline (per 08-20 ledger).
3. Carried from 08-20: memory-wiki → `memory-tool-contract` migration; port desired upstream ui features to fork `ui/src/ui`; secret-state vault classification; realtime-session-policy 6→9 tool assertion.

## 2026-08-24 (late) — upstream aec1cd40 (23 commits)

Behind=23, raw conflicts 63 (61 ui/ → fork-ownership policy; 59 upstream-only ui files dropped).
Non-ui work: 2 conflicts + 1 merge=ours drift file.

- `src/commands/models/refresh.ts` — **KEEP-OURS**. Fork rewrote the command around the
  discovery-orchestrator (per-provider live /models polling, `--provider`, discovered snapshot);
  upstream's only base→head delta is #128981 wrapping `refreshRemoteModelCatalog` failures in
  `ExpectedCliError` — a path the fork command no longer has (failures are per-provider report
  data, rendered in human + JSON output). Restored fork version byte-identical from the pinned
  baseline. Fork module `remote-refresh.ts` itself untouched (still available to its other callers).
- `src/commands/models/refresh.test.ts` — **KEEP-OURS**. Fork tests cover the fork feature;
  upstream's #128981 tests exercise the hosted-catalog body this fork replaced (fork header comment
  documents the same verdict from a prior pass). Dropped the silently-combined upstream
  `ExpectedCliError` import (unused → not fork-committed).
- `src/agents/cli-runner.reliability.test.ts` — **ADOPT-UPSTREAM + port 3 fork-only tests.**
  merge=ours had frozen a pre-#121589 snapshot: fork file lacked 13 upstream tests (incl. tonight's
  #128732 pair + #121589 format-sweep coverage) while ALL relevant production modules
  (cli-runner.ts, execute/reliability/helpers/types, cli-run-recovery, failover-error,
  cli-session, reply-run-registry, cli-backend.types) are byte-identical fork↔upstream — the
  divergence was pure stale-reconciliation drift, not fork intent (no fork-authored commit ever
  touched the file; full-history shows only upstream commits + resync merges). Rebased onto
  upstream and ported the 3 fork-only tests (`keeps non-capture live-session artifacts through
  fresh recovery retry`, `reports CLI reply backends as streaming until the managed run finishes`,
  `lets configured agent default timeouts lift the default resume no-output ceiling`) onto
  upstream's helper infra (+`replyRunRegistry` import). Supersedes the 62da85d hand-patch
  (claude-live-session import removal + claudeSkillsPluginArgs) — upstream's file already has both.

Derived files regenerated in worktree: pnpm-lock (install clean), kysely-types, protocol-gen
(+swift unchanged, +kotlin regenerated) — all exit 0. No product-collision found → finish-land.
