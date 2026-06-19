# RESYNC_LEDGER — upstream/main → cortex (pass 1: layers 1–4)

Merge base `e06f6ffc` (2026-06-07) · upstream/main `324ad548a8` (2026-06-19) · branch `resync/upstream-2026-06-19`.

## Merge mechanics (from controlled dry-run)

`git merge upstream/main` with `merge.ours.driver=true` active:
- **4,505 files auto-merged from upstream** + **694 added** + 212 deleted — the bulk of upstream's 2,356 commits flow in cleanly (files we never touched).
- **82 true conflicts** (59 UU both-modified, 21 DU deleted-by-us/modified-by-them, 1 UD, 1 UA).
- **~42 files in layers 1–4 silently kept-ours** by `merge=ours` (both sides modified, no conflict raised) → upstream's improvements were discarded; these need **deliberate ours-vs-upstream review**, not the auto-resolution they got.

## Disposition legend
- **AUTO** — let merge driver resolve; spot-verify.
- **KEEP-OURS** — fork behavior is the point; upstream change incompatible/irrelevant (cite).
- **ADOPT-UPSTREAM** — fork code was incidental; take upstream.
- **ENHANCE-OURS** — graft upstream's fix/perf into our version, keep fork behavior.
- **REGEN** — generated artifact; regenerate, don't hand-merge.
- **DEFER** — layer 5–8; pass 2.

Per-change rubric: evaluate upstream's change in isolation → in fork context → decide ADOPT/ENHANCE/KEEP. Log verdict per file below as reconciled.

---

## Layer 1 — Protocol & shared schemas

### Conflicted (must resolve)
| File | Type | Disposition | Notes |
|---|---|---|---|
| `packages/gateway-protocol/src/schema/exec-approvals.ts` | UU | reconcile | upstream renamed `ExecApprovalDecisionSchema`→`ExecApprovalsFileSchema`; our exec-policy consumes it |
| `packages/agent-core/src/agent-loop.ts` | UU | reconcile | core loop; both touched |

### Silently kept-ours (deliberate review — upstream improvements dropped)
`packages/gateway-protocol/src/index.ts`, `schema/agent.ts`, `schema/agents-models-skills.ts`, `schema/protocol-schemas.ts`, `schema/types.ts`, `packages/agent-core/src/agent.ts`, `src/types.ts`.
→ **gateway-protocol reconciler agent**: decide authoritative session schema (our `session-row.ts` vs upstream `sessions.ts`), consolidate approval/session/presence event types, re-export what consumers need. ENHANCE-OURS default (keep our added types, fold upstream's new ones).

---

## Layer 2 — Config & state/sessions store

### Conflicted
| File | Type | Disposition | Notes |
|---|---|---|---|
| `src/config/zod-schema.ts` | UU | reconcile | config schema; both touched |

### Silently kept-ours
`src/config/sessions/store.ts` (upstream +1114), `src/config/sessions/types.ts`, `src/state/openclaw-state-db.ts`, `openclaw-state-schema.sql`, `*.generated.*` (REGEN).
→ **sessions-store reconciler agent**: graft upstream's store rewrite (perf/correctness) onto our session types; keep DB migration. State `.generated.*` + `.sql` are DB-first — reconcile schema both-sides then regenerate.

---

## Layer 3 — Agent core & runner (heaviest)

### Conflicted
| File | Type | Disposition | Notes |
|---|---|---|---|
| `src/agents/embedded-agent-runner/run/attempt.session-lock.ts` | UU | ENHANCE-OURS | our session-lock/steering ⟷ upstream rewrite — graft upstream fixes, keep steering fence |
| `src/agents/model-catalog.ts` | UU | reconcile | model catalog; fork feature |
| `src/agents/sessions/tools/read.ts` | UU | reconcile | |
| `src/agents/tools/skill-workshop-tool.ts` | DU | KEEP-OURS? | convergent: upstream skill-workshop ≈ our skill-forge; likely keep our skill-forge-tool, drop |
| `src/agents/harness/agent-end-side-effects.test.ts` | DU | reconcile | test for both-evolved harness |

### Silently kept-ours (HEAVY — deliberate review)
`embedded-agent-runner/run.ts`, `run/attempt.ts`, `compact.ts`, `compact.types.ts`, `run/compaction-retry-aggregate-timeout.ts`, `run/incomplete-turn.ts`, `run/params.ts`, `run/types.ts`, `run/attempt-tool-construction-plan.ts`, `stream-resolution.ts`, `run/llm-idle-timeout.ts`, `model-fallback.ts`, `extra-params.ts` (KEEP-OURS — Feature A SSE).
→ **agent-runner reconciler agent** (may split per-file): upstream's compaction/crash/perf rewrite vs our session-lock + steering. Per-file ADOPT/ENHANCE/KEEP; replay-test compaction + failover. This is the highest-risk reconciliation.

---

## Layer 4 — Gateway, infra, cron

### Conflicted
| File | Type | Disposition | Notes |
|---|---|---|---|
| `src/gateway/session-reset-service.ts` | UU | reconcile | both rewrote; upstream removed `extractFirstUserMessageText`/`preserveResetSessionForDiscovery` (our additions) |
| `src/gateway/server-methods/skills.proposals.test.ts` | DU | reconcile | skill-workshop convergent |
| `src/infra/agent-events.ts` | UU | ENHANCE-OURS | upstream security-event pipeline ⟷ our agent-execution-events |
| `src/infra/exec-approvals.ts` | UU | reconcile | upstream `ExecApprovalsFileSchema` rename |
| `src/infra/state-migrations.ts` | UU | reconcile | DB migrations — careful, additive |
| `src/logging/redact.ts` | UU | ENHANCE-OURS | **confirmed drift**: our `registerDynamicSecret`/`scrubDynamicSecrets` ⟷ upstream redact changes |

### Silently kept-ours
`src/gateway/server-chat.ts`, `server-chat-state.ts` (KEEP-OURS — Feature C thinking-stream), `server-methods.ts`, `server-methods/agent.ts`, `server-methods/chat.ts`, `server-methods/skills.ts`, `server-session-events.ts`, `src/infra/outbound/deliver.ts`, `update-startup.ts`, `update-managed-service-handoff.ts`, `npm-registry-spec.ts`.
→ **gateway-chat reconciler agent**: `server-methods/chat.ts` (ours +297/up +833) — graft upstream's chat-method improvements, keep Feature C thinking-stream wiring.
→ **cron-delivery reconciler agent**: `src/cron/store/delivery-codec.ts` (kept-ours; unify `delivery_completion_channel/_account_id/_thread_id` vs upstream `_mode/_to`; write doctor migration).

### Cross-layer drift-fixups agent (layers 1–4)
2 confirmed upstream removals (`agentCredentialsEqual`, `AUTH_STORE_LOCK_OPTIONS`); barrel/rename re-points (`SessionsListResult`→`SessionsFilesListResult`, `PresenceEvent`→`PresenceEntry`, etc.); add deps `smol-toml`, `fast-check`.

### Regenerate / take-theirs
`package.json` (reconcile deps), `pnpm-lock.yaml` (REGEN via `pnpm install`).

---

## Deferred to pass 2 (layers 5–8) — provisional keep-ours/regen at this merge
- **Skills/workshop (L6)**: `src/skills/workshop/{config,policy,service,store,types}.ts` (+tests), `src/cli/skills-cli*.ts`, `docs/tools/skill-workshop*.md` — convergent with our skill-forge; provisional KEEP-OURS (deep treatment pass 2).
- **Skills/research (L6)**: `src/skills/research/autocapture.ts` (+test).
- **Extensions (L7)**: `extensions/workboard/src/*` (convergent plugin→core), `extensions/codex/src/app-server/thread-lifecycle.ts` (+test), `extensions/copilot/src/replay-shim.ts`.
- **UI (L8)**: `ui/src/i18n/**` (REGEN/take-theirs — 38 files), `ui/src/ui/views/workboard.test.ts`, `ui/src/ui/controllers/skill-workshop.ts`, `ui/src/styles/skill-workshop.css`, `ui/src/ui/app-lifecycle.ts`.
- **Other**: `scripts/e2e/npm-telegram-rtt-docker.sh` (UD — upstream deleted; take deletion), `src/workboard/sqlite-store-policy.test.ts` (UA).

UI/extension tsgo lanes expected RED at the pass-1 checkpoint — by design.

---

## PASS 1 OUTCOME (2026-06-19) — FOUNDATIONAL GREEN

Commits on `resync/upstream-2026-06-19`:
- `362baacbc0` merge upstream/main (2,356 commits; 4,505 auto-merged, 82 conflicts resolved)
- `324ea7c7c5` reconcile layers 1-4 to green (Wave-1 4 agents + Wave-2 agent + manual)
- `6ea7510a5e` regenerate fork-config baseline

**tsgo gate (layers 1-4 = core + extensions, non-UI/non-codex): 0 errors.**
Deferred to pass 2 (red by design): UI 97, codex+copilot 34.

Key convergent verdicts:
- `config/sessions/store.ts` — ADOPT-UPSTREAM (was upstream's base + additive rewrite) + graft fork `runQuotaSuspensionMaintenance`.
- `config/sessions/types.ts` — ENHANCE: graft upstream `restartRecoveryRuns`/`RestartRecoveryRun`; keep fork `messageToolPolicyHash`.
- agent-runner (`run.ts`/`attempt.ts`/subscribe/model-fallback) — ENHANCE: graft upstream rate-limit-retry + exhaustion-result; preserve fork steering/session-lock.
- `infra/exec-approvals.ts` — KEEP-OURS wire alias (wire type already complete); restore fork `analyzeShellCommand` in exec-approvals-analysis.
- `infra/agent-events.ts` — ADOPT upstream explicit payload type; graft `emitAgentPlanEvent`.
- `redact.ts` — ENHANCE (fork scrub + upstream redactFormBodies). `model-catalog.ts` — ENHANCE (fork discovery + upstream cache).
- `agent-auth-json.ts` — adapt to upstream `AgentCredentialMap` rename.
- memory-l3 — adapt to upstream `AgentMessage` union + embedding API; prune dead code.

Pass-2 ENHANCE candidates flagged: `server-chat.ts` run-terminal-persistence tracking (kept-ours, unused bindings removed); `attempt.ts` quota model (still calls fork `runQuotaSuspensionMaintenance`).

## PASS 2 TODO (layers 5-8)
- Workboard convergent reconcile (extensions/workboard plugin→core vs upstream ops UI + src/workboard).
- Skills/workshop ⟷ skill-forge convergent reconcile (DU keep-deleted provisional this pass).
- Codex/copilot (34 tsgo errors) — codex app-server convergent; respect AGENTS.md codex hard gate.
- UI (97 tsgo errors) — app-render/chat/cron + i18n regeneration.
- Cron delivery schema (`delivery-codec.ts` columns) + doctor migration.
- Then: full 7-lane tsgo green, fork-merge-verify --full, $autoreview, Crabbox behavior proof, land.
