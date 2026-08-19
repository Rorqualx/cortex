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

## Progress: 41/75 resolved. Remaining: src/agents (12), src/gateway (9), native-apps (3), misc (9), pnpm-lock (regenerate) — reconciler agents in flight.

## Foundation resolutions

| File | Verdict | Note |
|------|---------|------|
| `packages/gateway-protocol/src/schema-modules.ts` | UNION (both additive) | kept fork `sessions-catalog` + upstream `session-github-publication`; both modules exist |
| `pnpm-workspace.yaml` | KEEP-OURS | `node-llama-cpp: false` — deliberate fork x64/Rosetta deploy fix |
| `packages/normalization-core/package.json` | ENHANCE-OURS | union build entry points: keep `format.ts`, graft upstream `markdown-plain-text.ts` |

## Derived (regenerate, do not hand-merge)

- `pnpm-lock.yaml` — regenerate via `pnpm install` after package.json/workspace settle.
