---
name: openclaw-upstream-resync
description: "Re-integrate a large upstream openclaw/openclaw delta into the cortex fork: guarded merge, layer-by-layer convergent reconciliation, then verify by build + behavior + autoreview on Linux. Use when the fork is hundreds-to-thousands of commits behind upstream."
---

# OpenClaw Upstream Re-Sync

Re-integrate a big upstream delta (hundreds–thousands of commits) into the `cortex` fork while protecting fork work, capturing upstream's improvements, and resolving convergent features. The output is an isolated branch that builds + typechecks + passes behavior tests + survives an adversarial review, ready for the maintainer to land.

**Use when:** the fork is far behind `upstream/main` and you need a full catch-up.
**Don't use for:** cherry-picking one upstream fix (just `git cherry-pick`), or routine fork work.

> **Autonomous/hourly cron resolution: read `docs/refactor/upstream-resync-cron-playbook.md` FIRST.** It carries the fork-specific operational specifics this skill omits — exact hourly workflow + commands, the tsgo lane baseline table (validate by error-set diff, not exit codes), and the hard-won gotchas (huey audit-writer 3000ms flake, control-ui startup-JS budget bump, stale huey proof flock, x64-node deploy, ~90–150s boot, post-land committer→git-commit fix). It supersedes stale memory where they conflict.

This is a _re-integration project, not a fast-forward_. Plan for multiple passes with the maintainer in the loop on convergent product decisions. Do everything on an isolated worktree/branch; never touch `main` or the live gateway until the maintainer lands.

---

## The mental model — why this is hard

Internalize these before touching git. Every one of them bit us in a real sync.

### 1. The `merge=ours` trap (the central nuance)

The fork protects files via `.gitattributes merge=ours` (+ `merge.ours.driver=true` in git config — verify it's set or protection is a silent no-op). But `merge=ours`:

- **Only wins on _conflicting_ hunks.** Non-conflicting upstream hunks to a protected file still auto-merge → a file can end up a semantically-broken combination of both sides ("silent combination"). The `fork-config-baseline.json` snapshot catches this for config files only.
- **Silently drops upstream's improvements on heavy convergent files.** When _both_ sides rewrote a file (e.g. agent-runner, sessions store, gateway chat), `merge=ours` keeps ours and discards upstream's rewrite — including crash/perf/security fixes. These files must be reconciled deliberately, **not** left to the driver.

### 2. Silent loss runs in BOTH directions

- **Keep-ours direction:** protected heavy files drop upstream's work (above).
- **Take-theirs direction:** the protection sweep gets **stale**. Ours protected _production_ files but **missed fork TEST files**, so the merge silently swapped fork tests for upstream's — which then test _upstream's_ API against _kept-fork_ production. This surfaced as both tsgo errors AND runtime behavior failures. After any sweep, re-run it and explicitly include test files.

### 3. Three different kinds of "green"

- **clean-to-merge ≠ clean-to-build:** the conflict-free commits do _not_ independently compile, because features are split across clean + conflict commits (the clean half imports the conflict half). Merge _feature-by-feature_, never clean-then-conflict.
- **tsgo-green ≠ behavior-green:** an upstream test can _compile_ against fork production yet assert different _runtime_ behavior. Only the vitest behavior suite catches this. Always run it.
- **Mac-green ≠ CI-green:** snapshot/serialization/path/sqlite tests vary by OS/Node version (CI truth is Linux Node 24). Build + behavior-proof on Linux.

### 4. Errors cascade from a few root causes

One missing import at the top of a file → every downstream param becomes implicit-`any` (e.g. 131 errors from one missing `../api.js`). The "keystone" pattern: a handful of shared **type** files kept-ours and lacking upstream's new fields caused ~94 cascading errors. **Fix root causes / graft shared types first** — most cascades vanish.

### 5. Some collisions are product decisions, not mechanics

Convergent features where both forks rewrote in incompatible directions (workboard: fork LLM-loop vs upstream ops-UI; codex: fork-stripped vs upstream-expanded; agent-loop: fork steering vs upstream deferred-hydration) are **maintainer decisions**. Surface them with evidence and a recommendation; do not auto-pick.

---

## Procedure

### Phase 0 — Recon & prep (no merge yet)

1. `git fetch upstream`. Measure divergence: `git rev-list --count upstream/main..HEAD` and `HEAD..upstream/main`; `git merge-base HEAD upstream/main`.
2. **Read the fork's existing merge tooling first** — it already exists: `.gitattributes` (the `merge=ours` sweep), `scripts/fork-merge-guard.mjs`, `scripts/fork-config-snapshot.mjs`, `scripts/fork-merge-verify.mjs`, `FORK-MERGE-GUIDE.md`. Extend, don't reinvent. Note: the guard uses `npx tsc` — the repo actually uses `tsgo`; pass `--skip-tsc` and run tsgo lanes yourself.
3. Create an isolated worktree: `git worktree add -b resync/upstream-<date> ../openclaw-resync main`.
4. **Characterize the delta** so you know the substance, not just counts: `git log --format='%s' HEAD..upstream/main | grep -oE '^[a-z]+' | sort | uniq -c` (fix/refactor/perf/feat mix) and per-scope. Upstream is usually fix/refactor-heavy (hardening) — that's the worst kind to be behind on because refactors move APIs under your greenfield code.
5. **Controlled dry-run** to see the real residual conflict set _after_ protection: `git merge --no-commit --no-ff upstream/main`, then `git status --porcelain | awk '{print $1}' | sort | uniq -c` (UU/DU/UD/AA), capture the conflict list, then `git merge --abort`. Most files auto-merge; only a small set truly conflicts.
6. Build a **ledger** (`RESYNC_LEDGER.md`): every conflict + every heavy-convergent kept-ours file, each tagged KEEP-OURS / AUTO / ADOPT / ENHANCE / DEFER and an owning layer.

### Phase 1 — Merge & resolve, foundation-first

Foundation order (each layer depends only on prior): **protocol/packages → config + sessions/state store → agents core + runner → gateway/infra/cron → channels + plugin-sdk → core features → extensions → UI**.

1. `git merge --no-commit --no-ff upstream/main`.
2. Resolve conflicts in foundation order. For each file apply the **per-change rubric** (below). Regenerate, don't hand-merge, derived files: `pnpm-lock.yaml` (run `pnpm install`), `ui/src/i18n/**` (take upstream / regenerate).
3. For heavy convergent files, the merge often produced no conflict (kept-ours). **Separately diff them against upstream** and decide — the keystone shared types first (see §"Keystone").
4. Commit the merge once all conflicts are resolved (`git rerere` records every resolution for future re-merges).
5. After the merge commit, drive the foundation to **tsgo-green** layer by layer. The remaining errors are mostly cascade + coupling that resolve as you graft the shared types; the genuinely independent drift is small (single digits of renamed/removed upstream symbols).

### Phase 2 — Verify (the ladder — each step catches what the previous can't)

1. **tsgo, all 7 lanes → 0:** `tsgo:core`, `tsgo:extensions`, `tsgo:core:test`, `tsgo:extensions:test`, `tsgo:test:src`, `tsgo:test:ui`, `tsgo:test:packages`. Establish a green baseline on clean upstream first, then diff — exit codes are meaningless against a red baseline. **Clear `.artifacts/tsgo-cache` for accurate per-lane counts** (incremental attribution is flaky; the same total gets split differently between runs).
2. **`fork-config-snapshot.mjs verify`** → regenerate the baseline post-merge; re-run the protection sweep including test files.
3. **Build + behavior on Linux** (Mac can't: `node-llama-cpp` fails under x64-Rosetta). See §Platform.
4. **`$autoreview`** on the _reconciliation_ diff (not the 2,356 upstream commits — already reviewed upstream). This is mandatory and it _finds real bugs_ — last sync it caught a security regression (exec-approval bypass) plus 5 correctness bugs that tsgo + behavior tests both missed.

### Phase 3 — Land (maintainer)

Present branch + ledger + proof. Land only after green + review. Rebuild + `gateway restart` after landing (deploy = build+restart).

---

## The per-change reconciliation rubric

For every convergent hunk/file:

1. **Evaluate upstream's change in isolation** — what does it fix/improve (crash, perf, correctness, security)?
2. **Evaluate it in fork context** — does it clash with / duplicate / undermine the fork feature in that file?
3. **Decide & log (in the ledger):**
   - **ADOPT-UPSTREAM** — fork code was incidental; take upstream. (e.g. sessions `store.ts` was upstream's base + additive rewrite → adopt + graft the one fork helper back.)
   - **ENHANCE-OURS** — graft upstream's fix/perf into our version, keep fork behavior. (e.g. `model-catalog`: keep our discovery overlay + add upstream's cache; `redact`: keep our scrub + upstream's `redactFormBodies`.)
   - **KEEP-OURS** — fork behavior is the point and upstream's change is incompatible — **cite why**. (e.g. `infra/exec-approvals` wire-alias when the wire type already carries all of upstream's fields.)

**Never weaken a guard or delete fork behavior to satisfy a type error** — reconcile the type/API instead.

### Never resolve a hunk by keeping both sides

The rubric above is a choice of one. The most expensive resolution failure in this
repo's history is the fourth, non-option: **union** — keeping upstream's lines *and*
ours. It looks safe, because when upstream extracts helpers into modules the two
sides both read as purely additive:

<!-- markers indented: check:no-conflict-markers and `git diff --check` both anchor at column 0 -->

```
  <<<<<<< HEAD
  function computeJobNextRunAtMs(...) { ... }      // fork still defines it locally
  =======
  import { computeJobNextRunAtMs } from "./schedule.js";   // upstream extracted it
  >>>>>>> upstream/main
```

Keep both and the file now imports a symbol it also declares. On 2026-07-27 that
produced **284 tsgo errors from 18 conflicts** — 57 direct collisions in two cron
files, dragging 145 `TS2304 cannot find name` behind them. It is also how the
2026-07-06 resync ended up with duplicate declarations across seven files.

- **Signature:** `TS2440` (import conflicts with local declaration), `TS2323`
  (cannot redeclare exported), `TS2484` (export declaration conflicts). The
  nightly preflight fails with `reason=union-merge` and names the owning files.
- **When you see it, re-resolve those files** — do not start fixing the 145
  downstream `cannot find name` errors. They evaporate when the collision goes.
- **The choice is real:** either adopt upstream's extraction (take the imports,
  delete the fork's local copies, and re-graft any fork-only logic into the new
  module) or keep the fork's monolith (drop the imports). Both are defensible;
  holding both is never correct.
- A duplicate declaration in a file that still compiles is the dangerous variant —
  tsgo cannot see a second `const` in a different scope. After resolving, scan the
  files you touched for repeated top-level names, and remember an import-vs-local
  collision will not show up in a declaration-only scan.

---

## Provenance recipes (do this BEFORE calling something a regression)

A "module has no exported member" or a failing test can mean four different things. Don't guess — check the merge base, fork-HEAD, and upstream. Let `BASE=$(git merge-base HEAD upstream/main)`, `FORK=<fork-main-sha-before-merge>`.

- **Is symbol X ours (coupling), upstream-new (graft), upstream-removed (real drift), or fork-dropped (restore)?**
  ```
  git grep -lw X "$BASE" -- src packages   # existed at base?
  git grep -lw X upstream/main -- src packages
  git grep -lw X HEAD -- src packages
  ```

  - at base + gone upstream → **upstream removed it** (genuine drift; adapt the consumer).
  - not at base, in HEAD only → **ours** (it lives in an unoverlaid conflict file; resolves on feature-merge, not a real removal).
  - in upstream now → moved/renamed (re-point the import).
- **Did the merge overwrite a fork file with upstream's?** (the stale-protection trap):
  ```
  [ "$(git rev-parse HEAD:$f)" = "$(git rev-parse upstream/main:$f)" ] && echo overwritten
  [ "$(git rev-parse $FORK:$f)" != "$(git rev-parse upstream/main:$f)" ] && echo fork-differed
  ```
  Both true → **restore the fork's version** (`git checkout $FORK -- $f`) and add it to `.gitattributes merge=ours`.
- **Is a failing/skipped test for a feature the fork actually has?** Check `git show $FORK:$file | grep -c <feature>` vs upstream. If the feature is _test-only at fork-HEAD_ (0 in fork production), the skip/delete is legit — it tests an upstream feature the fork doesn't implement. If it was in fork production and is now gone, that's a **dropped fork feature** (real regression) — restore production, don't skip the test.

**Lesson:** in one sync, ~27 of 46 "missing export" errors were _our own_ symbols in unoverlaid conflict files, not upstream removals. The overlay/merge can't tell them apart — only the merge-base check can.

---

## The keystone pattern (highest-leverage move)

When the UI / a layer explodes with TS2741/TS2739/TS2339 (missing properties), the cause is almost always a few shared **type** files kept-ours that lack upstream's new fields. Graft those first and the cascade collapses. Last sync, one graft of 5 UI type files (`app-view-state`, `ui-types`, `types`, `storage`, `sidebar-content`) cleared ~94 of 154 UI errors. Same for `gateway-protocol` schema + `config/sessions/store.ts` in the foundation.

---

## Convergent product decisions (surface, don't auto-pick)

When both forks rewrote a feature incompatibly, stop and put it to the maintainer with evidence and a recommendation. Decide direction first, then reconcile to match. Examples and how they resolved last time:

- **Workboard** (fork LLM idea→goal→task loop, 2.5k-line UI vs upstream lifecycle-polling ops-UI, 4.1k-line) → kept fork; dropped upstream's lifecycle-polling tests.
- **Codex app-server** (fork _deliberately stripped_ ~19.6k lines incl web-search provider vs upstream expanded) → kept fork-trimmed, _repaired to internal consistency_: restored the model-selection fns the fork trimmed collaterally (its own consumers call them), grafted the web-search _gating flags_ (fork kept those), did not re-add the provider. **Codex is owner-gated (AGENTS.md): personally inspect `../codex` source before any codex verdict; clone `https://github.com/openai/codex.git` there if missing.**
- **Agent-loop** (fork steering/preempt vs upstream deferred-tool-hydration + Fable adaptive-thinking) → kept fork loop; restored the fork's matching test.

Default bias: **keep the fork's direction, make it internally consistent** — protects fork work. Only adopt upstream's version of a convergent feature if the maintainer says the fork's divergence is obsolete.

---

## Platform & remote build (CI truth = Linux Node 24)

The Mac can't run `pnpm build` (the `plugins:assets:build` phase re-runs `pnpm install`, which fails on `node-llama-cpp`'s native postinstall under x86_64-Rosetta Node). Build + behavior-proof on a native Linux box (e.g. `huey` / `labor-server` 192.168.50.185 over SSH, or Crabbox/Testbox).

Getting a 2,356-commit branch to a remote:

- Don't `scp` a 1.1GB full bundle blindly. If the remote has GitHub access, have it `git clone` upstream + the fork (heavy history from the CDN), then transfer **only your reconciliation commits** as a _minimal_ bundle: `git bundle create fix.bundle <fork-parent>..<upstream-parent>..resync/<branch>` keyed off both merge parents → ~134K. (If GitHub clone is slow, a full bundle over the LAN is fine — 1.1GB in ~6s on gigabit.)
- Incremental updates: `git bundle create d.bundle <remote-HEAD>..resync/<branch>` (a few KB), `scp`, then on remote `git fetch ~/d.bundle 'refs/heads/<branch>:refs/remotes/x/b' && git reset --hard x/b`.

Remote build/test gotchas (all cost real time last session):

- Install Node 22+ user-local (tarball to `~/node22`, use `corepack` for the pinned pnpm) — repo needs ≥22.19; the box may have Node 18.
- **Run long builds with `setsid bash script.sh </dev/null >/dev/null 2>&1`** — a backgrounded build holding the SSH channel gets killed when the tool call times out; `setsid` puts it in a new session that survives. Poll a log file for a `DONE`/`EXIT=` marker.
- **`tsdown` (the bundle phase) is memory-hungry** (~8.5GB). If you launch a build twice, the orphaned bundlers from the first keep running and thrash memory — find them by `ps -eo pid,rss,args --sort=-rss` (cmdline is bare `node ./node_modules/.bin/tsdown`) and `kill -9` before re-launching. Leave the box's _other_ workloads alone.
- A successful build = `BUILD_EXIT=0` + `dist/` produced (~155M). The Mac-failing `plugins:assets:build` phase passes on Linux.
- Behavior proof: `pnpm test:fast` (unit config, excludes e2e/live which need infra/keys). Expect a small set of **environmental** failures (path-compaction, filesystem-policy, sqlite-journaling) that depend on home dir / FS type / Node version — confirm they're env-coupled and not merge-caused before dismissing.

---

## Agent orchestration

- **Reconciler agents per disjoint domain** (sessions / agent-runner / gateway+auto-reply / memory-l3 / UI-shell / UI-features / test files). Edit-only; instruct them **not** to run git or tsgo — verify centrally to avoid index races and concurrent-write corruption. Have them apply the per-change rubric and report ADOPT/ENHANCE/KEEP verdicts + flag cross-domain deps.
- For delicate flagship reconciliation, pass an **explicit `model`** so the agent isn't routed to GLM by the delegation hook.
- **Verify the agents.** They skip-to-green: a test agent will `describe.skip` a failing suite claiming "feature never in production" — check the provenance yourself (it was honest last time, but one "regression" flag was a false alarm). And `describe.skip` does **not** exclude a body from tsgo — stubs/casts must still compile.
- Independent verify pass on every finding (the autoreview does this; mirror it for important judgments).

---

## Operational gotchas (each cost real debugging time)

- `merge.ours.driver=true` must be in git config or `merge=ours` is a no-op.
- Clear `.artifacts/tsgo-cache` between meaningful tsgo runs — incremental attribution flips lanes/counts.
- macOS `sed` has no `\b`; use Python for exact-string edits when the Edit tool is read-once-blocked.
- Never `pkill -f 'tsgo'` / `'<word in your own command>'` — it kills the shell running the command.
- `pnpm build`/`pnpm test` re-run a deps-status check that re-installs; bypass with `node scripts/<runner>.mjs ...` directly when install is flaky.
- The state DB auto-heals schema (`ALTER TABLE ADD COLUMN`, `openclaw-state-db.ts`) via the reconciled `state-migrations.ts` — a superset schema needs no separate doctor migration for additive columns.
- Don't read a subagent's JSONL transcript file with Read/cat — it overflows context; wait for the completion notification.

---

## Definition of done (land-ready)

- [ ] All 7 tsgo lanes = 0 on **both** Mac and Linux.
- [ ] `pnpm build` exit 0 on Linux, `dist/` produced.
- [ ] Behavior suite (`test:fast`) passing except confirmed-environmental failures; every _merge-caused_ failure fixed.
- [ ] `fork-config-snapshot verify` clean; baseline regenerated; protection sweep refreshed (incl. test files).
- [ ] `$autoreview` on the reconciliation diff — security + correctness findings fixed, no actionable findings remain.
- [ ] Every convergent product decision made by the maintainer and logged in `RESYNC_LEDGER.md`.
- [ ] Nothing on `main`; live gateway untouched. Branch + ledger + proof presented for landing.
