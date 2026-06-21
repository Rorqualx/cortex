# Cortex Fork — Divergence Analysis vs. upstream OpenClaw

**Date:** 2026-06-18
**Fork:** `Rorqualx/cortex` (branch `main`)
**Upstream:** `openclaw/openclaw` (branch `main`)
**Last common ancestor:** `e06f6ffc` — 2026-06-07

---

## 1. Headline numbers

| Metric                                          | Cortex (ours)   | Upstream         | Notes                                                                   |
| ----------------------------------------------- | --------------- | ---------------- | ----------------------------------------------------------------------- |
| Commits since merge base                        | **324**         | **2356**         | Both diverged from 2026-06-07. Upstream is extremely active (~12 days). |
| Files changed vs base                           | 769             | 5602             |                                                                         |
| Net lines                                       | +92.9k / −18.7k | +469.6k / −93.9k | We added ~74k net; upstream ~376k net.                                  |
| Files we changed that upstream **also** changed | —               | —                | **274 overlap files** = the merge-conflict surface.                     |

**Bottom line:** We are ~11 days behind a fast-moving trunk. The two histories have drifted far enough that this is a **re-integration project, not a fast-forward**. The good news: our signature features are almost entirely greenfield directories upstream never touched, so the conflict surface (274 files) is concentrated and predictable rather than spread across everything we built.

---

## 2. What Cortex added (our identity)

Commit themes (by conventional-commit scope): `ui` (61), `memory-l3` (50), `workboard` (13), `agents` (12), `conversations` (8), `plugins` (7), `skill-forge` (6), `cron` (6), `chat` (6), `swarm` (4), `memory-fork` (4).

### 2a. Fork-exclusive feature directories — **zero upstream collision**

These directories do not exist upstream at all (upstream changed **0** files in each). They are clean additions and will merge without content conflicts — though they consume upstream APIs that have since been refactored (see §4):

| Directory                     | Files | What it is                                                                                                   |
| ----------------------------- | ----- | ------------------------------------------------------------------------------------------------------------ |
| `extensions/memory-l3`        | 58    | **L3 long-term memory** subsystem — the largest fork feature.                                                |
| `src/model-catalog`           | 39    | Live model catalog / provider+model discovery (Z.AI/GLM live `/models`, deprecated-model reassignment).      |
| `src/skill-forge`             | 33    | **SkillForge** — auto-forging of recovery skills.                                                            |
| `src/agents/tools/delegation` | 32    | **agentmcp delegation moved into core** (GLM/DeepSeek/Kimi sub-agent routing; replaced external MCP server). |
| `src/compression`             | 16    | Transcript/context compression.                                                                              |
| `src/workboard`               | 14    | Core-side workboard logic (idea→goal→impl→task loop; see §3).                                                |
| `src/attestation`             | 10    | Codex attestation scaffolding (READY but no-op/discarded by default).                                        |
| `src/session-awareness`       | 10    | Session-awareness layer.                                                                                     |
| `src/exec-policy`             | 9     | Exec-policy enforcement (wired).                                                                             |
| `src/agents/grounding`        | 8     | Agent grounding.                                                                                             |

These ten directories are the heart of the "Cortex" identity. None of them risk a textual merge conflict.

### 2b. Heavy UI work

61 `ui` commits — skill-workshop styling (+1.6k lines `skill-workshop.css`), chat view rework, app-render rework (+1.7k `app-render.ts`), new views. This is where we **do** collide with upstream (upstream also reworked the UI heavily — see §4).

---

## 3. Convergent / shared-feature evolution: **Workboard**

`extensions/workboard` already existed at the merge base as an upstream plugin. **Both forks then evolved it independently:**

- **Cortex** rewrote the storage (fixed a split-brain store: CLI wrote the legacy plugin DB while gateway/UI read the shared core DB → unified + migrated cards) and closed the **LLM idea→goal→impl→task loop** (agent tools + specify/decompose RPC, gateway dispatcher, 60s autonomous tick). Net heavy changes to `extensions/workboard/src/tools.ts` (+1035 lines) and new `src/workboard/*`.
- **Upstream** built out the **Workboard operations UI** (`ui/src/ui/views/workboard.ts`, `controllers/workboard.ts`, "hide empty columns" #89615, "Polish Workboard operations view" #90057) — a 7.3k-line test file and ~1.9k-line controller.

**This is the single most dangerous merge zone.** Same feature, divergent internals, both touching storage and UI. A naive merge will produce a workboard that satisfies neither. Plan to manually reconcile: take upstream's UI/ops layer, re-apply our store-unification + LLM-loop on top.

---

## 4. What upstream did (and where we collide)

Upstream's 2356 commits skew heavily toward **hardening**: 1386 `fix`, 429 `refactor`, 217 `test` — vs only 73 `feat`. This is a stabilization-and-refactor wave, which is the worst kind to be behind on, because refactors silently move the ground under our greenfield code's feet.

### Top upstream scopes

`agents` (244), `gateway` (83), `release` (80), `ui` (68), `telegram` (66), `memory` (47), `plugins` (44), `cron` (42), `codex` (32), `providers` (27), `config` (27), `channels` (17), `plugin-sdk` (17).

### Notable upstream features we'll want

- **Security/audit event pipeline** — a whole new `feat(security)`/`feat(diagnostics)` family: audit summary events, OTLP export, security events for installs/exec-approvals/auth-handshakes/device-pairing/tool-vetoes.
- **Provider externalization wave** — Cohere, GMI, and an "official provider batch" moved out of core into plugins; ClawRouter managed proxy; GLM-5.2 and Kimi K2.7 Code support; OpenRouter Fusion panel. **Directly relevant to our delegation/model-catalog work.**
- **Usage/footer rework** — native templated `/usage` renderer that _retires the footer plugin_; per-turn `usageState` on `reply_payload_sending`; real context-occupancy atoms.
- **Telegram rich messages** (rich HTML, durable verbose-progress routing), Codex remote app-server plugins + network proxy profiles, `/name` to rename sessions, `/btw` in CLI sessions.
- **Claude Fable 5 adaptive thinking** support (`feat(anthropic)`).

### The 274-file conflict surface — by directory

| Dir                                           | Overlap files | Risk                                                                                                                                                                         |
| --------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/agents`                                  | 27            | **High** — upstream did 244 agent commits; our agents work sits on shifting sand.                                                                                            |
| `ui/src/ui` (+ chat/views/styles/controllers) | ~50           | **High** — both reworked UI heavily.                                                                                                                                         |
| `ui/src/i18n` locales/baseline                | ~38           | Mechanical but noisy (regenerate).                                                                                                                                           |
| `src/agents/embedded-agent-runner/run`        | 10            | **Critical** — upstream rewrote `attempt.session-lock.ts` (+1257 lines) and `run.ts` (+836); this is the core agent loop + the session-lock behavior our notes already flag. |
| `src/gateway` (+ server-methods)              | 14            | `server-methods/chat.ts` changed both sides (ours +297 / up +833).                                                                                                           |
| `src/config/sessions/store.ts`                | 1             | Upstream rewrote (+1114); we touched lightly — take theirs, re-apply our delta.                                                                                              |
| `packages/gateway-protocol/src/schema`        | 5             | Protocol drift — reconcile carefully, additive-first.                                                                                                                        |
| `extensions/workboard/src`                    | 6             | See §3.                                                                                                                                                                      |

**Highest single-file churn collisions** (lines changed each side): `workboard.test.ts` (up 7303), `pnpm-lock.yaml` (up 3437 — regenerate, don't merge), `app-render.ts` (ours 1753 / up 399), `views/chat.ts` (ours 725 / up 1153), `attempt.session-lock.ts` (up 1257), `gateway/server-methods/chat.ts` (ours 297 / up 833), `config/sessions/store.ts` (up 1114).

---

## 5. Hidden risk: silent API drift on greenfield code

Our 10 fork-exclusive directories won't show as git conflicts — but they **import** from `src/agents`, `src/gateway`, `plugin-sdk`, `gateway-protocol`, and `src/config`, all of which upstream refactored hard (429 refactor commits). After any merge, expect our memory-l3 / skill-forge / delegation / compression code to **compile-break** against moved/renamed/re-typed upstream APIs even with zero textual conflicts. The agent-runner rewrite (`run.ts`, `attempt.ts`, session-lock) and the config/sessions store rewrite are the most likely to break our consumers. Budget a full `tsgo` pass + targeted fixes as the _second_ phase after textual conflict resolution.

---

## 6. Recommended re-integration strategy

1. **Don't fast-forward or blind-merge.** 2356 upstream commits + 274 overlaps means a single `git merge` is a wall of conflicts. Stage it.
2. **Regenerate, don't merge, derived files:** `pnpm-lock.yaml`, `ui/src/i18n/.i18n/*baseline*`, locale files. Take upstream, regenerate.
3. **Phase 1 — textual conflicts**, in dependency order: protocol/schema → config/sessions store → gateway server-methods → `embedded-agent-runner` (take upstream's session-lock/run rewrite, re-apply our delta surgically) → `src/agents` → UI.
4. **Phase 2 — workboard reconciliation** (§3): adopt upstream UI/ops layer, re-apply our store-unification + LLM autonomous-loop on top. Treat as a feature task, not a merge.
5. **Phase 3 — API drift** (§5): `pnpm tsgo` + targeted fixes so memory-l3 / skill-forge / delegation / compression compile against new upstream APIs.
6. **Adopt high-value upstream features deliberately**, checking against our work first:
   - Security/audit event pipeline — likely wanted wholesale.
   - Provider externalization + ClawRouter + GLM-5.2/Kimi-K2.7 — **reconcile with our `delegation` + `model-catalog`** (potential overlap / now-redundant code on our side).
   - `/usage` native renderer retiring the footer plugin — check it doesn't collide with our usage/UI work.
7. **Validate** per repo policy: `pnpm check:changed` via Crabbox/Testbox (broad), targeted vitest local, `pnpm build` + gateway restart before treating anything as deployed.

### Strategic question for the maintainer

Given upstream's pace (~200 commits/day) and that our 10 signature subsystems are cleanly isolated, the durable choice is **cadence**: either (a) re-sync on a tight schedule (weekly) to keep the 274-file surface small, or (b) formally treat Cortex as a long-lived downstream and cherry-pick only specific upstream features (security events, new models) rather than tracking trunk. Drifting another 2000 commits before the next sync turns this from a 1-day reconcile into a multi-day one.

---

_Generated from `git merge-base`, `git diff --numstat`, `comm` overlap analysis, and commit-scope histograms against `upstream/main` @ 2026-06-19._
