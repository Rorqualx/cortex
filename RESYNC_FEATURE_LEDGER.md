# Resync feature ledger — bbd01c169e5 reconciliation (redo)

Maintainer-facing record of the **consequential** conflict resolutions and deferred
items for the Phase-0 catch-up resync. Companion to the auto-generated
`RESYNC_LEDGER.md` (batch plan) and the redo done on branch `resync-redo-2026-07-08`.

- **Merge:** `ea1fd428dda` — resync `upstream/main` @ `bbd01c169e5`, 97 conflicts resolved
  3-way (rerere replay OFF; union-contamination from the prior merge `fc8ff179` avoided).
- **Reconciliation:** green-up passes 1–17 on top of the merge (`ea1fd428dda..HEAD`,
  49 files, +5055/−1599) clearing the `merge=ours`-masked semantic divergences and every
  downstream build/tsgo/test breaker.
- **Validation (huey / Linux CI-truth, proof #15 @ `74526089c3c`):** `BUILD_EXIT=0`;
  all 7 tsgo lanes at/below the fork's known-red baseline
  (core 9<16, extensions 20=20, extensions:test 29=29, core:test/test:src/test:ui/test:packages =base);
  all 5 merge-induced test failures fixed.

## Consequential resolutions (need maintainer eyes)

1. **subagent-registry.ts (`merge=ours`, upstream +383 LOC)** — resolved via
   `git merge-file -p UPSTREAM BASE FORK` (upstream baseline + fork delta), NOT fork-baseline
   (which duplicated upstream's parallel-invented lifecycle code). Adopts upstream's
   detached-task lifecycle + wires 3 lifecycle-controller deps; preserves fork deltas
   (`getSubagentRunByRunId`, storeCache orphan arg, `sessions_yield` guard). **Fork #92448
   yield-vs-abort ordering is now subsumed under upstream's lifecycle** — confirm the
   ordering guarantee still holds.

2. **Tool-policy reconciliation (compact.ts:885, attempt.ts:1505)** — the 2 build-breaking
   `applyFinalEffectiveToolPolicy` sites converted to `resolveConversationCapabilityProfile`.
   Security-verified behavior-preserving: `applyFinalEffectiveToolPolicy` reads ONLY
   `capabilityProfile.policy.*`; the flat-input→profile map is 1:1, so filtering is
   unchanged. (The 3rd fork-local site compiles as-is; upstream's single-source-policy
   consolidation is an optional follow-up.)

3. **Provider relocation-direction (`packages/ai/src/providers/`)** — the
   `src/llm/providers`→`packages/ai` move kept the fork's **stale** `mistral.ts` /
   `google-shared.ts` at the new path, silently dropping upstream's rewrite — including
   `createBoundedMistralFetcher` (a **bounded stream-read security fix**; unbounded Mistral
   SSE body otherwise). google-shared adopted upstream wholesale (clean). mistral: kept the
   fork impl+test pair (fork tests fork behavior) and **ported only** `createBoundedMistralFetcher`,
   version-matched to commit `062f88e3e3a` (dynamic-`fetch` variant the tree's test requires).
   Fork's `onResponse` attestation hook preserved.

4. **Skills archived-filter (`workspace.ts`, `merge=ours`)** — upstream added curator-archived
   filtering across curator/session/workspace; the fork kept its workspace.ts, dropping it.
   Ported upstream's design into `loadSkillEntries` via a `mergeRecord` helper (filter at
   merge time to preserve precedence). Flows to snapshot + visible-entry paths; raw
   `loadSkills` still returns archived.

5. **Session-lifecycle wire fields (`session-row.ts`, `session-entry-slot-keys.ts`)** — added
   the optional lifecycle fields upstream's session-grouping projection (`#100814`) reads
   (`archived`/`pinned`/`unread`/`category`/`*At`). Projection compiles and emits safe
   defaults. **Full `buildGatewaySessionRow`←`SessionEntry` population is DEFERRED** (see below).

6. **Codex attempt hooks (`run/types.ts`)** — added `onAttemptAbort?` to
   `EmbeddedRunAttemptParams` and `assistantTranscriptOwned?` to `EmbeddedRunAttemptResult`.
   The codex extension already reads/produces both; only the core type contract was
   merge-dropped. `../codex` hard gate satisfied (inspected @ `04483f4`: codex turn-interrupt
   is the `InterruptConversation` app-server method, `codex-rs/app-server-protocol/src/protocol/v1.rs:235`;
   `onAttemptAbort` is OpenClaw-side, protocol-neutral).

## Deferred for the maintainer (dormant, no regression, not compile-blocking)

- **Core `onAttemptAbort` production wiring** — upstream `run.ts:2243` provides the hook +
  `attempt.ts:3863` calls it on external abort. The fork's abort path diverged
  (`attempt.ts:3495 abortActiveRunExternally = () =>`, no `reason` param), so grafting is a
  high-risk 3-way of the two largest core-runtime files. Left dormant == baseline behavior
  (no hook fired before); the codex extension already calls it best-effort.
- **`buildGatewaySessionRow`←`SessionEntry` lifecycle population** — full session grouping /
  unread / pin / archive row population (needs upstream's `unread` derivation semantics).
- **`server-chat` `updateRunToolErrorSummary` write-path** — types wired, invocation deferred
  (abort messages omit the tool-error summary until restored).
- **before-tool-call security-event restoration; `chat.ts` active-send-dedupe;
  `update-startup` full auto-restart reconciliation** — owner/product decisions.

## Known non-defect

- **`src/audit/audit-event-writer.test.ts`** — the sole remaining proof NEWFAIL. Both the
  code and the test are **upstream Δ0** (adopted cleanly). It fails **consistently on huey**
  (3/3 isolated) but passes on macOS + (presumably) upstream CI: `writer.record()` returns
  `false` under the test's `BEGIN IMMEDIATE` write-lock because the background-flush loop
  races the lock differently on huey's timing. A platform-timing race in an upstream test —
  **not a merge-resolution defect**. Do not edit upstream's test to silence it; verify on a
  faster Linux box or file an upstream flaky-test report.

## Not done in this pass

- **Advance `bbd01c169e5` → latest upstream** — upstream has moved **+613 commits / 3181
  files** since the merge target. Recommendation: **land this validated bbd01 reconciliation
  first** (2290→613 behind is the big win), then advance the 613 as a smaller follow-up with
  seeded rerere — matches the plan's "reset first, then keep up".
- **rerere reseed with correct resolutions** — the rr-cache is empty (replay was OFF). Proper
  seeding needs the merge re-run with recording ON, resolving each conflict to the FINAL
  (green-up-inclusive) state; best folded into the Phase-2 auto-merge engine build.

## Autoreview dispositions (pre-land review of the reconciliation delta)

A fresh workflow `$autoreview` of `ea1fd428dda..HEAD` returned 6 verified findings; dispositions:

1. **FIXED — `timedOutByRunBudget` was hardcoded `false` (run.ts, attempt.ts)**: ported
   upstream's full producer chain — attempt-local flag set by the run-budget abort timer
   (only; the idle watchdog and external-abort paths are separate), carried on
   `EmbeddedRunAttemptResult` and all attempt trajectory events, consumed by
   `handleAssistantFailover` and the timeout-compaction retry gate
   (`!timedOutByRunBudget` — compaction cannot buy back an exhausted run budget).
2. **FIXED — google-shared dropped the fork's `onResponse` attestation hook**: restored
   `onResponse` to `runGoogleGenerateContentLifecycle`'s options Pick + the synthetic-200
   invocation after `generateContentStream` (mirrors Mistral/OpenAI providers).
3. **FLAG (upstream bug candidate, not a merge defect) — session-delete CAS via full-entry
   `JSON.stringify` (store.ts:1317, :1380)**: upstream-Δ0 code adopted verbatim. Key-order
   sensitive — the same CAS class as the fork's known reply-session-init bug. Consider an
   upstream report; do not fork-patch during the resync.
4. **NO CHANGE — archived-skill filter DB read (workspace.ts:1201)**: the ported call is
   character-identical to upstream's, and the fail-open on DB error is upstream's own
   documented design in Δ0 `curator.ts` ("temporarily showing archived skills is safer than
   breaking prompt/snapshot builds").
5. **NO CHANGE — `completeSubagentRunWithRecovery` retry guard (subagent-registry.ts:472)**:
   current code is character-identical to upstream; the fork-baseline's stricter retry
   precondition belonged to the pre-lifecycle design upstream superseded (adds the
   rolled-back-durable-write orphan-recovery branch; `sessions_yield`/`cleanupCompletedAt`
   still gate the final resume, and `completeSubagentRun` in Δ0
   `subagent-registry-lifecycle.ts` has its own entry guards).

Refuted by verification (no action): google-shared image-turn ordering; a duplicate-import
style nit in server.impl.
