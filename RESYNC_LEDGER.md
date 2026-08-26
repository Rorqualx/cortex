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

| File                                                     | Verdict              | Notes                                                                                                                                                                                                                 |
| -------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/gateway-protocol/src/sessions-patch-result.ts` | ENHANCE-OURS         | Keep fork `session-row.js` `GatewayAgentRuntime` import (upstream relocated it to `agents-models-skills.js`); graft upstream #127951 `contextWindow`/`contextWindows` optional fields so the result stays a superset. |
| `scripts/build-all.mts`                                  | KEEP-BOTH (additive) | Fork `WINDOWS_BUILD_MAX_OLD_SPACE_MB` + `PLUGIN_SDK_DTS_CACHE_INPUTS` and upstream #128007 `RUN_NODE_SKIP_DTS_BUILD_ENV` are independent consts, each consumed once — not a union-trap.                               |

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

Reconciliation _judgment_ this session: +67 / -4 (all additive type grafts + 2 resolutions).
Full branch vs main non-ui/non-test: +39737 / -14277 — this is the adopted **upstream** delta
(438 commits, already reviewed upstream), not fork-authored surface.

## +5 top-up (443 total) — 2026-08-22 later

Folded in 5 more upstream commits (`5ddf381..` tip). ui/ by policy (8 dropped). One
non-ui conflict:

- `control-ui-bootstrap-contract.ts`: keep-both — fork `timeFormat`/`chatMessageMaxWidth`
  - upstream #127711 `environment?: ControlUiEnvironment`. The feature's config schema
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

## 2026-08-26 — upstream 2f17d11e901 (bounded batch, 80 of 248)

Behind=80 (bounded), raw conflicts 68 (59 ui/ → fork-ownership policy; 56 upstream-only ui files dropped).
Non-ui work: 9 conflicts + 3 merge=ours drift files.

- `packages/agent-core/src/agent-loop.ts` — **KEEP-OURS + ENHANCE-OURS graft.** Upstream #129293
  restructured the loop (ToolBatchContext, runAgentLoopCore extraction). Fork keeps its steering
  loop wholesale (08-20 precedent: fork steering vs upstream loop restructure). Grafted the one-line
  caller-messages-array isolation into `runAgentLoopContinue` (`{ ...context, messages:
[...context.messages] }`) — the behavioral substance of #129293; both new isolation tests pass
  against the fork loop. The #129293 ToolBatchContext restructure (incl. commit-failure settle
  semantics) is DEFERRED as fork follow-up.
- `packages/agent-core/src/agent-loop.test.ts` — fork file (== base) + upstream's new
  "public runner context isolation" describe appended (2 tests, pass with the graft). Upstream's
  settle-semantics test ("keeps Agent active until started parallel work settles…") NOT adopted —
  tests the deferred #129293 restructure. NOTE: "does not launch prepared tools when the admission
  commit fails" + the full-file hang are PRE-EXISTING on main (verified against a temp worktree at
  276809575d0: same assertion failure, same hang) — not merge-caused.
- `src/cli/skills-cli.ts` — **KEEP-OURS + graft.** Fork de-workshopped file (f8300651e88) kept;
  grafted upstream #129802's `canFallbackToImplicitLocalGateway` gate into
  `loadGatewaySkillsStatusReport`'s catch (remote-gateway failures now surface instead of silently
  falling back to workspace status). Workshop/curator hunks (5,6) kept fork (Skill Forge is the
  only pipeline). Unused upstream imports (resolveGatewayPort etc.) not adopted.
- `src/cli/program/register.subclis-core.ts` — **KEEP-OURS.** Upstream #129351's
  `defineImportedSubCliGroups` tuple dedup is redundant with the fork's
  `defineImportedProgramCommandGroupSpecs` (load-bearing across command-registry-core,
  command-group-descriptors, register.subclis). Kept fork incl. vault + skill-forge entries.
- `extensions/workboard/src/{dispatcher,dispatcher.test,lifecycle-sync.test}.ts` — **KEEP-OURS
  (deletion honored).** Fork deleted extensions/workboard/ (deprecated, replaced by core
  src/workboard/); upstream modified 3 files in the deleted dir → git rm. Standing fork policy.
- `extensions/qa-lab/src/*.cleanup.test.ts` ×2 — **KEEP-OURS.** Fork's
  `smokeArtifactPath: "crabline-fake-provider-smoke.json"` field (fork crabline infra) kept.
- `config/control-ui-startup-budget-baseline.json` — **KEEP-OURS** (585538; upstream's 340901
  measures their rearchitected UI — irrelevant to fork ui ownership). COUNT-DISAGREEMENT noted;
  huey build measures; bump only if over 585538 (ceiling 589824).

merge=ours drift (rebased onto upstream via merge-file, fork delta re-applied):

- `src/agents/sessions/tools/bash.ts` — clean 3-way: upstream's
  `createCommandTerminationController`/`forceKillAfterDelay` termination + fork's
  session-awareness exec-guard, `resolveBashTimeoutMs` returns-undefined behavior,
  `toLintErrorObject`, exported types.
- `src/agents/bash-tools.exec-runtime.ts` — upstream's `ExecProcessPreflightError` export +
  `beforeSpawn` preflight hook restored (adopted consumers exec-host-gateway.ts/exec-run.ts import
  them); guards inserted before primary spawn (covers pty+child) and PTY-fallback retry; fork's
  exec-host supervisor spawn fields (runId/backendId/scopeKey), onUpdate, sandbox paths preserved.
- `src/agents/tool-display-config.ts` — upstream `displayAction()` compaction adopted; fork's
  canvas actions (eval/snapshot/a2ui_push/a2ui_reset) re-expressed in compacted form; upstream's
  github_publish/github_identity_status/sessions entries RESTORED (dropped from fork display config
  by earlier resync rebase cf38ae4e9a6 while the tools remain registered — collateral, superset
  adopt). Fork's message-tool actions and memory_reports entry intact.

## 2026-08-26 (evening continuation) — proof-failure fixes (attempt 2)

First finish-land (11:05Z) proof FAILED rc=1 on two counts; both fixed on the staged branch:

- **BUILD_EXIT=1 — `write-plugin-sdk-entry-dts` OOM'd** on huey (Node 24 default ~4GB heap;
  Mark-Compact 4068MB → allocation failure). Upstream's 80-commit batch grew the plugin-sdk
  DTS surface past the default. Validated on huey directly: with
  `--max-old-space-size=8192` the phase completes in 1:27 at **5.42GB peak RSS**.
  Fix: cross-platform `nodeOptions` step field in `scripts/build-all.mts` (applies on every
  platform, unlike win32-only `windowsNodeOptions`; merge logic extracted to
  `mergeNodeOptions`), set to `--max-old-space-size=8192` (= `WINDOWS_BUILD_MAX_OLD_SPACE_MB`)
  on the entry-dts step. Upstream has the same win32-only gap (no fix to adopt). Tests:
  updated the tsx-step expectedEnv + new merge test (51 pass; the 7 step-list failures in
  build-all.test.ts are PRE-EXISTING on main 276809575d0 — verified in a baseline worktree).
- **tsgo:extensions:test 24 vs baseline 23** — net-new was exactly one:
  `extensions/openshell/src/backend.remote-seed.test.ts` TS2741 (upstream-new file #129809,
  adopted wholesale; its config literal lacks the fork-required `SandboxConfig.osSandbox`).
  ENHANCE-OURS: added the fork idiom (`enabled:false/extraWritableRoots/extraProtectedMetadata/
network:"deny"` — same as backend.exec-workdir.test.ts) to the upstream test. ext:test now 23
  = baseline (memory-l3 only). Scoped vitest: 2/2 pass.

No product-collision. finish-land attempt 2.
