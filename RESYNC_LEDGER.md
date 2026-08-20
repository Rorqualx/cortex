# Resync Ledger — resync-staging/2026-08-19

Merge: fork `5657018950c` ← upstream `a3ca8466` (base `e45a9460`, 2063 commits behind).
75 conflicts. Foundation-first; convergent product decisions DEFERRED to maintainer.

## Convergent product decisions — MAINTAINER APPROVED "keep-fork on all four" (2026-08-19)

- **Workboard (22) — RESOLVED keep-fork.** Kept fork's `src/workboard` LLM-loop (40 files); `git rm`'d upstream's 13 `extensions/workboard/*` (fork deleted that plugin) + 9 upstream-only `src/workboard/*` ops files (stage-3-only, would pollute the fork loop).
- **Agent-loop — PENDING (keep-fork + graft).** `packages/agent-core/src/agent-loop.ts`. Fork rewrote +459/−871; upstream only +28/−16. Keep fork; evaluate whether upstream's small delta is a fix worth grafting.
- **Codex — PENDING (owner-gated).** `extensions/codex/src/app-server/thread-prompt.ts`. Keep-fork decided, but MUST inspect `../codex` source before finalizing per AGENTS.md.
- **Skill-workshop — RESOLVED keep-fork-trimmed.** Fork keeps 6 production files, deleted the 3 tests + 1 doc that exercise upstream's fuller version → `git rm`'d those (kept deleted).

## Foundation resolutions (cont.)

| File | Verdict | Note |
|------|---------|------|
| `src/gateway/server-core-runtime.ts` | ENHANCE | keep fork `allowGatewaySubagentBinding` loaders + graft upstream `getPluginMetadataSnapshot` |
| `src/gateway/control-ui-contract.ts` | KEEP-OURS | fork owns Control UI bootstrap config |
| `src/infra/plugin-approvals.ts` | KEEP-OURS | documented wire-alias pattern |
| `packages/agent-core/src/agent-loop.ts` | KEEP-OURS+graft | kept fork steering rewrite; grafted upstream's safer `asOptionalRecord` taint extraction + auto-merged `replaceCompactionReplayOwnerContent`; dropped duplicate `SourceEventStream` import + unused `coerceErrorMessage` |
| `extensions/codex/src/app-server/thread-prompt.ts` | KEEP-OURS (owner-gated) | restored fork version (skill-forge only); auto-merge had created a broken hybrid pulling upstream delegation/harness-reply calls whose source `buildHarnessVisibleReplyGuidance` isn't in the fork. `../codex` inspected; conflict is OpenClaw prompt-composition, not codex protocol |
| `extensions/zai/{index,index.test,provider-policy-api}.ts` | KEEP-OURS | fork reasoning-effort ladder subsumes upstream version-map; dropped unused upstream imports (reconciler agent) |

## FLAG (RESOLVED — false alarm)
- Checked whether `merge=ours` dropped upstream's delegation-guidance/harness-visible-reply. Sources all present in merged tree (`src/agents/delegation-guidance.ts`, `src/auto-reply/source-reply-delivery-mode.ts`, `src/agents/system-prompt-config.ts`); barrel re-exports; `extensions/copilot` consumer intact. No graft needed.

## Native app protocol mirrors (reconciler agent + lead correction)

- `apps/android/.../GatewayProtocol.kt` — ADOPT-UPSTREAM (`.subscribe` + `sessionPreview`); fork's plain entry mirrored an unregistered method.
- `apps/ios/Tests/SwiftUIRenderSmokeTests.swift` — UNION tests; agent restored fork helper defs (`rootTabsGatewayStateModels` etc.) dropped by a lossy auto-merge.
- `apps/.../GatewayModels.swift` — mostly union of real fragments (fork approvals + upstream portals). **LEAD CORRECTION:** agent made `AgentsDeleteResult` follow upstream (`removed`/`failed`/`purgeFailed`); provenance shows the FORK deliberately trimmed those (BASE had them, FORK removed them) → corrected the Swift struct to the fork's 3-field shape (`ok`/`agentId`/`removedBindings`) matching the merged TS. Lesson: reconciler ADOPT verdicts on fork-divergent surfaces need lead provenance check.

## Progress: 47/75 resolved. Remaining: src/agents (12), src/gateway (9), misc (9), pnpm-lock. 3 agents in flight.

## Misc singles (reconciler agent + lead verification)

- `src/sessions/user-turn-transcript.ts` — ENHANCE (fork file-target persistence + grafted upstream `confirmPersistedSteerTargetRunId`).
- `src/auto-reply/reply/commands-steer.runtime.ts` (UD) — KEEP-FORK (fast-steer.ts uses its exports).
- `src/cron/isolated-agent/run-prepare.ts` — ENHANCE (both fork+upstream imports used).
- `src/plugin-sdk/test-helpers/plugin-runtime-mock.ts` — KEEP-FORK (`resolveSessionFilePath`).
- `src/plugins/bundled-plugin-metadata.test.ts` — ENHANCE (kept `harness-guardrails`; dropped `linux-canvas`, upstream renamed→`canvas`).
- `extensions/memory-l3/index.test.ts` (AA) — KEEP-OURS (fork engine).
- `docs/docs.json` — nav union (added `custodian-skills`; omitted nonexistent `skill-workshop`).
- `scripts/check-protocol-registry.mts` — ADOPT-UPSTREAM; **removed orphaned `packages/gateway-protocol/src/schema-export-registry.ts`** (zero importers; upstream `public-schema.ts` wired at index.ts:44).
- `src/cli/skills-cli.ts` — **ADOPT-UPSTREAM (soft deviation, flagged).** Restores workshop/curator CLI to satisfy auto-merged upstream sibling tests. Coherent since fork keeps skill-workshop tooling (6 prod files); NOT a fork-feature conflict. User may veto → full keep-fork-trim (revert + rm curator/workshop-cache tests).

## Progress: 53/75 resolved. Remaining: src/agents (12), src/gateway (9), pnpm-lock. 2 agents in flight.

## Gateway (reconciler agent + lead cross-file fix)

- `server-model-catalog.ts` / `.test.ts` — ENHANCE (upstream owner-snapshot refactor + fork `allowGatewaySubagentBinding` graft).
- `server-runtime-services.ts` — ENHANCE (fork return shape + upstream `resolveGatewayContext` param).
- `server-startup-post-attach.test.ts` — ADOPT-UPSTREAM (dropped fork Gmail-watcher test; upstream consolidated into server-close.test.ts; no fork assertions lost).
- `chat-send-agent-dispatch.ts` — ENHANCE (both `onAssistantMessagePersisted` fork + `skillWorkshopProposalRevision` upstream).
- `chat-send-dispatch-errors.ts` — ENHANCE (upstream finalize/cleanup structure + fork session-awareness release).
- `doctor.ts` — ENHANCE (upstream `createDoctorHandlers` factory + fork `doctor.memory.l3Layers`; dropped dead `doctor.memory-core-runtime.js` import).
- `authenticated-request-dispatch.ts` — ENHANCE (fork `noteStaleDistCandidateError` + upstream `classifyGatewayStaleInstall`).
- `server-methods-list.test.ts` — UNION (no-drop, counts verified). **⚠ POST-BUILD TODO: regenerate this golden file from live `listGatewayMethods()`/`listCoreGatewayMethodNames()` — line-merge can't guarantee true registration order.**
- **LEAD cross-file fix:** `server-methods.ts:158` `module.doctorHandlers` → `module.createDoctorHandlers()` (auto-merged file referenced the renamed export; factory has default runtime param).

## Progress: 62/75 resolved. Remaining: src/agents (12), pnpm-lock. 1 agent in flight.

## src/agents (reconciler agent + lead verification)

- `agent-bundle-mcp-materialize.ts` — ENHANCE (preserved fork untrusted-MCP fencing over upstream's `projectMcpCallToolResult` extraction).
- `agent-bundle-mcp-tools.materialize.test.ts` — ENHANCE (fenced assertions; agent also adapted 4 auto-merged upstream tests to the fencing invariant).
- `agent-scope-config.ts` — ENHANCE (fork legacy-compat resolver + grafted upstream's 4 new agent-id resolvers).
- `btw.ts` — ADOPT converged (removed stale duplicate).
- `command/post-run.ts` — KEEP-OURS + restored dropped `embeddedAssistantGapFill` decl (lossy auto-merge repair).
- `embedded-agent-runner/run/llm-idle-timeout.ts` — ENHANCE (kept upstream `abortable`, dropped dup import).
- `provider-request-config.ts` — ENHANCE (fork `maxConcurrentRequests` + upstream `trustConfiguredBaseUrlOrigin`; dropped fork's `privateNetworkExplicitlyDenied`, zero consumers).
- `provider-transport-fetch.ts` — ENHANCE (fork `releaseSlot` + upstream `throw remediatedError`).
- `session-transcript-repair.ts` — KEEP BOTH (distinct fork fast-path + upstream `sanitizeToolUseResultPairingForModel`).
- `sessions/settings-manager.ts` — ADOPT-UPSTREAM type extraction + **cross-file graft: added fork's `preemptOnSteer?` to new `settings-storage.ts`** (verified line 86).
- `tools/web-fetch.ts` — ENHANCE (kept fork egress allowlist + SSRF-default merge; dropped 3 derived booleans upstream replaced with whole-object hash).
- `tools/sessions-list-tool.test.ts` — ADOPT-UPSTREAM (mainSessionKey mock + upstream ownership tests).

## SECURITY verified
- **MCP fencing**: fork fences untrusted MCP content ONLY in materialize.ts (fork never fenced node-plugin-tools.ts / mcp-content.ts). Agent preserved materialize.ts fencing; node-plugin-tools.ts unchanged = matches fork. No regression.
- **web-fetch SSRF/egress**: fork allowlist + SSRF-default merge preserved.

## ALL 62 code conflicts resolved (repo-wide marker scan clean). pnpm-lock regenerating. Next: commit → tsgo ladder → regenerate golden method-list → remote-Linux build+behavior+autoreview.

## VERIFICATION (Phase 2) — merge committed as 85b4da0b451

- **tsgo:core: merged=277 errors, main baseline=0 (clean).** All 277 are merge-caused cascade (NOT a pre-existing red baseline — memory of ~300 was stale; the 2026-07 resync fixed it). Expected Phase-1 tail: "drive foundation to tsgo-green; cascades collapse from a few keystones."
- **Keystone 1 — `packages/gateway-protocol/src/schema/agents-models-skills.ts`:** heavy-convergent file (fork refactored +593/−461: closedObject→Type.Object + AgentOwnership). `merge=ours` correctly kept the fork refactor but DROPPED upstream's +143 additions: `ToolsGitHub*Schema` (Status/Configure/Managed/Inherit + GitHub identity helper schemas), `SkillsProposalDecisionParamsSchema`, `ModelCatalogProviderOutcomeSchema`. Cascades into public-schema.ts, protocol-schema-fragment-agents-skills.ts, tools-github.ts, github-tool-identity (~40+ errors). FIX: ENHANCE — graft upstream's additions onto the fork's version (all upstream-new, absent at BASE+FORK, no fork conflict). `git apply -3` no-ops; needs manual block extraction or a cleaner 3-way.
- **Keystone 2 — session entry core types** (`SessionEntryCore`, `InternalSessionEntryCore`, `EmbeddedRunAttemptWithReceiptEvidence`): missing upstream's `contextTokensSource` + `permissionMode` fields → ~30+ TS2551/2561 across sessions/embedded-runner/auto-reply. FIX: graft the fields onto the fork's session entry types.
- Error TS distribution: 115 TS2339, 32 TS2322, 31 TS2551, 28 TS2353 — all "property missing on type" = keystone-type drops, per skill.

## REMAINING to land: graft 2 keystones → re-run tsgo to green → regenerate server-methods-list golden test → remote-Linux `pnpm build` + `pnpm test:fast` behavior → `$autoreview` on reconciliation diff. Build/tests will NOT pass until cascade driven to green.

## Phase 2 cascade grafts (tsgo:0 drive)

- Keystone 1 (agents-models-skills.ts github/skills schemas) + Keystone 2 (session permissionMode/contextTokensSource/sessionRoot): 277→193. Committed a1ac1ecfe81.
- **Silent-combination repairs (merge auto-merged upstream into fork files whose support the fork trimmed/removed):**
  - Workboard (5 files: dispatcher-workspace, persistence-types, store-change-tracker, store-promote, workspace-access) → restored fork versions (had picked up upstream `compensateWorkspaceMutation`/`updateLatestCard` from the removed store-compensation.ts).
  - `agents.commands.delete.ts` → restored fork (referenced upstream `removed`/`failed`/`purgeFailed`, which the fork trimmed from AgentsDeleteResult).
  - `src/cli/skills-cli.ts` → reverted to fork keep-fork-trim (earlier ADOPT-upstream cascaded missing GATEWAY_SKILLS_*_TIMEOUT_MS + SkillProposalDraftCliOptions). TEST-LANE follow-up: remove leaked upstream `skills-cli.commands.test.ts` that tests the reverted workshop/curator CLI.
- Parallel reconciler agents grafting remaining clusters: session-ownership feature (owner/participants/avatar + SessionOwnerFacetIdentity), embedded-runner (attempt/compaction types), github-tools runtime (ToolsConfig/AgentToolsConfig).

## ✅ tsgo:core = 0 (277 → 193 → 66 → 53 → 7 → 0). Committed 97da6187d37.

Driven via keystone + cascade grafts of merge=ours silent drops (5 reconciler agents + lead), all verified centrally. Main baseline is 0, so this is a true green.

## ✅ ALL 7 tsgo lanes: 0 merge-caused errors (committed 9543634f4d5)
- core: 0. extensions: 21 (all pre-existing memory-l3, = main baseline). extensions:test: 33 (pre-existing memory-l3). core:test/test:src/test:ui/test:packages: 2 each (generated ui `virtual-locale.d.ts`/`novnc.d.ts`, untracked, built on UI/i18n gen).
- Cleared: agent-harness-runtime barrel export drops (delegation-guidance/harness-reply/side-effect-owner/native-compaction), copilot skill-workshop→skill-forge, fork zai test restore.
- memory-l3 is a KNOWN pre-existing fork-red baseline (fork-only, untouched by merge, identical count on main); NOT a resync regression.

## REMAINING to land (Definition of Done):
- [ ] TEST-LANE debt from keep-fork reverts: remove leaked upstream `skills-cli.commands.test.ts` (+ any workshop/curator CLI tests) that test the reverted CLI
- [ ] Regenerate `server-methods-list.test.ts` golden file from live `listGatewayMethods()`
- [ ] FOLLOW-UP: restore embedded-transcript dedup guard (`readTailAssistantTextFromSessionTranscript` dropped by merge; agent restored only the skipUserTurn half)
- [ ] `fork-config-snapshot verify` + regenerate baseline
- [ ] Remote-Linux `pnpm build` + `pnpm test:fast` behavior
- [ ] `$autoreview` on the full reconciliation diff

## Progress: 41/75 resolved. Remaining: src/agents (12), src/gateway (9), native-apps (3), misc (9), pnpm-lock (regenerate) — reconciler agents in flight.

## Foundation resolutions

| File | Verdict | Note |
|------|---------|------|
| `packages/gateway-protocol/src/schema-modules.ts` | UNION (both additive) | kept fork `sessions-catalog` + upstream `session-github-publication`; both modules exist |
| `pnpm-workspace.yaml` | KEEP-OURS | `node-llama-cpp: false` — deliberate fork x64/Rosetta deploy fix |
| `packages/normalization-core/package.json` | ENHANCE-OURS | union build entry points: keep `format.ts`, graft upstream `markdown-plain-text.ts` |

## Derived (regenerate, do not hand-merge)

- `pnpm-lock.yaml` — regenerate via `pnpm install` after package.json/workspace settle.
