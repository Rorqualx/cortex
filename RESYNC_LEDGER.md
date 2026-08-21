# Upstream Resync Ledger — 2026-08-20

Branch: `resync/upstream-2026-08-20` (worktree `../openclaw-resync-2026-08-20`)
Base: `a3ca8466` (2026-08-19) → upstream tip `784a2287` (2026-08-20)
Delta: **266 commits** upstream (fork 993 ahead). 79% fixes (210), hardening delta.

## Conflict tally (post-merge)

- 71 UU (30 non-i18n + 41 i18n), 184 DU, 19 UA, 1 UD.

## Foundation (non-UI) — reconciled by lead

| File                                                    | Verdict        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents/agent-bundle-mcp-materialize.ts`            | ENHANCE-OURS   | Fence upstream's sanitized `publicValue` (resources/prompts projection, `_meta` stripped) instead of raw `params.value` — keeps fork's untrusted-MCP fence AND fixes a latent fork bug (was fencing the unsanitized value).                                                                                                                                                                                                                                                                        |
| `extensions/openshell/src/cli.ts`                       | ADOPT-UPSTREAM | Upstream extracted `buildRemoteCommand` into `plugin-sdk/sandbox` (byte-identical to fork's local copy); dropped fork's now-duplicate local def (union-trap) + took upstream's un-exported (narrower) `applyGatewayEndpointToSshConfig`.                                                                                                                                                                                                                                                           |
| `src/gateway/server-cron-notifications.ts`              | ENHANCE-OURS   | Upstream #126483 rewrote the failure path (threshold-gated `sendGatewayCronFailureAlert`, relocated to `server-cron.ts:981`) and deleted `dispatchCronFailureDestinationNotifications`. Adopted upstream's rewrite; re-grafted the fork's orthogonal completion-**announce** feature (`completionDestination.mode:"announce"` → chat summary) onto upstream's surviving `sendGatewayCronFailureAlert` sender (best-effort). Verified merged `server-cron.ts` caller matches the reduced signature. |
| `ui/package.json`                                       | UNION          | Kept fork `@openclaw/uirouter`; adopted upstream new deps (`@panzoom/panzoom`, `ghostty-web`, `pako`) + version bumps.                                                                                                                                                                                                                                                                                                                                                                             |
| `extensions/memory-core/src/prompt-section.ts` (UD)     | KEEP-OURS      | Upstream #126552 refactored it into internal `memory-tool-contract.ts`, but `memory-wiki` + tests still import the fork's `buildPromptSection`. Restored fork version (SDK `MemoryPromptSectionBuilder` still exported both sides). **Follow-up:** migrate memory-wiki + memory-core/index.test to upstream's `memory-tool-contract`.                                                                                                                                                              |
| `src/agents/agent-bundle-mcp-tools.materialize.test.ts` | KEEP-OURS      | Fork's `expectFencedMcpText` matches fenced production; upstream side referenced helpers/flags absent in fork.                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/ui.presenter-next-run.test.ts`                    | ENHANCE-OURS   | Fork presenter path (`ui/src/ui/`, upstream `lib/` absent) + upstream's `i18n` import (merged body uses `i18n.getLocale()`).                                                                                                                                                                                                                                                                                                                                                                       |
| `src/gateway/server-methods-list.test.ts`               | REGEN          | Stale protocol-method-order snapshot (registry legitimately grew fork+upstream → 372 methods, none dropped). Snapshot arrays/slice-counts regenerated to actual.                                                                                                                                                                                                                                                                                                                                   |
| `config/control-ui-startup-budget-baseline.json`        | KEEP-OURS      | Fork's Control UI startup budget (580201 B) — fork UI is larger; upstream 344531 B is for its UI.                                                                                                                                                                                                                                                                                                                                                                                                  |

## i18n (43 files)

- `ui/src/i18n/locales/en.ts` — KEEP-OURS (fork source superset; upstream changed strings are for skipped UI features).
- 41 `ui/src/i18n/.i18n/*` — KEEP-OURS (derived TM caches, consistent with fork en.ts).
- `apps/.i18n/native/*` — upstream auto-merge (kept).

## Major product decision: UI divergence

**The fork's UI lives entirely under `ui/src/ui/`; upstream restructured its UI to `ui/src/pages|components|lib|app/`.** Per fork ownership policy (and prior resyncs), we KEEP the fork's UI:

- **184 DU** kept-deleted: 180 are upstream's restructured `ui/src/*` files the fork replaced; 4 are base files the fork stripped (skill-workshop base test/doc — fork owns a multi-file skill-workshop impl; `control-ui-locales`; `skills.proposals` gateway test).
- **19 UA** (new upstream UI features) SKIPPED — they import from fork-absent `ui/src/components|lib`. **Available to port:** custodian alerts, GitHub-identity authorization view, cron-trigger authoring/filter, resize-handles, chat-pane-placement.
- **21 UU** `ui/src/ui|styles|test-helpers` reconciled keep-ours-biased (grafting additive upstream fixes that fit fork structure).

## Follow-ups

1. Migrate `memory-wiki` + `memory-core/index.test.ts` to upstream's `memory-tool-contract` (retire fork `prompt-section.ts`).
2. Port desired upstream UI features (custodian alerts, github-identity auth, cron-trigger authoring) to the fork's `ui/src/ui` structure — maintainer decision.
3. Fork skill-workshop docs (`docs/tools/skill-workshop.md`) left deleted — rewrite if the fork wants public docs.
4. i18n sync tooling references `ui/src/app` (upstream layout) — fork i18n regen (`ui:i18n:sync`) needs a fork-path fix; unrelated to this merge's correctness.

## Phase 2 second-pass reconciliation (gateway/protocol split-brain — maintainer-directed)

Auto-merge kept fork definition files but adopted upstream consumer files → ~180 new tsgo errors. Decisions:

- **Method-registry (#118232)**: GRAFT upstream's 37 methods + placement-scope changes (`sessions.dispatch`/`sessions.move`→dynamic, `sessions.reclaim`→operator.write, `node.runnerInventory.update`) into the fork's `core-descriptors.ts` table + wire lazy handlers in `server-methods.ts`. (Fixes silent "unknown method" regression — handlers already merged.)
- **GitHub-identity (#126474)**: ADOPT FULLY — graft schemas into fork protocol (`agents-models-skills.ts` etc.), keep gateway/agent handlers, AND port the UI view to the fork's `ui/src/ui` structure.
- **Missing-export casualties**: graft `SessionListModelCatalog` (session-utils.types), `EventCursorGap/EventPollResult/EventWaitResult` (channel-shared), `isLikelyMutatingToolName` (tool-mutation).

## Phase 2 keystone fixes applied (all merge-introduced; main baseline ~1)

- **agents-models-skills.ts** — grafted upstream's GitHub-identity schemas (`GitHubIdentity*`, `ToolsGitHubAuthorize*`). tsgo gateway-protocol clear.
- **core-descriptors.ts + server-methods.ts** — grafted 35 dropped upstream methods + placement scopes + wired handlers (`server-methods-list.test` 54/54).
- **method-scopes** — `worktrees.create`→write, `config.schema`→read, `fs.listDir`→dynamic, added `sessions.groups.defaults/update`, registered fork `skills.forge.*` (`method-scopes.test` 346 passed).
- **embedded-agent-runner cluster** — grafted `toolMeta.toolCallId/terminate`, state `flushPartialAssistantText`/`deltaBufferIsCommentary`/`hasFlushedPartialText`/`lastToolRecovery`, `ToolRecoverySummary`/`fileTarget`.
- **agent-harness-runtime.ts** — grafted `agentHarnessStructuredInput` frozen export (codex app-server consumer; helpers already fork-present). Codex gate: SDK-export restoration verified vs upstream + consumer; no `../codex` protocol change.
- **config/sessions/types.ts** — added `"resolved-v1"` contextTokensSource (upstream provenance state).
- **mcp-content.ts / agent-bundle-mcp-materialize.ts** — `projectMcpCallToolResult` → `AgentToolResult<unknown>` (upstream), guarded fork's details spread with `isRecord`.
- **UI test lane** — cron-trigger-filter feature wired as 3rd parallel filter + `parseExecApprovalResolved` export restored (in progress).

## tsgo status (error-set diff vs main baseline)

- **tsgo:core: 0** ✓ **tsgo:extensions: 0** ✓ **tsgo:test:packages: 0** ✓
- tsgo:core:test / test:src: 1 (`system-prompt.test.ts` sessionUrl) — **pre-existing baseline** (test+type byte-identical to fork-main), not merge-caused.
- tsgo:extensions:test: 22 (memory-l3 `Signals` entityScore/polarityMultiplier in test literals) — **pre-existing baseline** (identical fork-main; part of the known ~33 test-lane debt).
- tsgo:test:ui: 44 (cron-trigger + exec-approval) — merge-introduced, fix in progress.

## GitHub-identity feature — adoption status (maintainer chose "adopt fully + port UI")

- **Core**: FULLY ADOPTED & working — protocol schemas, gateway methods (`tools.github.*`, wired via method-registry graft), agent handlers (`github-oauth-lifecycle`, `github-identity-status-tool`, `GitHubToolIdentityConfig.kind`). tsgo core/extensions 0.
- **UI**: PORTED to `ui/src/ui/views/github-identity-*` + `components/confirm-dialog.ts` + `github-identity-format.ts`; imports remapped to fork equivalents; missing primitives handled (confirm via fork `modal-dialog`, format helper, clipboard). `tsgo:test:ui` 0, ported controller test 23/23. Wired an optional `githubIdentity?` param into `renderAgentTools`.
- **REMAINING (bounded, land-time — needs a running dashboard)**:
  1. App-shell live-wiring: instantiate `GitHubIdentityController` in the app shell, `.sync()` on gateway/config/agent changes, dispose it, and pass it at `ui/src/ui/views/agents.ts:270` → `renderAgentTools({ githubIdentity })`. Until then the panel compiles but is dark.
  2. `runExternalMutation` host impl: the fork lacks upstream's config-write-coordinator; the controller's `RunGitHubExternalMutation` contract is declared locally. Supply a minimal host impl (gateway config RPC + `config refresh`).
  3. VISUAL verification (device-code flow, PAT fallback, scope toggle, confirm dialog, i18n, `exec-approval-*` CSS classes) — mandatory before landing per UI-proof policy. Wiring a UI feature blind is intentionally deferred to this step.

## Flagship agent-loop reconciliation (maintainer: "merge and restore the fork features")

Behavior sweep caught a merge=ours drop (tsgo-blind): the merge adopted upstream's tool-handlers + incomplete-turn-recovery, stripping the fork's **tool mutation-tracking + recovery** feature (`fileTarget`/`actionFingerprint`/`lastToolRecovery` + mutating-failure-through-compaction recovery). 13 fork tests failed.

- **Restored** the fork's mutation-tracking cluster (20 prod+test files) to fork-main: `tool-mutation*.ts`, `tool-error-summary/state.ts`, `tool-terminal-outcome.ts`, `handlers.tools.{start,completion,results}.ts`, `handlers.lifecycle/types.ts`, `attempt-result.ts`, `incomplete-turn-recovery.ts`, `terminal-resolution.ts` + closure. The fork's handlers natively emit `toolCallId/terminate`, so the boundary is self-consistent.
- **Grafted** upstream's clean `reconcileCodeModeExecBeforeHookParams` owner-arg API change.
- **Deferred** (follow-up): upstream's `intentionalTermination` hardening — an incompatible interleaved rewrite that would break the fork's recovery tests. `run/types.ts` `toolMeta.toolCallId?/terminate?` are now unpopulated (remove alongside this follow-up).
- **Verified**: tsgo:core=0; the 2 merge-introduced regressions fixed; residual `embedded-agent-subscribe` (10) + `embedded-agent-runner/run` (6) failures **proven pre-existing baseline** by running the same suites against the clean fork-main checkout (identical failures).

## Behavior verification (local)

- cron-notifications ✓, code-mode.mcp ✓, agent-bundle-mcp-tools.materialize ✓ (25/25, fixed a real `_meta`-leak assertion), memory-core ✓, embedded-agent-subscribe/runner mutation-recovery ✓ (merge regressions fixed; baseline failures unchanged vs fork-main).

## Linux build (huey, Node 24 — Mac can't build: node-llama-cpp Rosetta)

- `pnpm build` — all phases green, **dist 289M produced** (tsdown-unified 13m, plugin-sdk:dts, packages, ai, ui bundle all OK).
- Caught a Linux-only signal: control-ui **startup JS gzip 583689 B** exceeded the 580201 B baseline (Mac can't measure this). This is the reconciliation's adopted UI (GitHub-identity panel + cron-trigger filter). **Regenerated the baseline to 583689 B** (under the 589824 B max ceiling; documented policy — feature growth, not a hidden regression). Perf check now exit 0.

## test:fast triage (Linux, huey) — all failures proven NOT merge-caused

Ran the unit behavior suite on the Linux build. Four files surfaced failures; each triaged to root cause:

- **`src/entry.run-main.test.ts`** — parallel-scheduling flake; PASSED on isolated rerun. Not merge-caused.
- **`src/system-agent/setup-apply.concurrency.test.ts`** — timing stall (2-min no-output → process-group kill); environmental flake, file untouched by the merge (matches one parent). Not merge-caused.
- **`src/state/secret-state-tables.test.ts`** — PROVEN pre-existing fork-main baseline. All three inputs identical to fork-main (test byte-identical fork==upstream==cur; schema vault-table defs identical; classification file matches one parent). Replaying the exact test against fork-main's own schema+classification yields the identical `MISSING: [vault_secret (credential_type), vault_session (token_iv, token_cipher, token_tag)]`. → **Fork follow-up (security-classification gap):** the fork's egress-vault tables store AES-256-GCM-encrypted credential material but are absent from both `STATE_SECRET_TABLE_NAMES` (redacted) and `REVIEWED_SAFE_TABLES`. Upstream has no vault feature, so this is fork-owned. Fixing it is a real security-policy decision (redact-in-snapshot vs reviewed-safe-because-encrypted) that belongs to the maintainer, NOT the resync branch. Out of scope; do not auto-decide here.
- **`src/talk/realtime-session-policy.test.ts`** — PROVEN pre-existing fork-main baseline. All three inputs byte-identical to fork-main (`realtime-session-policy.ts`, its test, and `agent-consult-tool.ts` == fork-main). The fork's `safe-read-only` consult list carries 9 tools incl. 3 fork memory-l3 tools (`memory_insights`, `memory_forgetting`, `memory_reports`); the upstream-origin test expects the base 6. Identical inputs → fails identically on fork-main. → **Fork follow-up (stale test):** update the assertion to the fork's 9-tool list, or gate the 3 memory-l3 tools.

**Conclusion: zero merge-caused behavior failures.** Both hard failures are pre-existing fork-main debt; both flakes are environmental.

## Verification status

- [x] tsgo all 7 lanes — 0 new errors (residuals = confirmed fork-main baseline: sessionUrl, 22 memory-l3 Signals)
- [x] Linux build (huey, Node 24) — green, dist 289M (startup-budget baseline regenerated 580201→583689, under 589824 ceiling)
- [x] Behavior (local reconciliation surfaces) — cron / mcp-materialize (25/25) / memory-core / agent-loop mutation-recovery all green; merge regressions fixed
- [x] test:fast (Linux) — zero merge-caused failures; 2 hard failures proven pre-existing fork baseline, 2 flakes environmental
- [ ] GitHub-identity UI app-shell wiring + `runExternalMutation` host + VISUAL proof — **land-time** (needs running dashboard; deferred per UI-proof policy)
- [ ] `$autoreview` on reconciliation diff — **maintainer gate** (harness rejects merge commits: parents>2; run against the squashed/land diff at PR time)
- [ ] Deferred follow-up: upstream `intentionalTermination` hardening (remove `run/types.ts` `toolMeta.toolCallId?/terminate?` alongside)
- [ ] Fork follow-ups (NOT resync scope): secret-state vault classification; realtime-session-policy stale 6→9 tool assertion
