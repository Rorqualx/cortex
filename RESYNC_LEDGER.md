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
