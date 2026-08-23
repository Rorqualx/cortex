# Upstream-Resync Cron Resolution Playbook

Operational companion to `.claude/skills/openclaw-upstream-resync/SKILL.md`. The skill owns the
_reintegration project_ mental model (merge=ours trap, keystone types, provenance recipes, union
trap, per-change rubric). **This file owns the hourly-cron reality**: the exact scripted flow the
`cron-upstream-merge.sh` resolution agent lives inside, plus the hard-won gotchas the skill omits.
Read the skill first; do not re-derive what it already says. Everything here is concrete.

Environment invariants (verified 2026-08-22, `/Users/joederas/Documents/Cline/code/claudy/openclaw`):

- `origin` = `github.com/Rorqualx/cortex.git` · `upstream` = `github.com/openclaw/openclaw.git`
- `main` IS the production deploy trunk (live gateway runs from `dist/`; commit+build+restart = deploy).
- Nightly/hourly worktree: `../openclaw-upstream-nightly` (`$MAIN-upstream-nightly`), branch `resync-staging/<date>`.
- huey Linux prover: `joe@192.168.50.185`, Node 24 at `/home/joe/node24/bin` (NOT node22 — 22.19.0 fails install; upstream needs ≥22.22.3).
- `merge.ours.driver=true` is set (verified) — without it every `merge=ours` is a silent no-op.
- `.gitattributes` carries **257** `merge=ours` globs.
- Rollback tag written before any land: `main-backup-pre-upstream-merge` (+ `upstream-merge-<date>`).
- Deploy cron job id (excluded from quiesce): `9d1cec60-4db3-4c7c-a0da-447b7bcf26ce`.
- Startup-budget baseline file: `config/control-ui-startup-budget-baseline.json` (currently 585538 B; hard ceiling **589824** B = 576 KiB).

---

## 1. Hourly workflow (exact ordered steps)

The cron is deterministic except one branch. `route` (default) does: fetch → freeze upstream sha →
measure residual via the shadow engine → route:

- **behind==0** → `UP-TO-DATE`, exit 0, main untouched.
- **residual==0** → `land_clean`: real merge in worktree, apply ui-ownership, `preflight`, huey proof, and only on PASS: rollback-tag, ff main, regen baseline, push, deploy. Fully autonomous.
- **residual>0** → **exit 20 `NEEDS-RESOLUTION`** — this is the only path the LLM agent owns.

When you (the agent) get NEEDS-RESOLUTION, do this:

**Step 0 — stage.** Never run the merge by hand; let the cron stage it so pins/ui-ownership/reports are produced:

```
bash scripts/cron-upstream-merge.sh stage-init            # date defaults to today
```

This: freezes upstream, `fresh_worktree` (keeps node_modules), `checkout -B resync-staging/<date>`,
runs `git merge --no-commit --no-ff <frozen-upstream>` with `-c rerere.enabled=false`, applies
`apply_fork_ui_ownership`, writes stage pins (`refs/upstream-merge-pin/<branch>/{upstream,baseline}`),
and prints: the non-ui conflict list, the classified work queue (`resync-ledger.mjs`), the merge=ours
drift report (ranked, export-surface first), the dropped-upstream-files report, and the merge base.
If a same-day branch already has commits it prints `STAGE-RESUME`/`STAGE-RECLAIM` instead — resume, don't restage.

**Step 1 — resolve in the worktree `../openclaw-upstream-nightly`.** Edit-only; do not run git/tsgo from subagents (index races). Reconcile **NON-ui** conflicts in foundation order (protocol/packages → config+sessions/state → agents core+runner → gateway/infra/cron → channels+plugin-sdk → core features → extensions). ui/ is already resolved by policy (§3). Apply §2 rubric per hunk.

- 3-way "take ours" must read `git show <STAGE_OURS_REF>:<path>`, **never HEAD** (HEAD is already the lossy merge result → an apply reports clean and restores nothing). `STAGE_OURS_REF` is the pinned baseline (printed as `STAGE-PINS baseline=...`).
- Re-apply a fork delta with `git merge-file -q -L ours -L base -L upstream ours base upstream` — **never `git apply -3` mid-merge** (index holds the merge=ours result → `does not match index`, 0/N applied, reads as N phantom conflicts).
- After every re-apply, `git grep` a known fork marker back — a silent no-op apply is indistinguishable from a real one until tsgo runs.
- Rebase provider-before-consumer; measure tsgo before/after each batch (unattributed fixes hide which change helped).

**Step 2 — graft keystone shared types first (§2).** Most cascades collapse here. Then regenerate derived files, don't hand-merge them: `pnpm-lock.yaml` → `pnpm install --no-frozen-lockfile` then `git add pnpm-lock.yaml`; protocol via `node --import tsx scripts/protocol-gen.ts`.

**Step 3 — commit the resolution in the worktree** (must be marker-free, nothing unstaged; `resolve_staged_branch` refuses otherwise).

**Step 4 — local preflight + huey proof + land, in ONE command.** Choose the terminal subcommand:

```
bash scripts/cron-upstream-merge.sh finish-land          # converged, no product-collision → prove + ff-land + DEPLOY (autonomous)
bash scripts/cron-upstream-merge.sh stage-finish         # flagged a convergent product-collision → prove + push + STOP with the land command for the maintainer
```

Both call `resolve_staged_branch` (loads pins) → `prove_staged` (`preflight` local, then `remote-proof.sh` on huey). `finish-land` then `land_and_deploy`. `stage-finish` pushes and prints `git -C $MAIN checkout main && git -C $MAIN merge --ff-only <branch>`.

**`preflight` gate order (fails fast, cheap→expensive):** conflict-marker scan (`*.ts,tsx,mjs,json,yaml,yml,swift,kt,sh`) → degenerate-drift-base refusal → **merge=ours export-drift gate** → worktree deps → **protocol-gen** (catches dropped exports tsgo can't) → `tsgo:core`: reject on any `TS1xxx` (syntax aborts the count) → reject on `TS2440/2323/2484` (union trap, names owning files) → count vs baseline 0. rc 3 = DEFER (local install failed — not a verdict on the merge); rc 1 = FAIL; rc 0 = PASS.

**When to call which terminal command:** default to `finish-land`. Route to `stage-finish` only for a _convergent product-collision you must not auto-pick_ (workboard fork-loop vs upstream ops-UI, codex fork-stripped vs upstream-expanded, agent-loop steering vs upstream deferred-hydration, or any `extensions/codex/**` residual you can't confidently converge — Codex is owner-gated, inspect `../codex` first). Red/entangled proof → stop and report.

---

## 2. Reconciliation decision rubric (concrete)

For each convergent hunk pick exactly **one** of four; log the verdict in `RESYNC_LEDGER.md`:

- **ADOPT-UPSTREAM** — fork code was incidental; take upstream, graft the one fork helper back. E.g. `extensions/openshell/src/cli.ts` (2026-08-20): upstream extracted `buildRemoteCommand` into `plugin-sdk/sandbox` byte-identical to the fork's local copy → drop the fork copy (was a union-trap), take upstream's narrower `applyGatewayEndpointToSshConfig`.
- **ENHANCE-OURS** — graft upstream's fix/perf/field into the fork version, keep fork behavior. E.g. `sessions-patch-result.ts` (08-22): keep fork `session-row.js` `GatewayAgentRuntime` import (upstream relocated it) AND graft upstream #127951 `contextWindow`/`contextWindows` so the result stays a superset. `agent-bundle-mcp-materialize.ts` (08-20): fence upstream's sanitized `publicValue` instead of raw `params.value` — keeps the fork's untrusted-MCP fence and fixes a latent fork bug.
- **KEEP-OURS** — fork behavior is the point and upstream's change is incompatible; **cite why**. E.g. `control-ui-startup-budget-baseline.json`: fork UI budget is fork-specific.
- **KEEP-BOTH (additive)** — both sides add _independent_ consts/fields, each consumed once. E.g. `build-all.mts` (08-22): fork `WINDOWS_BUILD_MAX_OLD_SPACE_MB`+`PLUGIN_SDK_DTS_CACHE_INPUTS` vs upstream #128007 `RUN_NODE_SKIP_DTS_BUILD_ENV`. `control-ui-bootstrap-contract.ts` (08-22): fork `timeFormat`/`chatMessageMaxWidth` + upstream #127711 `environment?`. **This is NOT the union trap** — the union trap is keeping both sides of the _same_ declaration.

### The union trap (never keep both sides of a redeclaration)

When upstream extracts a helper into a module and imports it while the fork still defines it locally, both hunks read as purely additive. Keeping both → file imports a symbol it also declares. Signatures: **TS2440** (import vs local), **TS2323** (redeclare exported), **TS2484** (export decl conflict); `preflight` fails with `reason=union-merge` and names the files. When you see it, re-resolve _those_ files (adopt the extraction and delete the local copies, OR keep the monolith and drop the imports) — do NOT start fixing the trailing `TS2304 cannot find name` cascade; they evaporate. History: 2026-07-27 one union-merge = 284 tsgo errors from 18 conflicts (57 collisions + 145 TS2304); 2026-07-06 dup declarations across 7 files. **Silent dup variant:** two top-level `function toJsonSafe` in a compiling file — tsgo does NOT emit TS2393 for it. After resolving, run a whole-tree dup-decl scan (all TS/Swift/Kotlin, not just conflict files); note an import-vs-local collision won't show in a declaration-only scan.

### Keystone shared-type cascade (highest-leverage move)

When a layer explodes with TS2741/2739/2339/2305 missing-property errors, the cause is almost always a few shared **type** files kept-ours that lack upstream's new fields. **Graft the types first; the cascade collapses.** Worked examples:

- **#127951 context-window switch (08-22):** merge adopted the consumer runtime but kept-ours the shared types → **29 cascading tsgo:core errors**. Grafting `contextWindow`/`contextWindows`/`contextWindowDefault` into `src/shared/session-types.ts` (new `GatewayContextWindowOption`), `src/gateway/session-utils.types.ts`, `packages/gateway-protocol/src/schema/agents-models-skills.ts` (`GatewayContextWindowOptionSchema`+`ModelChoiceSchema`), `src/config/sessions/types.ts` (`SessionEntry.contextWindow`), `src/plugins/session-entry-slot-keys.ts` (reserved-slot exhaustiveness guard) → 29→0.
- **#128018 logs-chat (08-22, merge=ours drift):** `packages/gateway-protocol/src/schema/logs-chat.ts` kept-ours while the upstream test was adopted → graft the 4 `Static<>` exports (`ChatHistoryParams/DeltaResult/ResetResult/CursorResult`) → `tsgo:test:packages` 4→0.
- Prior syncs: 5 UI type files (`app-view-state`, `ui-types`, `types`, `storage`, `sidebar-content`) cleared ~94 of 154 UI errors; `SessionListModelCatalog`, `EventCursorGap/EventPollResult/EventWaitResult`, `isLikelyMutatingToolName`.
- **Register the new SessionEntry slot key** in `src/plugins/session-entry-slot-keys.ts` whenever you add a top-level `SessionEntry` field, or you get an `AssertNever`/`not-in-never` error.
- **Restoring protocol schemas also needs their validators:** `validator-registry.ts` is NOT merge=ours (auto-merges to the fork's reduced set); re-adding a schema leaves `validateX` unresolved until the registry entry is ported (some are multi-line — a single-line regex misses them).

### merge=ours dropped-export / dropped-symbol drift

`merge=ours` keeps the whole FILE, not the delta, so upstream additions to a protected file vanish silently and adopted consumers break — **tsgo is blind** (the importer type-checks against the stale file). Only `protocol-gen` + the export-drift gate catch it. The technique to rebase a protected file onto upstream re-applying only the fork delta:

```
git checkout upstream/main -- <file>
git diff <merge-base> main -- <file> > /tmp/one.patch   # FORK delta only
git apply -3 /tmp/one.patch                              # WORKS pre-merge / out-of-merge only
# mid-merge (index holds ours) use merge-file instead:
git show <upstream>:<f> > up; git show <base>:<f> > base; git show main:<f> > fork
git merge-file -q -L upstream -L base -L fork up base fork   # exit 0 = clean; `up` now holds it
```

Caveat: this recovers only fork changes made _after_ the merge base. Fork-only symbols added while the file was frozen (e.g. `ChatSendTimingEventSchema`) are absent from the diff and must be re-added by hand from `main`.
When upstream substantially rewrote a merge=ours file, baseline on UPSTREAM not fork (`git merge-file -p UP BASE FORK`) or you duplicate upstream's parallel-invented lifecycle code (`subagent-registry.ts`: fork-baseline gave dup `phase==="error"` blocks → TS2367/TS2353).

### Adopted-consumer + kept-ours-provider splits (the recurring silent-loss class)

Auto-merge adopts an upstream consumer/test while merge=ours (or a same-region auto-merge) keeps the fork provider that dropped the symbol → runtime break, compiles clean. Restore the provider, don't weaken the consumer. Examples: `authorizeAuthenticatedProfileForMethod` security fence (08-22, caught only by autoreview); the CSS-ok marker `:root{--openclaw-css-ok:1}`; 175 `en.ts` i18n keys; `runToolLifecycle onImplementationStart` (#c3ec166 class); `normalizeLiveAssistantEventText` (MIRROR: fork-kept importer needs a fork symbol an upstream-adopted sibling dropped — the export-drift gate only checks the opposite direction, build catches this). Auto-merge also drops fork-only helpers from UNPROTECTED files when upstream rewrites the surrounding region (`canPromptForMessageTool`, `ensureRuntimePluginsLoaded`, `shouldUpdateRunOutcome`…) — budget for these on top of the drift count; finish all mechanical rebases first, then tsgo once and triage (chasing reactively re-derives context).

### When to DEFER (surface, don't auto-pick)

Interleaved flagship rewrites where both sides went incompatible directions: agent-loop steering/preempt vs upstream deferred-tool-hydration + `intentionalTermination` hardening (08-20: restored the fork mutation-tracking cluster, DEFERRED upstream `intentionalTermination`, left `toolMeta.toolCallId?/terminate?` unpopulated for the follow-up); workboard fork-LLM-loop vs upstream ops-UI; codex fork-stripped vs upstream-expanded. Default bias: **keep the fork's direction, make it internally consistent.** Route these to `stage-finish`.

### Prior-resync-pass debt looks like fork intent — check history

`git log <main> -- <file>` before honoring a fork deletion: if the reduction came from a _resync_ commit ("targeted port", "drop upstream-only test") not a feature commit, upstream may be a strict superset with zero fork importers → adopt it (e.g. `mistral.ts`, `mistral.test.ts`, `agent-loop.test.ts` were gutted by earlier passes).

---

## 3. ui/ ownership (policy, not judgment)

The fork ships the pre-rearchitecture `ui/src/ui/**` tree; upstream ships `ui/src/{pages,lib,api,app,components}/**`. Merging them makes an unbuildable hybrid and is ~92% of raw conflict volume (622 of 678 on 2026-07-25). The cron's `apply_fork_ui_ownership` handles it automatically at stage time: `git checkout main -- ui`, then `git rm` every upstream-only ui file (LC_ALL=C comm of `ls-tree main ui` vs `ls-files ui`). **Invariant: `HEAD:ui` tree hash == `main:ui` tree hash** (was `3f645486` on 08-22) — so every ui-only tsgo lane matches main's baseline by construction. If you must do it by hand:

```
git -C $WT checkout main -- ui
git -C $WT -c core.quotePath=false ls-tree -r --name-only main ui | LC_ALL=C sort > /tmp/ui-main.txt
git -C $WT -c core.quotePath=false ls-files -- ui | LC_ALL=C sort -u > /tmp/ui-index.txt
LC_ALL=C comm -13 /tmp/ui-main.txt /tmp/ui-index.txt | tr '\n' '\0' | xargs -0 git -C $WT rm -q -f --ignore-unmatch --
git -C $WT rev-parse HEAD:ui   # must equal `git -C $WT rev-parse main:ui`
```

LC_ALL=C on BOTH sort and comm is load-bearing — mismatched collation reported 447 phantom "dropped" files against a true 2. Adopting upstream's UI architecture is an open maintainer decision, not merge work. Desired upstream UI features (custodian alerts, github-identity auth view, cron-trigger authoring, resize-handles, chat-pane-placement) are ported by hand into `ui/src/ui` when the maintainer asks — a separate follow-up. When a fork-owned UI feature _is_ the point (github-identity 08-20), port the view to `ui/src/ui/views/...`, remap imports to fork equivalents, and VISUAL-verify on a live dashboard at land time.

---

## 4. Validation baselines (error-set diff, never exit codes)

The fork **never passes upstream CI** and deploys un-gated. Validate by **error-set diff vs the pinned main baseline**, not exit codes. `remote-proof.sh` does this on huey: builds the baseline (pre-cherry main) once (cached per-sha under `.proof-baseline-<sha>/`), then the candidate, and fails only on NET-NEW `error TS` per lane or NET-NEW failing test files. **Clear `.artifacts/tsgo-cache` between every lane** (incremental attribution flips counts between runs; the harness does this and re-runs any disagreeing lane once to filter post-build tsbuildinfo inflation).

Known lane baselines (proven main-identical on 2026-08-22; treat non-zero here as NOT merge-caused):

| Lane                   | Baseline | Source                                                                                                                       |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tsgo:core`            | 0        | since 2026-07-26 resync                                                                                                      |
| `tsgo:extensions`      | 0        |                                                                                                                              |
| `tsgo:test:packages`   | 0        |                                                                                                                              |
| `tsgo:test:ui`         | 0        | (after ui-ownership; == main by construction)                                                                                |
| `tsgo:core:test`       | 8        | 7× `agent-bundle-mcp-runtime.test.ts` strict-null (`ImageContent\|TextContent.text`) + 1× `system-prompt.test.ts` sessionUrl |
| `tsgo:test:src`        | 8        | same set                                                                                                                     |
| `tsgo:extensions:test` | 22       | memory-l3 `Signals` (entityScore/polarityMultiplier in test literals); memory-l3 untouched by merges                         |

To take a fresh baseline: worktree at the pre-merge commit, `rm -rf .artifacts/tsgo-cache`, run each lane, `comm -13` sorted-position-stripped error sets. `system-prompt.test.ts` sessionUrl is a long-standing baseline; the 7 `agent-bundle-mcp-runtime` errors are newer main drift (since 08-20) — both are fork follow-ups, not resync scope.

Other gates: `protocol-gen` clean (no dropped protocol exports). `fork-config-snapshot.mjs verify` — expect only additive drift (upstream deps like `koffi`, plugin-sdk export, tsconfig path); regenerate + re-verify after landing. Behavior: `pnpm test:fast` (excludes e2e/live) — expect a small set of environmental failures (path-compaction, filesystem-policy, sqlite-journaling); confirm env-coupled before dismissing.

---

## 5. Known flaky / env gotchas + their fixes

- **huey `audit-event-writer.test.ts` event-loop-delay flake.** "nonblocking under a held write lock" bounds event-loop delay; huey pays a **consistent ~420ms cold sqlite-native load** (measured idle AND under 24-core load — NOT contention; prod file + test byte-identical to main). It passes in remote-proof's cold baseline phase and false-fails as `NEWFAIL` in the hot candidate phase. **Fix already landed: bound widened to 3000ms** (a real sync block holds for seconds). An isolated-rerun flake-filter does NOT help — isolation is a _colder_ process. If it resurfaces as NEWFAIL, confirm the file is merge-untouched, then it's this flake.
- **control-ui startup-JS gzip budget bump (Linux-only signal).** Build fails on huey with startup JS gzip > baseline. ui/ == main, so growth is non-ui runtime bundled into the startup path (gateway-protocol schema additions + the commit delta). **Fix: bump `config/control-ui-startup-budget-baseline.json` `startupJsGzipBytes`** to the measured value, staying **under the 589824 B ceiling**, and write the `reason`. Mac cannot measure this — only the huey build catches it. (History: 580201→583689→585538.)
- **Stale huey proof flock.** Killing a `stage-finish`/`finish-land` locally leaves the detached huey job holding `/tmp/openclaw-proof.lock` (flock) — proof returns `EXIT=97` → `PROOF=UNAVAILABLE reason=proof-lock-held`. Free it: on huey `kill` the orphaned `remote-proof-<stamp>.sh` shell and its node/tsgo children, then re-prove.
- **Proof ref wedge.** `remote-proof.sh` force-updates `refs/remotes/proof/<branch>` (`+`) and prunes strays both sides — but a hand-run without `+` wedges a re-staged branch behind `EXIT=94` until you delete the ref on huey.
- **pnpm verify-deps hang / purge-abort (pnpm 11).** `pnpm build`'s pre-run install child wedges (stdin closed) OR nested `pnpm exec` aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`. The env var `npm_config_verify_deps_before_run=false` is UNRELIABLE (nested calls ignore it). **`verifyDepsBeforeRun: false` is now COMMITTED in `pnpm-workspace.yaml`** (line 126) — no add-and-revert dance needed anymore (this supersedes the older memory). For one-off direct CLI: `pnpm --config.verify-deps-before-run=false openclaw ...`.
- **node-llama-cpp / koffi Rosetta build block.** The gateway host is x64 (Rosetta) node. `node-llama-cpp`'s postinstall hard-fails any `pnpm install` under Rosetta. **`node-llama-cpp: false` and `koffi: false` are committed in `pnpm-workspace.yaml` `allowBuilds:`** — both build lazily at runtime if ever used (they aren't on this fork). Flip to true only on native arm64.
- **`pnpm build` wipes external plugins + control-ui.** build-all wipes/rebuilds `dist/extensions` (bundled plugins only) and `dist/control-ui`. Source-only provider plugins must NOT carry `openclaw.build.bundledDist: false` or a full build skips them → missing `dist/extensions/<p>/openclaw.plugin.json` → gateway exit-78 crash-loop (took down the default `zai/glm-5.2`; fixed 5309ebd9385). After a resync verify each enabled plugin's manifest survived: `for p in <enabled>; do [ -f dist/extensions/$p/openclaw.plugin.json ] || echo MISSING $p; done`. `kimi` has no in-repo source (npm/clawhub only) — stays disabled.
- **Gateway boot is genuinely ~90–150s** (opens ~8 per-agent SQLite DBs, each `slow ... database open`). The `gateway restart` CLI **times out at 60–73s with a FALSE "port still free" alarm.** Poll `lsof -iTCP:18789 -sTCP:LISTEN` up to ~3min; confirm `starting HTTP server`/`ready` in the log. **Do NOT run `gateway status` to check** — on this box it triggers a restart AND wipes `dist/control-ui`. Distinguish a real crash by grepping the log for `errorCode`/exit-78, not the CLI timeout.
- **x64 node for both build and runtime.** Deploy recipe uses x64 node (`/usr/local/opt/node`, v26.4.0) for build AND the service (native modules match, avoids the intermittent launchd-Rosetta startup deadlock). Only reinstate the arm64-runtime dance if the deadlock actually returns.
- **Deploy = the build crashes and relaunches the gateway.** The in-place `pnpm build` rewrites `dist/` and crashes the live gateway; launchd relaunches on the fresh dist. Never run it as a harness-tracked background task (it can be killed mid-`tsdown` → no build stamp, inconsistent bundle) — `cron-deploy-build.sh` handles detachment (`exec`) and the health watcher.
- **Syntax-error masking.** A single `TS1xxx` aborts the whole tsgo check → the count means nothing (one orphan `}` reported tsgo:core=1 while the tree had 284). `preflight` rejects on any `TS1xxx` before the count; when a count looks suspiciously low, delete syntax errors first.
- **BSD `sed` silently no-ops `\b`** (`sed -i '' 's/\bfoo\b/bar/'` exits 0 changing nothing) — use `perl -pi -e` or Python for exact-string edits.
- **Deploy scripts break on upstream file renames** (e.g. `build-all.mjs`→`build-all.mts`). Canonical build invocation is `node --import tsx scripts/build-all.mts`. After a resync grep the fork deploy scripts for stale renamed paths.

---

## 6. Deploy safety

`land_and_deploy` (shared by clean-auto and staged paths) enforces, in order:

1. **Re-fetch origin + ancestry check** — refuse to land if `origin/main` is not an ancestor of the ref (a push after main advanced would be rejected, leaving main advanced but undeployed). `DEFER reason=origin-ahead`.
2. **Rollback tags first:** `main-backup-pre-upstream-merge` and `upstream-merge-<date>` → main, before main moves.
3. **ff-only land** against local main (surfaces the real git error tail on failure — untracked-file collision, not just an ff race).
4. Regen `fork-config-baseline.json` + refresh generated plugin bundle artifacts (`extensions/canvas/.../.bundle.hash`, `extensions/diffs/assets/viewer-runtime.js`) — commit ONLY on generator success, else `git checkout --` restore (a truncated artifact would ship + dirty the tree → next run SKIPs).
5. **Push to origin BEFORE deploy (deploy-last).** The build crashes+respawns the gateway; it must run only once origin durably holds the merge. Push fail → `LAND-LOCAL-ONLY`, skip deploy, record state.
6. `exec cron-deploy-build.sh` — which first runs the **quiesce gate** (`cron-restart-safe-wait.sh`, reads persisted `cron_jobs.running_at_ms` from state SQLite, ignores markers >2h stale, excludes the deploy job id): waits up to 1800s for other cron jobs to finish so the build-crash doesn't kill them; `DEPLOY-DEFER` exit 3 if not idle. Then launches the detached health watcher (`cron-deploy-healthcheck.sh`), removes `update-check.json`, and `exec`s `env OPENCLAW_DEPLOY_BUILD=1 CI=1 node --import tsx scripts/build-all.mts` (the flag stands down the build-suicide guard).

**Verify gateway health after deploy** (`cron-deploy-healthcheck.sh` does this and writes `memory/reports/deploy-health-<date>.md`): RPC probe via `node openclaw.mjs gateway status --require-rpc --json` = ok → HEALTHY. Manual: `lsof -iTCP:18789 -sTCP:LISTEN` pid == launchctl-tracked pid; build stamp commit == landed main; then read the log for feature health (§below).

**Deploy-time defects tsgo/tests/autoreview cannot see** — always read the gateway log after deploy, don't trust process-up:

```
grep -E "errorCode|unknown method|missing scope" ~/Library/Logs/openclaw/gateway.log   # after a client reconnects
```

- **Config-validation crash-loop (exit 78)** — a big merge tightens config schemas, the operator's `openclaw.json` is rejected at load before migrations run. launchd sends stderr to `/dev/null`; run the exact launchd argv in foreground to see it, then `openclaw doctor --fix` (gateway down). Check where each rejected key _migrates_ first (some move, some retire); back up config + DBs and diff.
- **Two separate SQLite crash-loops:** config (above) vs the AGENT DB media migration (`requires offline media migration; parked the managed LaunchAgent`, schema v16→17 → boots itself out of launchd) — back up the agent DB, `doctor --fix`, `gateway restart`. A plain state-DB version bump AUTO-HEALS (no park); only `agent-databases-composite-primary-key` and `audit-events-v2` park.
- **Unregistered method groups / descriptor-only drops** → `unknown method` or `FORBIDDEN missing scope: operator.admin`. Diff registrations AND the descriptor table vs pre-merge main; restoring needs BOTH the `createLazyCoreHandlers` entry and the `core-descriptors.ts` descriptor (append — advertised order is a prompt-cache contract; widen `server-methods-list.test.ts` slice windows by exactly the count appended).
- **Fork-raised values reverted to upstream's** (e.g. `ChatHistoryParamsSchema.limit` 10000→1000 while fork UI sends 10000 → dashboard loads no history). Same class as export drops but for a value — nothing type-checks it.
- **Bundler init-order TDZ (build-red, tsgo-green):** a merge adds an import to a schema module the fork cross-imports as a value → tsdown emit-order shift → `Cannot access X before initialization` in `dist/`. Fix by extracting the schema to a typebox-only leaf module both files import.
- **`packages/ai/dist` never emitted (gateway crash-loop `Cannot find module @openclaw/ai/dist/internal/runtime.mjs`):** a merge=ours `tsdown-build.mjs` predating upstream's package extraction never invokes `tsdown.ai.config.ts`. vitest src-aliasing hides it; only a dist-running gateway boot catches it. Boot-smoke must import a dist chunk that references `@openclaw/ai/internal` (`grep -rl "@openclaw/ai/internal" dist/` → `node -e "await import('<chunk>')"`).
- **Catalog-loader identity outage:** never wrap a function downstream of registering it in a WeakMap/Map keyed by function identity (prepared-owner access, caches, lifecycle handles) — stamp behavior on the registered instance. Symptom: `models.authStatus`/`models.list` UNAVAILABLE, grep `omitted prepared owner access`.
- **i18n:** after any UI-touching merge run `pnpm lint:ui:i18n` to COMPLETION (not past the first error) — a crash-masked referenced-key gate hid 175 dropped `en.ts` keys. Placeholder-audit any suffix-match key recovery. Never hand-edit/commit foreign locale bundles or `catalog-fallbacks.json` in a source change.

---

## 7. Provenance recipes (before calling anything a regression)

Let `BASE=$(git merge-base HEAD upstream/main)`, `FORK=<fork-main-sha-before-merge>`. A "no exported member" / failing test is one of four things — check, don't guess:

```
git grep -lw X "$BASE" -- src packages    # existed at base?
git grep -lw X upstream/main -- src packages
git grep -lw X HEAD -- src packages
```

- at base + gone upstream → **upstream removed it** (real drift; adapt the consumer).
- not at base, HEAD only → **ours**, living in an unoverlaid conflict file (resolves on feature-merge, not a real removal).
- in upstream now → moved/renamed (re-point the import).

Was a fork file overwritten by upstream's (stale-protection trap)?

```
[ "$(git rev-parse HEAD:$f)" = "$(git rev-parse upstream/main:$f)" ] && echo overwritten
[ "$(git rev-parse $FORK:$f)" != "$(git rev-parse upstream/main:$f)" ] && echo fork-differed
```

Both true → restore the fork version (`git checkout $FORK -- $f`) and add to `.gitattributes merge=ours`.

Is a failing test for a feature the fork actually has? `git show $FORK:$file | grep -c <feature>` vs upstream — if it's test-only at fork-HEAD (0 in fork production) the skip is legit (tests an upstream feature the fork lacks); if it was in fork production and is now gone, that's a dropped fork feature (real regression) — restore production, don't skip. **~27 of 46 "missing export" errors in one sync were our own symbols in unoverlaid conflict files, not upstream removals** — only the merge-base check distinguishes them.

Four drift classes tsgo cannot see — check each with a set-diff, not a compile: (1) dropped entries inside a rebased list file (diff the id sets vs upstream, e.g. 11 tool-catalog entries silently dropped); (2) dropped fork-owned file (`main-tree − index` minus upstream deletions); (3) dropped upstream-new file (`upstream-tree − index` minus fork deletions minus `ui/**`); (4) declared-but-unhandled RPC (assert every declared method name resolves to a handler). The cron reports (2) via `report_dropped_upstream_files` and drift via `report_merge_ours_drift`/`_priority`, but re-derive remaining-work lists from the **INDEX mid-merge**, never from saved `/tmp` artifacts (the set shifts session to session).

---

## 8. Autoreview is a mandatory independent gate (not redundant with tests)

Before landing, run `$autoreview` on the **reconciliation judgment diff** (not the thousands of already-reviewed upstream commits). The autoreview harness rejects merge commits (parents>2) — run it against the squashed/land diff. It repeatedly finds real bugs tsgo + green behavior tests both missed: on 08-22 it caught **6 P0s** including a merge=ours-dropped `authorizeAuthenticatedProfileForMethod` security fence, 3 dropped gateway methods, a dropped restart-admission fallback, a mis-merged schema, a Swift type break, a UI import break (all `adopted-consumer + dropped-upstream-contract`). Fix findings (refactor if they want refactor); re-review until clean.

---

## Quick reference — one-liners

```
bash scripts/cron-upstream-merge.sh measure                 # read-only decision JSON
bash scripts/cron-upstream-merge.sh stage-init [date]       # stage + reports + pins
#   ...resolve in ../openclaw-upstream-nightly, commit...
bash scripts/cron-upstream-merge.sh finish-land [date]      # prove + ff-land + deploy (autonomous)
bash scripts/cron-upstream-merge.sh stage-finish [date]     # prove + push + STOP (product-collision)
REMOTE_NODE_BIN=/home/joe/node24/bin bash scripts/remote-proof.sh <branch>   # manual proof
node scripts/fork-config-snapshot.mjs {generate|verify|diff}
node --import tsx scripts/protocol-gen.ts                   # catches dropped protocol exports
rm -rf .artifacts/tsgo-cache && node scripts/run-tsgo.mjs -p tsconfig.core.json
```

Run log (not git-tracked): `~/.openclaw/workspace/memory/reports/upstream-merge-nightly.log`.

```

CONTRADICTIONS / STALE FACTS found while writing (verify before trusting older notes):
- `verifyDepsBeforeRun: false` is COMMITTED in pnpm-workspace.yaml (line 126) — the older memory's "add it then `git checkout` to revert, never commit" is stale.
- `startupJsGzipBytes` baseline is 585538 (not 583689/580201 from older ledgers).
- `scripts/committer` (called by cron `land_and_deploy` for baseline/asset auto-commits, `|| true`-guarded) does NOT exist in the tree — those auto-commit steps silently no-op; verify/replace before relying on post-land baseline auto-commit.
- `cron-upstream-merge.sh` schedule: nightly memory says `0 11 * * *`; task states it now runs HOURLY — trust the live cron config.
- Deploy scripts now invoke `node --import tsx scripts/build-all.mts` (not `build-all.mjs`).
```
