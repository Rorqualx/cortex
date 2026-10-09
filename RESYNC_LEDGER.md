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

## 2026-08-26 (third batch, 11:37 MT) — upstream 2e50bdf9fbb, 80 commits

Baseline 1c8b2d38fab (includes this morning's land). residual=113 (111 ui policy-resolved);
2 conflicts + 3 merge=ours drift. No product-collision.

- `src/config/sessions/session-entry-selection.ts` — CONVERGENT SAME-FEATURE: both sides
  wired the fork's own model-override-provenance module (identical in both trees). Adopted
  upstream's structure (`inheritModelSelection`/`inheritAuthProfile` — gates provider/model/
  source/routeResolution/agentRuntime/authProfile, uses the refined self-origin-aware
  `hasSessionActiveAutoModelFallback`) + grafted fork-only bits: the user-intent comment and
  `contextTokens` inheritance gated on a CARRIED pick (upstream's gate alone would ride a
  runtime-resolved budget into new sessions — fork test case 4 forbids). Dropped fork's
  `isUserModelOverride` const + its import (superseded). sessions.model-inheritance.test 5/5.
- `test/scripts/build-external-plugin-local-dist.test.ts` — COUNT-DISAGREEMENT resolved
  KEEP-OURS: floor(≥50) + membership contract (fork policy vs upstream magic 63); merged
  tree selects 58 incl. upstream's new diffs/diffs-language-pack members. Comment numbers
  refreshed (58 vs 63). 3/3 pass.
- `src/agents/openclaw-tools.ts` (merge=ours drift) — rebased onto upstream via merge-file;
  2 conflicts: (1) KEEP-FORK architecture (`effectiveCallGateway`/`includeSubagentSpawnTool`;
  upstream's `sessionLookupToolOptions` block dead in fork structure — fork ships own
  sessions-list-tool); (2) ADOPT-UPSTREAM `agentId: sessionAgentId, config: sessionConfig` —
  agentId drop was prior-resync collateral (subagents-tool.ts has 0 fork commits, still
  consumes opts.agentId). Upstream's sessionConfig const auto-merged (5 uses). No orphan
  imports (callAgentToolGatewayRequest/resolveControlUiSessionLinkBase unreferenced).
- `src/agents/transcript-policy.test.ts` (merge=ours drift) — rebased onto upstream,
  merge-file clean (disjoint hunks): fork mock-spy + claude guards + upstream github-copilot
  modelApi rework. 44/45 pass; the 1 failure ("preserves thinking blocks … unowned Anthropic
  transport fallback") PRE-EXISTS at main 1c8b2d38 (verified: fork main's own test file fails
  identically against fork-main-identical production; production + replay-helpers unchanged
  by this merge) — fork follow-up, not resync scope, no NEWFAIL.
- `src/gateway/server-methods/session-change-event.ts` (merge=ours drift) — KEEP-OURS
  CITED: upstream's entire delta is the buildGatewaySessionEventFields→Snapshot rename of a
  call the fork's wire-pinned hand-rolled projection (`satisfies SessionsChangedEvent`)
  removed; both builders exist in merged session-event-payload.ts (fork had 0 delta there,
  merged == upstream, snapshot wraps eventFields); all 7 fork imports verified present in
  merged tree; gateway-protocol index.ts unchanged from fork main.
- Derived: pnpm install clean (lockfile unchanged by batch), kysely .mts regen no-op
  (script renamed .mjs→.mts upstream #121005), protocol-gen/swift/kotlin clean.

## 2026-08-27 (batch 6 resume, 02:36 MT cron) — upstream 8c293c1ae1c, 160 commits

Resumed resync-staging/2026-08-27 after proof failure. The 00:36 MT run resolved 9
conflicts + drift, committed merge 6fff299f688, preflight PASS — but huey proof
FAILED (EXIT=1, surfaced at 08:36Z after a Mac-poller timeout red herring):
extensions 0→3, core:test 9→10, extensions:test 23→38, test:src 9→10,
NEWFAIL portal-stream-command.test.ts. Preflight gates only tsgo:core — the red
lanes were invisible locally. Fixes (all verified: 7 lanes = baseline 0/0/9/23/9/0/0):

- extensions/ollama/src/embedding-provider.ts: ADOPT-UPSTREAM shim wholesale (13 lines;
  dropped fork's stale 416-line pre-canonical copy — zero human commits, resync-era
  collateral only). Kills old-API OllamaEmbeddingProvider (embedQuery) that upstream's
  memory-embedding-adapter.ts + both ollama test suites (upstream-identical) reject.
  Fork cache-key fix (7d430fa8f98 outputDimensionality-on-client) verified CONVERGED in
  upstream's runtime.ts (client.outputDimensionality → adapter cacheKeyData).
- extensions/memory-l3/src/engine.ts + scripts/calibrate-embeddings.ts: port
  embedQuery→embed(text, {inputType:"query"}) (canonical API; upstream removed
  MemoryEmbeddingProvider's embedQuery with the EmbeddingProvider alias).
- extensions/daytona backend.test.ts + backend.e2e.test.ts: ENHANCE-OURS — fork-required
  SandboxConfig.osSandbox idiom added to upstream-new literals (same as 08-26 openshell
  fix). Note: 2 daytona fs-bridge tests fail on macOS pre-edit (Linux proof passes them).
- src/agents/agent-tools.before-tool-call.network-error.test.ts: KEEP-FORK guard
  signature — upstream test's 1-param call adapted to fork's (config, {enabled}) form;
  config-first drives windowSize from types.tools.ts (production callers all 2-param).
- src/node-host/portal-stream-command.test.ts: ::1 case GUARDED on resolver capability.
  Root cause (proved live): huey node24/glibc resolves localhost → IPv4 ONLY
  (dns.lookup all:true → [127.0.0.1]); Mac resolves ::1 first. autoSelectFamily does
  NOT fall back on ECONNREFUSED (tested node24 ± TryAllAddresses). Transport code is
  upstream-identical — environment resolver difference, so the case now runs only where
  localhost resolves v6. Portal suite 11/11 on Mac (guard true).
  No product-collision. finish-land.

## 2026-08-28 (resume, 02:18 MT cron) — upstream 8d51e415d6a, 164 commits

STAGE-RESUME off resync-staging/2026-08-28 (merge b77e5776b5a committed by the
07:20Z run; ui-policy applied; two preflight FAILs outstanding: tsgo:core=3 all in
src/cron/isolated-agent/run-prepare.ts — missing `loadCronModelPreflightRuntime` /
`resolveCronPreflightCandidates`).

- src/cron/isolated-agent/run-prepare.ts: ADOPT-UPSTREAM — upstream #131353
  extracted the inline preflight loop + lazy loader into `resolveCronPreflight`
  (run-fallback-policy.ts). The fork's 247-line duplicate block (first of two
  call sites, added since merge-base f40f90727c8) kept its semantics (early-exit
  skipped result w/ model-preflight diagnostics + provider/model) but now
  delegates the loop to the policy — mirroring how the merge had already migrated
  the second call site. Provenance: symbol absent from upstream tip, present at
  base; fork never touched run-prepare-runtime.ts (delta empty) → not a fork
  symbol, an upstream-moved one; re-point, don't resurrect. Block-1's
  `modelFallbacksOverride` was gate-only in the baseline (read once in the
  reassignment `if`) — the gate now lives inside the policy, so the local const
  is dropped (TS6133 confirmed).
- tsgo:core 3→0 after fix (clean cache, full lane).

## 2026-08-28 (resume, 04:40 MT cron) — rebooted-proof retry + net-new core:test fix

huey rebooted ~09:18Z mid-proof (uptime 1:04 at 10:22Z, /tmp wiped) → the 5400s poller
timed out at 10:00Z and read as STAGE-PROOF FAIL; environmental, not merge-caused
(install+build had already run clean). Re-proof on the same tip: build clean, tsgo:core
0=0, tsgo:extensions 0=0, but tsgo:core:test base=9 cand=12 → 3 net-new TS2304.

- src/agents/agent-tools.before-tool-call.integration.e2e.test.ts: the merge adopted
  upstream's new code-mode/catalog e2e block (+182 lines) but lost upstream's two
  import lines (this test was fork-trimmed 2560→1836 lines pre-merge; the resolution
  dropped them). Grafted verbatim from pinned upstream 8d51e415d6a: `import type {
OpenClawConfig } from "../config/config.js"` (resolves through the fork's
  config→types→types.openclaw re-export chain) and
  `import { createToolSearchCatalogRef, registerHeadlessToolSearchCatalog } from
"./tool-search.js"` (tool-search.ts re-exports both from tool-search-catalog.ts).
  ADOPT-UPSTREAM; no fork delta in the region (fork never touched the import block).
- Verified: tsgo:core:test error-set == baseline 9 exactly (positions shifted only by
  the +182 adopted lines); imports-only change, no dup-decl risk.
- WART (follow-up, not merge): remote-proof.sh:78 prints "-f: command not found" before
  launch; harmless (heredoc write + launch both succeed). Also finish-land daemon log
  accumulates across runs. Fix post-land.

## 2026-08-28 (resume, 05:19 MT cron) — extensions:test 5 net-new = orphaned daytona tests

Proof of 9a979db8587 (launched 10:43Z by prior run, still in flight when this run
started): build 0, core 0/0, extensions 0/0, core:test 9/9, extensions:test
base=23 cand=28 → 5 net-new TS2307, test:src 9/9. Reproduced locally in the
worktree (28) — error-set: 5× daytona backend/backend.e2e TS2307 cannot find
'./backend.js'/'./client.js'/'./config.js'.

Root cause: upstream d7b0e07f4ca (#130996) reverted the entire Daytona cloud
sandbox plugin. The merge commit deleted 13/15 daytona files (2485 lines), but
backend.test.ts + backend.e2e.test.ts survived — the fork had modified them
(08-26 ENHANCE-OURS osSandbox literals) → modify/delete resolved keep-ours →
orphaned tests importing deleted modules.

- extensions/daytona/src/{backend,backend.e2e}.test.ts: ADOPT-UPSTREAM —
  deleted, completing the revert. Fork delta (osSandbox literals) was test-only
  for an upstream-authored plugin now reverted upstream; fork never touched
  daytona source (history: only 3a5cb3847c7). Not enabled in live openclaw.json;
  no non-doc references outside extensions/daytona. Ledger note: the 08-26
  daytona ENHANCE-OURS verdict is now MOOT (plugin reverted).
- Verified: tsgo:extensions:test worktree 28→23 == huey base 23 exactly
  (error-set minus the 5). No other orphan pattern (extensions 0/0, test:src
  9/9).

## 2026-08-28 (18:50 MT cron) — behind=31, raw=18 all-ui conflicts (policy-resolved); 2 merge=ours drift grafts

Upstream 79bdd1b022, base f804cdf4, fork a9ed8f9. All 18 raw conflicts in ui/ —
apply_fork_ui_ownership resolved them wholesale (14 upstream-only ui files
dropped); 0 residual code conflicts, 0 dropped upstream-new files. Work =
2 merge=ours drift files:

- src/agents/bash-tools.exec-runtime.ts (churn=3): ENHANCE-OURS — grafted
  upstream's resolveExecTarget fix (requestedTarget === "auto" → null) into the
  fork rewrite; ExecTarget includes "auto" (exec-approvals-core.ts:9) so the
  comparison type-checks. Fork line was byte-identical to upstream's pre-fix
  line, so the graft is exact.
- src/infra/tsdown-config.test.ts (churn=17): ENHANCE-OURS — upstream added
  minify?: unknown field + "minifies only the sealed deploy worker" test;
  tsdown.config.ts auto-merged upstream's workerDeployBuildConfig minify
  (codegen/compress/mangle keepNames) so the kept-ours test was silently
  missing the new coverage. Grafted both hunks; fork test already has
  entryKeys/requireUnifiedDistGraph helpers; entries verified present in
  merged tsdown.config.ts (worker/worker :189, rsync-receiver :224, minify :211).

Also: upstream bumped packageManager pin pnpm 11.22.0 → 12.0.0; local corepack
tool install was a broken placeholder (native binary postinstall never ran) —
repaired via node .tools/pnpm/12.0.0/node_modules/pnpm/install.js. Lockfile
still v9.0; install clean, no lockfile rewrite. pnpm-workspace.yaml adds
minimumReleaseAgeStrict: true (upstream, auto-merged).

## 2026-08-28 evening run — upstream 59dad71c..cddb4db8 (behind=47, raw=130, ui-policy resolved 124)

Conflicts resolved (6) + merge=ours drift (2):

- src/agents/tools/web-fetch.ts — ENHANCE-OURS. Upstream: abort hardening
  (throwIfFetchAborted x5, provider execute signal, cache-publish-after-guard,
  extracted fetchWebPayload). Fork: egress allowlist (loadPolicy/evaluateWebPolicy,
  webEgressBlockedError) + mergeSsrFPolicies. Resolution: kept upstream's
  structure incl. extraction; fork egress pre-check stays in runWebFetch;
  fetchWebPayload takes its own loadPolicy() snapshot (hash-cached) for the
  post-redirect re-check — upstream's extraction moved that check out of
  runWebFetch's scope; merged ssrfPolicy threaded via fetchWebPayload({...params,
  ssrfPolicy}) so the guarded fetch (policy: ssrfPolicy ?? params.ssrfPolicy) and
  cache discriminator both see it. No union: each declaration exists once.
- git-hooks/pre-commit — ADOPT-UPSTREAM (thin wrapper execs
  guard-staged-content.mjs). Fork's bash-3.2/`--` hardening PORTED into the new
  scripts/pre-commit/format-staged.sh (empty-restage_files guard + `--` before
  "${format_files[@]}" for oxfmt).
- .agents/skills/telegram-e2e-userbot/scripts/user-driver.py — ADOPT-UPSTREAM.
  Upstream renamed scripts/e2e/telegram-user-driver.py → skill dir + rewrote
  (1091 lines); open_contained_file deleted upstream entirely, so the fork's
  macOS port of it is moot. Took upstream blob at new path.
- test/scripts/telegram-user-credential.test.ts + telegram-user-observer.test.ts
  — ADOPT-UPSTREAM (accept deletion). Subjects (scripts/e2e/telegram-user-*
  suite, mantis lanes) all moved to the skill dir; the two tests were the only
  survivors still referencing the deleted scripts. Fork deltas on them (TS cast
  fix; os.waitid macOS fallback) are moot — new suite has no waitid/dir_fd
  hazards (verified by grep).
- config/control-ui-startup-budget-baseline.json — KEEP-OURS (main's 587154 B;
  upstream's 344714 B measures its rearchitected ui/ this fork does not ship).
  Same verdict as this morning's run; huey proof re-measures and bumps if needed.
- merge=ours drift src/agents/embedded-agent-runner/compact.types.ts — GRAFT:
  upstream added conversationRoutePeerId?: string; 10+ adopted consumers
  (compaction-runtime-context, run params, auto-reply) reference it. Added field.
- merge=ours drift src/agents/system-prompt.ts — GRAFT: upstream's 3
  sessions_spawn wording hunks (context:"isolated" guidance). Adopted upstream
  system-prompt.test.ts:917/1541/1546 asserts the NEW strings — without the
  graft behavior tests fail on huey. Kept fork's plain-string structure at the
  acpSpawnRuntimeEnabled branch (fork dropped the agents_list conditional
  earlier), wording updated.

## 2026-08-30 (upstream 46c1eef6, behind=88, raw=260 → ui-policy 257, code=3+1 drift)

- src/agents/embedded-agent-runner/run/payloads.ts — ADOPT-UPSTREAM (#133264 perf:
  reuse assistant/reply payload prep; removed redundant shouldSuppressRawErrorText
  filter — upstream's payloads.errors.test.ts unchanged and green, suppression now
  lives in the directive-preparation path) + GRAFT fork delta (lastToolRecovery
  success reply, hasUserFacingAssistantReply/ErrorReply/FailureAcknowledgement
  split feeding fork buildFailureWarning, heartbeat early-return guard, widened
  suppressToolErrorWarnings type). One hand-resolved hunk: upstream answerTexts
  ternary + preparedAnswerDirectives, fork's renamed declaration (errorText
  awareness lives in hasUserFacingErrorReply). No union: suppression machinery
  fully dropped, 0 stale refs.
- src/cli/skills-cli.curator.test.ts / skills-cli.workshop.test.ts — KEEP-OURS
  deletion (f8300651e88 "remove Skill Workshop — Skill Forge is the only skills
  pipeline"; upstream churn was 5-6 incidental lines). Ledger-documented product
  decision, not a collision.
- merge=ours drift src/cron/isolated-agent.model-preflight.test.ts — GRAFT: clean
  3-way union (merge-file exit 0); upstream's resolveSessionAuthSelectionMock +
  auth-profile config hunks + fork's fallback-passthrough test rewrite coexist
  (disjoint tests; mockRunCronFallbackPassthrough exists in harness at base/fork/upstream).

### 2026-08-30 fix commit (post-proof tsgo:test:src +1)

- src/agents/tool-mutation.test.ts — upstream #133188 adopted its tests against the
  FORK's 4-param buildToolMutationState(tool, args, meta?, options?) superset
  (fork f830-era fingerprint recovery work; upstream is 3-param). Fixed call shape
  (options as 4th arg, matching fork prod callers like tool-terminal-outcome.ts:51)
  and asserted via toMatchObject (fork convention for owner-keyed calls — the fork
  return is a superset with ownerKey/actionFingerprint). tsgo:test:src 9→8.
- src/agents/embedded-agent-runner/run/attempt.code-mode-reconciliation.test.ts —
  "inspects a partial mutation… replay fence" FAILS AT BASELINE (proven: huey run at
  404928fdbb3 reproduces; live main too). Pre-existing fork-main breakage in the
  steering-loop/preparer interplay (attempt-stream-prepare consults the preparer; this
  test mocks subscribe away), NOT merge-caused; not net-new → proof gate unaffected.
  Fork follow-up, not resync scope.

## 2026-08-31 evening merge (upstream 0eb5d6fb74a, 35 commits)

- `pnpm-lock.yaml` — REGENERATE (derived). `pnpm install --no-frozen-lockfile`; upstream dep set adopted. COUNT-DISAGREEMENT hunks moot after regeneration.
- `src/agents/system-prompt.ts` — ENHANCE-OURS via merge-file graft (upstream onto fork): churn=2 was only the `buildModelIdentityPromptLine` wording change ("Model question: answer this current-run value." → "If asked what model you are, answer with this value for the current run."). Graft was clean (exit 0); skill-forge markers verified back (`buildSkillForgePromptSection`, `SKILL_FORGE_TOOL_NAME`).
- `scripts/write-plugin-sdk-entry-dts.ts` — KEEP-OURS (cited): ab1b880a865 (2026-08-29 resync) deliberately froze this file to the fork baseline wholesale because upstream's staged-writer fragments were a semantic mix. Upstream's two new commits (#134528 shard UI checks/reuse SDK compiler inputs, #134529 bind declaration caches to plugin selection) further refine the staged-declarations architecture the fork does not run. Fork version is internally consistent (`.mjs`→`.mts` tsx resolution; build-all.mts carries the matching fork adaptations: distArtifactEntryArgs + heap nodeOptions for the huey OOM). Adopting upstream would mean adopting the whole staged-writer architecture — maintainer-scale decision, not drift repair.
- Derived regen: `protocol-gen{,-swift,-kotlin}` all clean (no dropped merge=ours exports); `generate-kysely-types.mts` clean; no unstaged/untracked residue.

## 2026-08-31 late merge (upstream 68cbc3bf8e, 66 commits)

- `scripts/build-all.mts` — the only content conflict (1 hunk, the import block). Upstream removed build-all's last usage of the plugin-sdk-entries helpers; fork keeps `pluginSdkEntrypoints` in the import (still consumed by `PLUGIN_SDK_ENTRY_DTS_CACHE_OUTPUTS` → fork write-plugin-sdk-entry-dts step) and drops `listPluginSdkDistArtifacts` (export survives in the lib for `scripts/release-check.ts`). ADOPT-UPSTREAM for the tsdown-unified cache-block rewrite: upstream deleted the `requiredCacheHitOutputs` mechanism wholesale — the new `scripts/lib/build-artifact-cache.mts` records every successful output byte and validates the whole generation before restore ("a surviving barrel is not a complete generation"), which structurally replaces the fork's `requiredCacheHitOutputs: listPluginSdkDistArtifacts()` guard against stale shared declaration snapshots. Also adopt upstream's env-signature simplification (`env: TSDOWN_UNIFIED_CACHE_ENV` without the inline `OPENCLAW_RUN_NODE_SKIP_DTS_BUILD` append — run-mode flag, not a cache input). All 16:18 fork grafts verified present post-merge: `WINDOWS_BUILD_MAX_OLD_SPACE_MB`, `PLUGIN_SDK_DTS_CACHE_INPUTS`, `build:plugin-sdk:dts`, `write-cli-compat`, `mergeNodeOptions`, `FULL_RUNTIME_ONLY_STEPS`.
- `src/gateway/session-utils.types.ts` (merge=ours drift, hand-graft — upstream delta tiny/additive vs fork's heavy restructure): added `import type { StickyModelSelectionTarget }` + `GatewaySessionsDefaults.modelSelectionTarget?: StickyModelSelectionTarget`. Required, not optional polish: auto-adopted consumers (`server-methods/sessions-read.ts` writes it into `result.defaults`, `chat-history-handler.ts` resolves it) — without the graft the field is a type error or a silent closedObject strip (dropped-contract class).
- Derived regen: lockfile already up to date; `generate-kysely-types.mts` clean (NOTE: cron prompt still says `.mjs` — renamed `.mts` upstream; correct invocation `node --import ./scripts/tsx.mjs scripts/generate-kysely-types.mts`); protocol-gen rewrote `dist/protocol.schema.json` (untracked build output), swift unchanged, kotlin 2 files rewritten. No dropped merge=ours exports (dropped-upstream-count=0).
- Proof (huey, stamp 2b4ab254ee6): BUILD_EXIT=0; tsgo lanes core 0/0, extensions 1/1, core:test 8/8, extensions:test 28/28, test:src 8/8, test:ui 0/0, test:packages 0/0; no NEWFAIL; EXIT=0. Baseline recompute ~50 min (fresh cache at b390fe33956), candidate+lanes+test:fast ~35 min. LANDED main @ 11ea1197fad (merge 2b4ab254ee6 + baseline regen), pushed to origin; deploy deferred to the daily midnight cron.

## 2026-09-06 third batch (upstream dbf7b06342d, 112 commits) — test-port finish

- Conflicts (6) + merge=ours drift resolved by the 16:18 run (worktree STAGE-RESUME'd; see
  upstream-merge.log for that pass's detail). This run finished its blocker: the two fork-only
  auth-profile integration suites still seeded `auth-profiles.json` and asserted JSON cache
  semantics while upstream moved the store to sqlite cells behind the store-runtime facade with a
  fail-closed legacy gate (`AUTH_PROFILE_MIGRATION_REQUIRED` → doctor). Committed 8b78abebb50.
- `auth-profiles.ensureauthprofilestore.test.ts` (28→24): PORT fixtures to
  `writePersistedAuthProfileStoreRaw` raw cells (load-path normalization guards: mode/apiKey
  aliases, #58861 SecretRef-backed key/token migration, invalid-entry warn aggregation) and
  `saveAuthProfileStore` (main/agent merge + inherited reads); array payloads now assert the
  stronger `AuthProfileStoreUnreadableError` contract; external-profile resolution re-pointed to
  the `externalAuthTestApi` test-support seam (the old provider-runtime vi.mock never intercepted
  `nativePluginBindings`); persisted-read assertion via `loadPersistedAuthProfileStore`.
  DROP 4 legacy-JSON migration tests as superseded upstream: doctor-auth-flat-profiles (59 its),
  doctor-auth-canonical-api-key-alias, doctor-auth-migration-receipts, plus the runtime gate
  itself (legacy-source-diagnostic.test.ts; sqlite-store.test.ts "does not read legacy
  auth-profiles.json at runtime"). Guards preserved, subjects relocated.
- `auth-profiles.store-cache.test.ts` (9→3): PORT cache-refresh-after-sqlite-change,
  mutation-isolation (structuredClone guard scoped to store-shaped payloads — plugin-registry
  code legitimately clones its own objects now), runtime-only-overlay non-persistence (cell
  missing via inspect). DROP 6 retired subjects: file-mtime cache, auth-profiles.json.lock
  contention ×2, unscoped persisted CLI overlay persist/races ×3 — owned by
  auth-profiles.sqlite-store.test.ts (revision-keyed handles, overlay recompute),
  external-oauth.test.ts (scoped CLI refresh; persisted sync now scope-gated to explicit refresh
  or MiniMax), upsert-with-lock.sqlite.test.ts (locked writes).
- Local proof: both files 27/27; sibling auth-profiles suites 122/122; tsgo core:test shards =
  7 baseline-only errors (agent-bundle-mcp-runtime ×6 + system-prompt ×1, pre-existing).

## 2026-09-23 (upstream 6487c6e6f382, bounded batch 200 of 2652, base 890c55a28e2)

Residual 241 → ui-policy resolved 228; 13 code conflicts + 4 merge=ours drift files.

- `packages/agent-core/src/agent-loop.ts` — KEEP-OURS ×5 hunks: fork steering loop + stream API (`agentLoop`/`agentLoopContinue`/`createAgentStream`/`pushLoopFailure`, `EventStreamConstructor` identity) kept; upstream `runAgentLoopCore` extraction + admission/warning const block NOT adopted (0 common-region consumers of the dropped constants). Precedent: 2026-08-26.
- `packages/agent-core/src/agent-loop.test.ts` (drift churn=157) — rebased onto upstream; adopted upstream's new "delivers loop warnings after raw outcome hooks" it.each (fork loop has afterToolOutcome/beforeToolBatch + `tool-loop-warning` type); fork recovery tests retained. Local full-file run hits the documented pre-existing main hang; huey error-set diff is the gate.
- `src/agents/embedded-agent-runner/run/params.ts` — fork fields (steered-turn persisted callback, one-shot CLI flags) + upstream's `& AgentRunClientContext & … & AgentRunLifecycle` composition tail (imports already in common block); ModelFallback import trimmed to used `ModelFallbackRouteResolution` (AttemptProvenance field removed upstream at base).
- `src/agents/embedded-agent-runner/run/payloads.ts` — ENHANCE-OURS: fork answer loop + lastToolRecovery block kept; grafted upstream `respectIntentionalSilence` (hasIntentionalSilentFinal from parseReplyDirectives `isSilent` in the fork loop; delivery-evidence gating for cron/heartbeat/abort). Upstream's segment-answer restructure (appendSegmentAnswer/textStart) NOT adopted — fork body appends answers its own way; substance ported instead.
- `src/cron/isolated-agent/run-executor.ts` — kept fork monolith (local AgentTurnPayload/CronRunExecutionParams/assertCronRuntimeAuthorityCandidate/buildCronDeliveryTargetRuntimeContext defs stay); adopted ONLY `createCronCandidateExecutionResolver` from run-candidate-runtime.ts (Pick<> params accept the fork type — no runId requirement). Upstream run.types.ts/run-admission.ts admission flow + runId threading not adopted; `resolveThinkingDefault` kept (merged run.runtime.ts has no resolveThinkingSelection export).
- `src/gateway/session-reset-service.ts` — ADOPT-UPSTREAM relocation: reset lifecycle emissions now live in postCommitActions (afterEntryMutation, mutation.*-based; adds handleSessionStateSessionReset + notifyGatewaySessionReset); fork's old-position block dropped (would double-fire end/start hooks, unbound event, worktree cleanup). Fork-only `preserveResetSessionForDiscovery` re-grafted post-settle (lifecycle.previousSessionId/previousEntry/archivedTranscripts). Note: upstream passes `archivedTranscripts: []` to emitEnd (their archiving contract moved); fork preserve still reads lifecycle.archivedTranscripts.
- `src/gateway/server-request-context.test.ts` — KEEP-OURS: fork inline fixtures (fork runtime fields: activitySubscribers, execApprovalManager…); upstream moved fixtures to server-request-context.test-support.js (module present; fork tests keep the inline fork-shaped fixture).
- `src/agents/bash-tools.exec-runtime.ts` (drift churn=4) — ENHANCE-OURS: upstream notify-on-exit receipt/owner enqueue (`enqueueSystemEventWithReceipt` + `withSystemEventOwner(eventOptions, session.agentId)` + `recordNotifyOnExitRemoval`, allowDuplicate) wrapped around the fork's eventRouting policy fields; second fire-and-forget enqueue site untouched. Upstream's heartbeat global/agentId routing variant NOT adopted (fork's scopedHeartbeatWakeOptionsForPolicy superset kept).
- `src/auto-reply/reply/agent-runner-execution.ts` (drift churn=12) — clean 3-way, no manual hunks.
- `src/cli/program/command-registry-core.ts` (drift churn=4) — KEEP-OURS: `defineImportedProgramCommandGroupSpecs` architecture (load-bearing); upstream's inline-tuple restructure subsumed; command set = fork superset (fork-only commitments + workboard entries).
- `extensions/workboard/{openclaw.plugin.json,browser/lib/workboard/card-state.ts,src/store.test.ts,src/store-subscription-scope.test.ts}` + `docs/web/control-ui/{chat,feature-reference,security-model}.md` — KEEP-OURS deletions (git rm). Standing policy: extension replaced by core src/workboard/ (deprecated in feature ledger); docs describe upstream's rearchitected UI the fork does not ship.
- Deferred to huey proof (error-set diff vs main baseline): payloads.cron-delivery.test.ts local subprocess-build failure in the spawn-broker/sqlite-readonly-worker chain (upstream-rewrote; may be the documented Mac Rosetta native-module class), and the adopted agent-loop warning test behavior.

## 2026-09-26 resume: daemon-cli compat retirement (proof-fix for 04:48Z FAIL)

Upstream #104650 (8fe6ac7fb9f) retired the pre-2026.4 daemon-cli compat surface: deleted `scripts/write-cli-compat.ts` + `src/cli/daemon-cli-compat.ts`, and new tsdown chunking no longer emits a root-level `daemon-cli-*` bundle → kept fork shim writer threw "No daemon-cli bundle found in dist" (sole red lane at 04:48Z; all tsgo lanes + vitest were green). Verdicts:

- `scripts/write-cli-compat.ts` + `src/cli/daemon-cli-compat.ts` — DELETED (ADOPT-UPSTREAM). Compat module's only importer was the writer itself; no src/test/deploy consumer of the emitted `dist/cli/daemon-cli.js` shim (fork deploys via git+build midnight cron, not npm update).
- `scripts/build-all.mts` — removed `build:plugin-sdk:dts` step + `PLUGIN_SDK_DTS_CACHE_INPUTS` const (fork-only, fed the shim writer; package.json script KEPT — upstream ships it and cron-test-gate.sh uses it as the tsc gate; it maps to `write-plugin-sdk-entry-dts.ts`, which stays). Removed `write-cli-compat` nodeStep + every profile reference.
- `scripts/build-all.mts` — collapsed duplicate profile keys `gatewayWatch`/`qaRuntime`/`sourcePerformance`/`cliStartup` (union artifact from an earlier batch, pre-existing on main; upstream variants were already last-wins at runtime, fork arrays were dead code). strictSmoke/pluginSdkStrictSmoke now upstream shape exactly.
- `scripts/build-all.mts` — restored `write-unified-entry-dts` to the inlined `full` deploy profile (pre-existing drift: fork full lacked it while FULL_BUILD_STEP_LABELS derived it; stamp-last deploy contract unchanged).
- `test/scripts/build-all.test.ts` — expectations aligned (full/ciArtifacts without dts+compat; gatewayWatch/cliStartup without compat; package literal gained write-unified-entry-dts, stale vs upstream derivation). Scoped run 101/101 green locally — the 7 pre-existing main-baseline failures in this file are FIXED by this landing.

## 2026-10-03 batch 5 resume (upstream 7d2e0fde, bounded batch 200 of 652, base fc12c47da1)

Preflight 20:32 left tsgo:core=19 after merge commit 60b7d0f878f. All 19 traced to 8 drift clusters; resolved:

- `packages/gateway-protocol/src/schema/agents-models-skills.ts` — ENHANCE-OURS: grafted upstream `agentId: Type.Optional(NonEmptyString)` into all SkillsInstallParams (3) + SkillsUpdateParams (2) members. Upstream's agent-scoped resolveSkillsAgentWorkspace({agentId?}) was adopted while the fork-kept schema lacked the field → weak-type TS2345 ×3 (validator would also strip it). Fork-only acknowledgeClawHubRisk retained; protocol.schema.json regenerated.
- `src/infra/exec-approvals-core.ts` — ENHANCE-OURS: re-grafted fork `normalizeExecHost` (fork delta was just the export keyword; upstream removed the fn; fork bash-tools.exec-runtime.ts re-exports it; exec-approvals.ts star-export covers the chain).
- `src/gateway/server-methods/session-run-interruption.ts` — ADOPT-UPSTREAM adaptation: upstream daa9ee37ade unified worker inference control (deleted inference-control.ts + its service members); fork-only consumer migrated to `getWorkerInferenceSessionControl(...)?.hasSession()` — the same API the upstream-rewritten sessions-compact.ts uses.
- `src/auto-reply/reply/agent-runner-execution.types.ts` — KEEP-OURS: restored fork's `kind:"completed"` internal branch in AgentTurnInternalResult (resolution had swapped in upstream's SettledAgentTurn-as-internal; all fork consumers produce/read the completed flat-fallback shape → 5 errors). SettledAgentTurn type itself unchanged; upstream doc comments kept.
- `src/agents/embedded-agent-runner/run.ts` (~2267) — ADOPT-UPSTREAM: fork call site now passes defaultProvider/defaultModel/expectedSelection to clearLiveModelSwitchPending (mirrors the resolved attempt-recovery.ts call; all values in scope).
- `src/agents/embedded-agent-subscribe.handlers.types.ts` + `run-state.ts` — ENHANCE-OURS: grafted upstream `answerSegments` field (+ AssistantMessage import) and `answerSegments: []` init. Fork never populates it (fork removed the segment machinery; upstream expressions degrade on empty per settled-turn-finalization comment).
- `src/agents/tools/nodes-tool.ts` — KEEP-OURS: restored fork's full options surface (agentChannel/agentAccountId/currentChannelId/currentThreadTs) onto upstream's createNodesTool (fork openclaw-tools.ts passes them → excess-property TS2353; declared-not-used at fork too).
- `src/workboard/sessions-board-rules.ts` + `packages/workboard-contract/src/sessions-board.test.ts` — git rm (KEEP-OURS): orphaned salvage port of upstream #163823 extensions/workboard rules had zero consumers and imported contract types the fork doesn't carry; the adopted test imports the nonexistent sessions-board.js module. Fork ships no sessions-board feature (standing policy: upstream workboard features not shipped; fork workboard = core src/workboard/).

tsgo:core 19→0 locally (cache cleared).

## 2026-10-06 bounded-batch merge (e25a9815, advance 200 of 1091)

- `extensions/workboard/**` + `packages/workboard-contract/src/sessions-board.{ts,test.ts}`: **KEEP-OURS** deletion — fork product decision 14e83c5185e (replaced by core `src/workboard/`); upstream delta since base = sidebar feat #164604 + deslop refactors on the abandoned tree; zero `sessions-board` importers outside it.
- `src/cron/service.pr-automation.test.ts`: **KEEP-OURS** deletion — UI-coupled to dropped `ui/src/lib/session-pr-automation-spec.js` (fork ui policy).
- `src/agents/tools/sessions-list-title.test.ts`: **ADOPT-UPSTREAM** — imports all resolve in merged tree, feature (sessions-list title) in fork production; prior deletion was unledgered 10-04 merge debt.
- `src/agents/provider-request-config.ts` (+ new `.types.ts`): **ADOPT-UPSTREAM** module split; grafted fork `maxConcurrentRequests` (provider-concurrency-gate) into `.types.ts` + sanitize/merge/policy fns.
- `src/agents/embedded-agent-runner/post-compaction-loop-guard.ts`: **ENHANCE-OURS** — fork `ToolLoopPostCompactionGuardConfig` windowSize feature on upstream deslop scaffold.
- `src/cron/types.ts`: **ENHANCE-OURS** — keep fork-required `export type CronTrigger`, adopt upstream `SchemaContract` wire-derived def (shape-identical: script/once).
- `src/agents/tool-catalog.ts`: **ADOPT-UPSTREAM** `portal` tool entry; fork exports kept via drift rebase.
- `src/gateway/methods/core-descriptors.ts`: **ADOPT-UPSTREAM** +5 new method rows (sessions.files.assets, worktrees.recoverRemoval/retireSnapshot, sessions.processes.list/stop).
- `src/agents/system-prompt.ts`: **ENHANCE-OURS** — kept fork helper extraction; ported upstream's 3 embed-text edit groups into `buildWebchatCanvasSection`.
- `src/transcripts/summary.ts`: **ENHANCE-OURS** — upstream SchemaContract derivation + fork persistence fields incl. memory-l3 `embedding`.
- `extraparams-resolve.test.ts`: **ADOPT-UPSTREAM** parameterized alias table (subsumes fork list-shape tests; merged config is entries-only) + grafted 2 fork-unique tests.
- `run-fallback-policy.test.ts`: **UNION** — fork base + 5 upstream-unique tests (production identical both sides).
- `ssh-backend.test.ts` / `agents-mutate.test.ts` / `run-node.test.ts` / `experience-review.apply.test.ts` / `build-all.test.ts`: upstream additions on fork scaffold (run-node: + upstream cast cleanup; experience-review: fork forge/seed flow kept, dual-key skills type admits both).
- merge=ours drift (11 files) rebased onto upstream w/ fork delta re-applied; protocol-gen + kysely + lockfile regenerated clean.

## 2026-10-06 17:36Z resume: startup-JS budget block — root cause isolated (DO NOT re-derive)

Branch fully resolved: 0 conflicts; huey proof of 52b092a82ed shows all 7 tsgo lanes
new=0 (core 0/0, extensions 3/3, core:test 115/113, extensions:test 11/11, test:src
115/113, test:ui 0/0, test:packages 0/0). Sole red gate = control-ui startup budget:
measured 626209 B / 30 requests vs enforcement 591116 B (baseline 590540 + growth 512

- variance 64) and committed-baseline cap 590848 B (577 KiB). BUILD_EXIT=1 on both
  proofs (12:09Z, 15:59Z). NOT a merge bug — upstream architecture, root cause chain:

  src/agents/internal-runtime-context.ts (client-path on main; upstream-modified)
  → packages/agent-core/src/harness/messages.ts (NEW to client graph; value-imports
  the @openclaw/llm-core barrel for hasRuntimeContextMarker)
  → barrel re-exports llm-core/validation.ts (typebox Compile/Pointer) and
  normalization-core/json-schema.ts (typebox Guard/Check)
  → 5 new pure-typebox foundation chunks = 36606 B gzip (sourcemaps are 100% typebox);
  7 new foundation chunks total; requests 28 → 30.

main shipped ZERO typebox client-side (verified: no typebox source in any main startup
chunk map; the barrel was not in main's client graph). sideEffects audit: llm-core /
normalization-core / agent-core package.json have NO sideEffects flag on upstream tip AND
main alike (gateway-protocol has sideEffects:false on all three) — nothing was dropped by
the merge. Upstream's own client (~372 KB startup) ships typebox the same way.

MAINTAINER DECISION REQUIRED (playbook hard-block; first flagged 05:35Z, evidence now complete):
A) ACCEPT upstream architecture — commit baseline 626209 B, raise the cap 577 → 612 KiB
(+6.1%), then finish-land. Zero divergence; next batches keep this weight (client-side
wire validation is upstream's direction).
B) TRIM — keep typebox out of the client graph. Estimated 626209 − 36606 = 589603 B / 25
requests: under the CURRENT 591116 B limit by only ~1.5 KB. Cleanest shape is
sideEffects:false on llm-core + normalization-core package.json (fork-side, 2 lines,
needs a browser smoke that runtime-context markers still render), or narrowing the
messages.ts barrel import. Both are fork divergence on upstream hot files that will
re-drift every future merge.
RECOMMENDATION: A — fighting the bundler graph fork-side recreates the frozen-file
disease for ~1.5 KB of headroom that the next batch will eat. If 612 KiB is unpalatable,
pair A with a fork-UI startup trim follow-up (lazy views), decided separately.

Worktree left resumable at 52b092a82ed (clean tree, no merge in progress). Next run:
if the maintainer decision is recorded below this line, apply it and finish-land;
otherwise report the same block and DO NOT re-run the ~10-minute huey proof on an
unchanged branch (two identical red verdicts already on file).

## 2026-10-07 13:35Z resume: all tsgo lanes green on huey; budget block unchanged (decision still pending)

09:40Z session ported remaining e25a981 batch drift onto the fresh 2026-10-07 merge
(aef316ab36d: system-prompt.ts + transcripts/summary.ts fork deltas + 3 test files);
its 12:19Z proof caught 3 net-new tsgo errors (ssh-backend.test.ts TS2304
setActiveDegradedSecretOwners, summary-embeddings.test.ts TS2322 x2) — fixed in
1f6097af92e. 13:27Z proof of 1f6097af92e: ALL 7 tsgo lanes new=0 (core 0/0,
extensions 3/3, core:test 113/115, extensions:test 11/11, test:src 113/115, test:ui
0/0, test:packages 0/0), no NEWFAIL. Sole red: BUILD_EXIT=1 = the SAME startup-JS
budget block (measured 611.5 KiB / 30 requests vs 577.3 KiB limit, 590848 B cap;
typebox-in-client root cause per the 2026-10-06 entry — do NOT re-derive). test:fast
was SIGTERM'd at the poller timeout (exit 143) and never completed — the behavior
gate is still owed at land time, as is autoreview. MAINTAINER DECISION still
unrecorded: A) accept upstream client typebox — baseline 626209 B, cap 577→612 KiB
(recommended) vs B) trim (≈589603 B, fork divergence on upstream hot files). Branch
pushed to origin with this entry. main untouched (fbf8ba16758). True backlog 1424
first-parent commits behind full tip (bounded batch stays e25a9815054). Next run:
if the decision is recorded, apply it and finish-land; else report the same block,
no re-proof (identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07).

## 2026-10-07 16:35Z resume: decision check only — block stands

Checked all record surfaces: no ledger entry below the decision line; zero main commits
after 13:35Z; budget baseline on main still 590540/590848 (2026-09-29 state); memory has
no maintainer verdict. Decision A (accept upstream client typebox, baseline 626209 B,
cap 577→612 KiB) vs B (trim, ≈589603 B) remains UNRECORDED. Per the 13:35Z entry: no
re-proof on the unchanged branch (third identical verdict adds nothing), no land, no
fresh merge of the same e25a9815 batch this branch already resolves. Branch re-pushed
unchanged apart from this entry. main untouched (fbf8ba16758).

## 2026-10-08 00:35Z resume: decision check only — block stands

Fourth check. All record surfaces re-verified: no entry below the decision line; main
advanced only with daily-research QW commits (fbf8ba16758 tip) — no budget change;
baseline on main still 590540 B / cap 590848 B (updatedAt 2026-09-29); workspace memory
records the same A/B options (2026-10-06 daily) with no maintainer verdict. Decision
A (accept upstream client typebox, baseline 626209 B, cap 577→612 KiB, recommended) vs
B (trim startup path, ≈589603 B) remains UNRECORDED. No re-proof on the unchanged
branch (identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07), no land,
no fresh merge of the same e25a9815 batch. Branch re-pushed with this entry. main
untouched (fbf8ba16758).

## 2026-10-08 02:37Z resume: decision check only — block stands

Fifth check. All record surfaces re-verified: no entry below the decision line; main
unchanged (fbf8ba16758); baseline on main still 590540 B / cap 590848 B (updatedAt
2026-09-29); no workspace-memory daily for 10-07/10-08 (no verdict). Decision A
(accept upstream client typebox, baseline 626209 B, cap 577→612 KiB, recommended)
vs B (trim startup path, ≈589603 B) remains UNRECORDED. No re-proof on the unchanged
branch (identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07), no
land, no fresh merge of the same e25a9815 batch. Branch re-pushed with this entry.
main untouched (fbf8ba16758).

## 2026-10-08 04:35Z resume: decision check only — block stands

Sixth check. All record surfaces re-verified: no ledger entry below the decision line;
main unchanged (fbf8ba16758, zero commits since 02:37Z); baseline on main still
590540 B / cap 590848 B (updatedAt 2026-09-29); no workspace-memory daily for
10-07/10-08 (2026-10-06 daily records the block, no verdict). Decision A (accept
upstream client typebox, baseline 626209 B, cap 577->612 KiB, recommended) vs B
(trim startup path, ~589603 B) remains UNRECORDED. No re-proof on the unchanged
branch (identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07), no
land, no fresh merge of the same e25a9815 batch. Branch re-pushed with this entry.
main untouched (fbf8ba16758).

## 2026-10-08 05:35Z resume: decision check only — block stands

Seventh check. All record surfaces re-verified: no ledger entry below the decision
line; main unchanged (fbf8ba16758, MAIN-SYNC in sync); origin staging == local
(d82a0a1ad61, clean tree); baseline on main still 590540 B / cap 590848 B
(updatedAt 2026-09-29); no workspace-memory daily for 10-07/10-08 (2026-10-06 daily
records the block, no verdict). Decision A (accept upstream client typebox,
baseline 626209 B, cap 577->612 KiB, recommended) vs B (trim startup path,
~589603 B) remains UNRECORDED. No re-proof on the unchanged branch
(identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07), no land,
no fresh merge of the same e25a9815 batch. Branch re-pushed with this entry.
main untouched (fbf8ba16758).

## 2026-10-08 07:35Z resume: decision check only — block stands

Eighth check. All record surfaces re-verified: no ledger entry below the decision
line; main unchanged (fbf8ba16758, local == origin); baseline on main still
590540 B / cap 590848 B (updatedAt 2026-09-29); no workspace-memory daily for
10-07/10-08 (2026-10-06 daily records the block, no verdict). Decision A (accept
upstream client typebox, baseline 626209 B, cap 577->612 KiB, recommended) vs B
(trim startup path, ~589603 B) remains UNRECORDED. No re-proof on the unchanged
branch (identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07),
no land, no fresh merge of the same e25a9815 batch. Branch re-pushed with this
entry. main untouched (fbf8ba16758). Backlog now 1673 first-parent commits
behind the full upstream tip; batch stays e25a9815054.

## 2026-10-08 09:35Z resume: decision check only — block stands

Ninth check. All record surfaces re-verified: no ledger entry below the decision
line; main unchanged (fbf8ba16758, local == origin); baseline on main still
590540 B / cap 590848 B (updatedAt 2026-09-29); no workspace-memory daily for
10-07/10-08 (2026-10-06 daily records the block, no verdict). Decision A (accept
upstream client typebox, baseline 626209 B, cap 577->612 KiB, recommended) vs B
(trim startup path, ~589603 B) remains UNRECORDED. No re-proof on the unchanged
branch (identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07),
no land, no fresh merge of the same e25a9815 batch. Branch re-pushed with this
entry. main untouched (fbf8ba16758). Backlog now 1708 first-parent commits
behind the full upstream tip; batch stays e25a9815054.

## 2026-10-08 13:35Z resume: decision check only — block stands

Tenth check. All record surfaces re-verified: no ledger entry below the decision
line; baseline on main still updatedAt 2026-09-29 (590540 B / cap 590848 B);
2026-10-08 daily now exists (deploy testgate hold note — a SEPARATE pending
decision) and carries no A/B verdict; 2026-10-06 daily remains the only block
record; MEMORY.md and reports carry no verdict. Decision A (accept upstream
client typebox, baseline 626209 B, cap 577->612 KiB, recommended) vs B (trim
startup path, ~589603 B) remains UNRECORDED. No re-proof on the code-unchanged
branch (identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07),
no land, no fresh merge of the same e25a9815 batch. NEW since ninth check: main
advanced +3 to e11f53338a5 (daily-research memory-l3 only; 13:36Z route
MAIN-SYNC pushed them to origin) — the branch no longer contains main, so the
land sequence once the decision is recorded is: stage-resume (absorb main) ->
apply A/B -> preflight + huey proof (test:fast behavior gate + autoreview still
owed at land time) -> finish-land. Branch re-pushed with this entry. Backlog
1773 first-parent commits behind full tip eea11f9739d; batch stays e25a9815054.

## 2026-10-08 16:35Z resume: decision check only — block stands

Eleventh check. All record surfaces re-verified: no ledger entry below the
decision line; baseline on main still updatedAt 2026-09-29 (590540 B / cap
590848 B); 2026-10-08 daily carries only the deploy-testgate hold note (a
SEPARATE pending operator decision, day 6) and no A/B verdict; 2026-10-06
daily remains the only block record; MEMORY.md carries no verdict; origin/main
@ e11f53338a5 unchanged since 13:36Z and origin staged branch == local @
9b2510eb5a7 — maintainer has not touched either. Decision A (accept upstream
client typebox, baseline 626209 B, cap 577->612 KiB, recommended) vs B (trim
startup path, ~589603 B) remains UNRECORDED. No re-proof on the code-unchanged
branch (identical-tree verdicts on file: 12:09Z, 15:59Z 10-06; 13:27Z 10-07),
no land. DEVIATION NOTE: 16:37Z stage-init (run before this session read the
log) reclaimed the worktree and briefly created resync-staging/2026-10-08 as a
fresh unresolved merge of the same e25a9815 batch — aborted and branch deleted
within the same session; worktree restored to THIS branch, no resolution
redone, no huey cycle burned. Land sequence once the decision is recorded is
unchanged: stage-resume (absorb main) -> apply A/B -> preflight + huey proof
(test:fast behavior gate + autoreview still owed at land time) -> finish-land.
Branch re-pushed with this entry. Backlog 1816 first-parent commits behind
full tip 1fe2aa03fe4; batch stays e25a9815054.

## 2026-10-08 21:43Z resume: twelfth decision check — block stands; fresh 10-08 re-stage resolved + locally green

Twelfth check. All record surfaces re-verified: no ledger entry below the decision
line (staged ledger @ d15bfe03f84); baseline on main still 590540 B / cap 590848 B
(unchanged since 2026-09-29); origin/main @ e11f53338a5 unchanged; the 2026-10-08
daily carries only the separate deploy-testgate hold note; no maintainer verdict
anywhere. Decision A (accept upstream client typebox, baseline 626209 B, cap
577->612 KiB, recommended) vs B (trim startup path, ~589603 B) remains UNRECORDED.

State change vs the eleventh check: 20:37Z stage-init reclaimed the stale 10-07
branch and re-staged the SAME e25a9815 batch from baseline e11f53338a5
(resync-staging/2026-10-08). Resolution redone: merge f23c896ed09 + 3c3ca22ef73
(new tsgo:test:src errors from the newer baseline fixed: agents.entries migration,
DI rebases, roster API, breaker graft). The 20:53Z STAGE-PREFLIGHT FAIL was the
pre-fix tree; this session re-ran preflight on 3c3ca22ef73 at 21:40Z: PASS,
tsgo:core=0 (conflict markers, merge=ours export gate, protocol-gen all green).
The 21:26Z stage-finish re-run was killed by the exec-session reaper ~10 min in —
no huey verdict, no push; this entry completes that interrupted cycle.

No huey proof run, per standing instruction: the sole red lane (startup-JS budget
626209 B/30 req vs cap 590848 B) is structural to the upstream batch + main's cap
(three identical verdicts on file: 10-06 12:09Z/15:59Z, 10-07 13:27Z). NOTE: this
10-08 tree is NOT identical to the proven 10-07 tree (newer baseline + new
resolution), so the tsgo:test / test:fast verdicts do NOT carry — full preflight +
huey proof still owed at land time; local preflight (tsgo:core=0) is the only
verdict on file for this exact tree. No land (cap raise is a playbook hard-block).

Ledger decision-line + check history carried forward from the 10-07 staged copy
(d15bfe03f84; purely additive over main's 2026-10-03 ledger, 0 removed lines) so
the newest pushed staging branch remains the maintainer's single decision surface.
Backlog 1907 first-parent commits behind full tip 409cef15bea (was 1816 at the
eleventh check today, 1346 at 10-07 04:40Z); batch stays e25a98150544. Land
sequence once the decision is recorded is unchanged: stage-resume (absorb main) ->
apply A/B -> preflight + huey proof (test:fast behavior gate + autoreview owed at
land time) -> finish-land.

## 2026-10-09 02:40Z resume: thirteenth decision check — block stands

Thirteenth check (02:40Z, ~5h after the twelfth). All record surfaces re-verified:
no ledger entry below the decision line (staged branch on origin still @
383b1f41804 — maintainer has not pushed); baseline on main unchanged
(590540 B / cap 590848 B, updatedAt 2026-09-29); origin/main @ e11f53338a5
unchanged since 10-07 13:36Z; MEMORY.md carries no verdict; 2026-10-08 daily
still carries only the separate deploy-testgate hold note; 2026-10-06 daily
remains the only block record. Decision A (accept upstream client typebox,
baseline 626209 B, cap 577->612 KiB + startupJsRequests 28->30, recommended)
vs B (trim startup path, ~589603 B) remains UNRECORDED. Branch unchanged from
383b1f41804 (clean tree, no merge in progress; local preflight PASS verdict
on 3c3ca22ef73 carries — 383b1f41804 added only this ledger). No huey proof
re-run on the unchanged branch (standing instruction; structural budget red,
three identical verdicts on file); full preflight + huey proof (test:fast +
autoreview) owed at land time. No land (cap raise is a playbook hard-block).
Route tonight measured backlog 1977 first-parent commits behind full tip;
batch stays e25a98150544. Land sequence once the decision is recorded is
unchanged: stage-resume (absorb main) -> apply A/B -> preflight + huey proof
-> finish-land.

## 2026-10-09 03:40Z resume: fourteenth decision check — block stands

Fourteenth check (03:40Z, ~1h after the thirteenth). All record surfaces
re-verified: no ledger entry below the decision line (staged branch on origin
still @ 2d7302f31ba — maintainer has not pushed); origin/main @ e11f53338a5
unchanged since 10-07 13:36Z; baseline on main unchanged (590540 B / cap
590848 B, updatedAt 2026-09-29); MEMORY.md re-grepped — no verdict; no
2026-10-09 daily; 2026-10-08 daily carries no budget decision. Decision A
(accept upstream client typebox, baseline 626209 B, cap 577->612 KiB +
startupJsRequests 28->30, recommended) vs B (trim startup path, ~589603 B)
remains UNRECORDED. Branch unchanged from 2d7302f31ba (clean tree, no merge
in progress; local preflight PASS verdict on 3c3ca22ef73 carries — ledger
commits since added only text). No huey proof re-run on the unchanged branch
(standing instruction; structural budget red, three identical verdicts on
file: 10-06 12:09Z/15:59Z, 10-07 13:27Z); full preflight + huey proof
(test:fast + autoreview) owed at land time. No land (cap raise is a playbook
hard-block). Route tonight measured backlog 1988 first-parent commits behind
full tip 15305ccd53 (1977 at the thirteenth); batch stays e25a98150544. Land
sequence once the decision is recorded is unchanged: stage-resume (absorb
main) -> apply A/B -> preflight + huey proof -> finish-land.

## MAINTAINER DECISION RECORDED 2026-10-09 ~03:50Z (joederas, via Claude Code session): **Option A — accept upstream client typebox**

The maintainer approved decision A for the Control-UI startup-JS budget block
(2026-10-06 root cause: upstream architecture ships typebox via
internal-runtime-context.ts -> agent-core/harness/messages.ts -> @openclaw/llm
barrel -> validation/json-schema; NOT a merge bug):

- Raise the fork startup-JS cap 577 KiB -> 612 KiB (626,688 B) and
  startupJsRequests 28 -> 30, in the fork-owned checker/budget files
  (check-control-ui-performance.mts + budget baseline JSON, KEEP-OURS).
- Set the committed baseline to the measured value at land time (~626,209 B
  per the 10-06/10-07 proofs; re-measure if the land-time build differs).
- Do NOT trim or lazy-load typebox (option B rejected: permanent fork
  divergence on hot upstream files re-conflicting every batch outweighs
  ~1.5 KiB headroom).
- The startup-JS gate still blocks future growth past the new 612 KiB cap;
  headroom after this land is ~479 B over the 626,209 B measurement.

Standing instruction satisfied: on this recorded decision, the next run may
apply A and proceed stage-resume (absorb main) -> apply A -> local preflight
-> huey proof (test:fast + autoreview) -> finish-land for batch
e25a98150544, then continue the bounded-batch loop toward full-tip
convergence (~1988 first-parent behind at the fourteenth check).


## 2026-10-09 application (nightly run)

Applied DECISION A on a fresh stage of the same batch e25a9815054: overlay of the
2026-10-08 resolved tree (merge f23c896 + tsgo fix 3c3ca22) onto tonight's merge
of main f47b469f82d (which adds the scheduled-messages admitScheduledInvocation
fix — kept from main; yesterday's tree predates it). 27 conflicts resolved from
the recorded resolutions (workboard extension + sessions-board contract kept
deleted per standing decision). Decision A applied: checker cap 577->612 KiB,
startupJsRequests 28->30, baseline 626209 B (measured). Regen clean (kysely .mts
renamed script, protocol-gen unchanged). Next: preflight + huey proof + finish-land.
