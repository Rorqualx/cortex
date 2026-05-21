# Skill Forge

This directory owns the autonomous self-improvement pipeline: capture sessions,
detect crystallization-worthy workflows, distill them into SKILL.md drafts,
auto-validate, and promote into user-state skills. Nothing here auto-runs yet;
the orchestrator must be invoked explicitly (CLI/cron wiring deferred).

## Architecture

```
session-end signal ──► captureSessionToForge ──► sessions/<id>-<ts>/
                                                       │
                                       runForgePipeline batch
                                                       ▼
                                             runDetector (3 lanes)
                                                       │
                                       candidates/<lane>-<id>.json
                                                       ▼
                                         distillCandidateToStaging
                                                       │
                                  skills/_staging/<name>/SKILL.md
                                                       ▼
                                              evaluateGate
                                                       │
                                                  pass│fail
                                                       ▼
                                  skills/<name>/  or  rejected
                                                       │
                                     telemetry/<name>.json updated
                                                       ▼
                                  runDecaySweep periodically demotes
                                                       │
                                       skills/_retired/<name>/
```

## Public Contracts

- Storage layout (all under `<stateDir>/skill-forge/`, default `~/.openclaw/skill-forge/`):
  - `sessions/<safe-id>-<iso-stamp>/` — full trajectory bundle + `forge-manifest.json`
  - `candidates/<lane>-<candidateId>.json` — detector output
  - `clusters/` — reserved (Phase 2 embedding lane will populate)
  - `skills/_staging/<name>/SKILL.md` — heuristic drafts pending gate
  - `skills/<name>/SKILL.md` — promoted (auto-passed gate)
  - `skills/_retired/<name>/{SKILL.md,retirement-reason.txt}` — demoted by decay
  - `telemetry/<name>.json` — per-skill counters
- Schemas: `types.ts` (capture manifest), `detector.ts` (`Candidate` union),
  `distiller.ts` (`DraftedSkill`), `gate.ts` (`GateVerdict`),
  `promoter.ts` (`PromotionResult`, `DecayPolicy`), `telemetry.ts` (`SkillTelemetryEntry`).
- Module surface: every module exports a small set of pure functions plus one
  orchestrator entry. `pipeline.ts::runForgePipeline` runs detector → distiller
  → gate → promoter for a batch.

## Deferred (clearly-marked TODOs in code)

- **`detector.ts::embeddingClusteringStub`** — semantic clustering requires an
  external embedding provider. Throws with `EMBEDDING_LANE_TODO` until wired.
- **`distiller.ts::DISTILLER_PROSE_TODO`** marker is written into every drafted
  SKILL.md body. An LLM-distillation pass will replace the heuristic prose.
- **`gate.ts::llmReplayGateStub`** — leave-one-out replay with the candidate
  skill loaded. Throws with `LLM_REPLAY_TODO` until wired.
- **Session-end auto-trigger** — `watcher.ts` polls a trajectory JSONL for
  `session.ended` events, but nothing in the rest of OpenClaw starts the
  watcher. The CLI/bootstrap wiring belongs in a follow-up.

## Boundary Rules

- Reuse `exportTrajectoryBundle` for the bundle body. Do not re-parse session
  JSONL or re-walk runtime trajectory events here.
- Redaction is the trajectory exporter's job. Forge writes nothing that
  bypasses it. The `forge-manifest.json` sidecar contains only IDs, counts,
  schema metadata, and trigger — no transcript content.
- Storage path computation goes through `paths.ts`. Do not hand-build paths
  under the forge root from other modules.
- All forge writes happen under `<stateDir>/skill-forge/`. The bundled
  `skills/` directory at the repo root is not touched; promoted skills live in
  user state. The skill loader must be taught to read the user-state path in
  a future wiring step (separate from this module).
- Capture is best-effort. Throws from `exportTrajectoryBundle` (oversized
  session file, event-count overflow) are caught at the forge boundary and
  surfaced as `CaptureSkipped` results, never re-raised into caller hot paths.
- Auto-promoted skills are prose-only: the gate rejects any draft with a
  `scripts/` subdirectory. Scripts in distilled skills require a separate
  human-approval path.
- Treat transcript content captured here as untrusted user input. The
  distiller's heuristic only quotes ascii-safe excerpts; the gate validates
  frontmatter against a strict regex before any promotion.
- Storage hygiene: capture writes are idempotent against retry (timestamp
  suffix). Promotion uses `fs.rename` (atomic on POSIX) so a crash mid-move
  cannot leave duplicated state.
- No bootstrap auto-start. Adding an entry that imports any forge module from
  `src/bootstrap/`, `src/entry.ts`, or the embedded runner needs explicit
  AGENTS review — the design intent is opt-in until end-signal wiring is
  proven.

## Verification

- Targeted: `pnpm test src/skill-forge`.
- Type check: `pnpm tsgo:core` for prod, `pnpm tsgo:core:test` for tests.
- Format: `pnpm exec oxfmt --check --threads=1 src/skill-forge/*.ts`.
- Lint: `node scripts/run-oxlint.mjs src/skill-forge`.
- No `pnpm build` re-profile needed: no plugin runtime fanout, no bundled
  channel/registry loads.

## Files

- `paths.ts` — resolves every directory under `<stateDir>/skill-forge/`.
- `types.ts` — capture manifest schema.
- `capture.ts` — `captureSessionToForge` (wraps `exportTrajectoryBundle`).
- `watcher.ts` — `watchTrajectoryForSessionEnd` (polls trajectory JSONL for
  the session-end event, calls `captureSessionToForge` once).
- `detector.ts` — three lanes (tool-shape repetition, error-recovery,
  explicit instruction) + embedding stub.
- `distiller.ts` — turns a `Candidate` into a heuristic SKILL.md under
  `skills/_staging/`.
- `gate.ts` — frontmatter schema validation + name-collision check +
  LLM-replay stub.
- `telemetry.ts` — per-skill counter persistence.
- `promoter.ts` — `promoteStagedSkill`, `demoteSkill`, `runDecaySweep`.
- `pipeline.ts` — `runForgePipeline` orchestrator (detector → distiller →
  gate → promoter for a batch of captures).
