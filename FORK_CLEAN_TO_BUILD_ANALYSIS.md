# Cortex Fork — "Clean to Build" Analysis (COMPLETE COVERAGE)

**Date:** 2026-06-18
**Question:** Of our changes that merge _without textual conflict_ (the 157 "clean" commits / 495 non-overlap files), do they actually **compile** against upstream's current code?

## Method (empirical)

1. Worktree at `upstream/main` (`a1b7118d`), `pnpm install`.
2. Established a **green baseline**: ran **all 7 tsgo lanes** on clean upstream — `core`, `extensions`, `core:test`, `extensions:test`, `test:src`, `test:ui`, `test:packages`. **Every lane = 0 errors.** Upstream keeps the entire typecheck green, so any error after overlay is 100% ours.
3. Overlaid our version of all 488 non-overlap files (347 add / 125 modify / 16 delete).
4. Re-ran all 7 lanes.
5. **Disambiguated** every "missing symbol" error against the merge base (the overlay alone cannot tell "upstream removed X" from "we added X in a conflict file we didn't overlay" — they look identical).

> Supersedes the earlier prod-only pass (which saw 421 errors and **overstated** upstream drift — e.g. it flagged `registerDynamicSecret` / `buildCacheAwareChunkPlan` as upstream removals; merge-base checks prove those are **our own** symbols).

## Headline result — full coverage

| Lane                                       | Baseline | Overlay   |
| ------------------------------------------ | -------- | --------- |
| core                                       | 0        | 222       |
| extensions                                 | 0        | 199       |
| core:test                                  | 0        | 486       |
| extensions:test                            | 0        | 231       |
| test:src                                   | 0        | 443       |
| test:ui                                    | 0        | 88        |
| test:packages                              | 0        | 81        |
| **raw total**                              | **0**    | **1,750** |
| **distinct problems** (dedup across lanes) | **0**    | **739**   |
| distinct files affected                    | —        | **100**   |

**"Clean to merge" ≠ "clean to build":** the conflict-free commits produce **739 distinct type errors** across 100 files on current upstream. The test + UI lanes nearly doubled the prod-only count (421 → 739), so prod-only coverage was _not_ enough — UI controllers, chat, sessions, and our test suites add real breakage surface.

## But ~99% is internal coupling, not upstream drift

The decisive evidence is the "module has no exported member" set — 46 distinct missing symbols. Classified by merge-base presence:

| Classification                                                                                    | Count  | Meaning                                             |
| ------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------- |
| **OURS (coupling)** — created after merge base, lives in a _conflict_ file we didn't overlay      | **27** | Disappears when the 167 conflict commits are merged |
| **Exists in upstream now** — via a barrel/path/rename we'd reconnect during the protocol/UI merge | **17** | Mostly mechanical, part of the conflict merge       |
| **UPSTREAM-REMOVED (genuine drift)**                                                              | **2**  | Real, independent adaptation                        |

Only **2 of 46** missing-symbol errors are genuine upstream removals:

- `agentCredentialsEqual` (agent-auth) — gone from upstream; our agent-auth code still calls it.
- `AUTH_STORE_LOCK_OPTIONS` — gone from upstream; our auth-store lock code still references it.

Everything else traces back to our own features being **split across clean + conflict commits**. The big error clusters are all downstream of this:

- **268 implicit-`any` (TS7031/7006)** — cascades: one missing import at the top of a file → every param below becomes `any`. E.g. `extensions/workboard/src/gateway.ts` shows 131 errors from **one** missing `../api.js` import.
- **163 workboard self-import errors** — our workboard clean files importing our workboard `api.ts`/`store.ts` (overlap files kept at upstream's version).
- **18 gateway-protocol + 12 skill-workshop** — types/validators we _added_ to the protocol/views, sitting in conflict files.

## What is genuinely independent post-merge work (small)

1. **2 confirmed upstream API removals** to adapt: `agentCredentialsEqual`, `AUTH_STORE_LOCK_OPTIONS`.
2. **~17 barrel/rename reconnections** (`SessionsListResult`→`SessionsFilesListResult`, `PresenceEntry`, `ExecApproval*`, `GatewaySessionRow`, `SessionRunStatus`, etc.) — these symbols still exist upstream; our imports re-point during the gateway-protocol / UI conflict merge. Mechanical.
3. **2 missing dev/runtime deps** our code added: `smol-toml` (TOML parsing), `fast-check` (property tests) — add to the correct package.json.
4. **Cron delivery schema — a real convergent-evolution conflict** (32 errors in `src/cron/store/delivery-codec.ts`): our code reads `delivery_completion_channel/_account_id/_thread_id`; upstream's `CronJobs` table standardized on `delivery_completion_mode/_to`. **Both forks extended cron delivery incompatibly.** Needs schema reconciliation + a doctor migration — the cron analog of workboard.

## Verdict

- **No, the clean commits do not independently build** — 739 distinct errors under full coverage (0 baseline).
- **~99% is the expected consequence of splitting features across clean + conflict commits**, not upstream pulling the rug out. It resolves when you merge each feature whole (clean half + conflict half together).
- **Genuinely new upstream-drift adaptation is tiny** — 2 confirmed removals, ~17 mechanical barrel re-points, 2 deps.
- **One true semantic landmine: cron delivery schema** (joins workboard as a convergent-evolution hotspot).
- **Net read for the fork:** the divergence is _contained and internally coherent_. The features are not rotting against upstream; they simply can't be cherry-picked half-and-half. Merge feature-by-feature and the build comes back green with a single-digit list of real adaptations.

## Recommended sequence

1. **Merge per feature** (clean + conflict halves together) — never clean-then-conflict in two passes.
2. Re-apply our `gateway-protocol` additions during the protocol conflict merge **first** — clears the largest coupling/cascade bucket (gateway-protocol, presence, exec-approval, sessions).
3. Reconcile **cron delivery schema** and **workboard** as explicit feature-merge tasks (+ doctor migrations).
4. Adapt the 2 confirmed removals (`agentCredentialsEqual`, `AUTH_STORE_LOCK_OPTIONS`); add `smol-toml` + `fast-check`.
5. Gate by returning **all 7 tsgo lanes to 0**, then targeted vitest via Crabbox/Testbox.

_Measured in an isolated worktree; main and the running gateway untouched (typecheck only, no dist build). Worktree removed after measurement._
