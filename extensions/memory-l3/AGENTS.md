# memory-l3 — Architecture Decisions

Cortex-fork context-engine plugin. Telegraph style. Read root `AGENTS.md` and `extensions/AGENTS.md` first; this file records the **intentional** deviations so reviews (ClawSweeper, daily scan) do not re-flag them as accidental debt.

## Enabled by default (fork)

This fork ships memory-l3 as the **default context engine**. The mechanism is a
_preferred_ slot selection, not the structural default: `slots.ts` keeps the
reserved built-in `legacy` as `defaultSlotIdForKey("contextEngine")` (so slot
reservation, effective-id, host-compat, and uninstall-reset logic keep treating
legacy as the core built-in), and adds `preferredSlotIdForKey("contextEngine") =
"memory-l3"`. An **unset** `plugins.slots.contextEngine` resolves to memory-l3 in
`resolveContextEngine` and is preloaded via `collectSelectedContextEnginePluginIds`.
Because memory-l3 is a non-default selection, an unregistered/disabled engine
takes the normal quarantine path and **degrades to the built-in legacy** — that is
the safety net. Do not make memory-l3 the structural `DEFAULT_SLOT_BY_KEY` value:
that id is reserved for core-owned engines and would block the plugin from
registering and loading.

Now that L3 is default-on, the storage migration to SQLite is **done** (deviation 1
below): the shared store and all per-agent tiers are SQLite-backed.

## Canonical identity

- Engine id is **`memory-l3`** everywhere that matters: `registerContextEngine("memory-l3")` (`index.ts`), `engine.info.id` (`engine.ts`), manifest `id` + `contracts.contextEngines`, and the slot value users set (`plugins.slots.contextEngine: "memory-l3"`). Resolution is by registered id only (`src/context-engine/registry.ts` `resolveContextEngine`) — the manifest contract is discovery/health metadata.
- "hierarchical-l3" survives only as a **human/brand label** in output headers and prose (e.g. `## Memory (hierarchical-l3)`), never as an id. Do not reintroduce it as a contract/slot id.

## Resolved deviation 1 — storage is now SQLite (was file-based)

Root rule: OpenClaw-owned runtime state is SQLite-only, no JSON/JSONL/markdown
sidecars. L3 historically violated this for all tiers; it now complies. Canonical
state lives in SQLite, with the human-readable markdown tiers kept as regenerated
**exports** (not source of truth).

- **Shared store** → dedicated WAL DB `<sharedDir>/longterm-shared.sqlite`
  (default `~/.openclaw/shared-memory/`, `OPENCLAW_SHARED_MEMORY_DIR` override),
  in `cross-context.ts`. `publishToFacts` does read-merge-write inside one
  `BEGIN IMMEDIATE` transaction, fixing the cross-process lost-update bug the old
  atomic-rename JSON store had (it was the one genuinely multi-writer tier).
- **Per-agent tiers** → dedicated per-root DB `<workspace>/.openclaw/l3/l3.sqlite`
  (`storage.ts`). A dedicated DB — rather than the shared per-agent
  `openclaw-agent.sqlite` — is justified by L3's distinct schema, embedding volume,
  and workspace-scoped lifecycle, and keeps `new Storage(root)` / `fromWorkspace`
  signature-stable for the ~16 call sites/tests. Tables: `l3_kv` (state + both
  long-term frontmatters), `l3_l2_chunks`, `l3_epochs`, `l3_message_chunks`
  (embeddings as a JSON `TEXT` column for now — see Phase D follow-up),
  `l3_entities`, `l3_topic_links`, `l3_retrieval_signals`, `l3_edges`. Writes go
  through `runSqliteImmediateTransactionSync`; the in-process `AsyncMutex` is gone.
- **Markdown exports (derived, not canonical):** `l2/*.md`, `l3/*.md`,
  `longterm.md`, `longterm-typed.md` are written through after each commit (same
  bytes as before) so operator grep/diff still works; reads always come from the
  DB, so exports cannot drift. `listL2ChunkPaths`/`listL3EpochPaths` return these
  export paths as tokens (so `insights.ts`' date-partition parse keeps working);
  `readL2ChunkAtPath` resolves the chunk id from the token basename.
- **Kept as files (named artifacts, by design):** `l1_archive/*.jsonl` (replay
  log) and the `<workspace>/memory/.l3/<date>.md` mirror memory-core's indexer +
  dreaming consume. WAL `-wal`/`-shm` are SQLite-internal, not JSON sidecars.

Legacy file state is imported once by `doctor-contract-api.ts` (`openclaw doctor
--fix`) — two `stateMigrations`: the shared store, and the per-agent tiers (which
open each root's `l3.sqlite`, import every tier via the `Storage` writers, then
archive the DB-only index JSON to `.migrated`). Idempotency comes from the
archived `state.json` sentinel — a completed migration renames it, so re-runs
skip. The import is NOT skipped just because the DB already has rows: if the
runtime wrote into a fresh DB before the migration ran, skipping would orphan the
on-disk memory permanently, so the importer proceeds (self-healing) and warns. The
runtime never reads legacy files.

**Deploy runbook (required):** because the SQLite runtime starts empty until the
import runs, deploys must run `openclaw doctor --fix` before the new runtime begins
writing — i.e. build → stop gateway → `openclaw doctor --fix` → start gateway. If
the runtime writes first there is a brief amnesia window (then self-healed by the
next `doctor --fix`), but ordering doctor before start avoids it entirely.

What the SQLite move buys (the reasons the rule exists): ACID + WAL cross-process
safety (fixes the shared-store bug), one canonical store with doctor-owned
migration, and indexed access by id/`chunk_id`/`created_at`.

Phase D follow-up (optional optimization, not required for compliance): break
`l3_message_chunks` + long-term facts into per-row embedding columns mirrored to a
`sqlite-vec` virtual table for ANN, replacing the current in-JS `cosineSimilarity`
over JSON-`TEXT` embeddings.

## Deliberate deviation 2 — importing core runtime from `src/**`

Root/extensions rule: plugins import only `openclaw/plugin-sdk/*` and local barrels, never core `src/**`. **L3 intentionally deep-imports** `../../../src/plugins/memory-embedding-provider-runtime.js` (`engine.ts`) to reuse core's embedding provider.

Why the rule exists:

- The boundary is the contract third-party plugins see; deep imports couple us to private internals that can change without notice.
- **Packaging**: external plugins are excluded from core dist, so a `../../../src/...` import only resolves because L3 is bundled in-tree — it would break if L3 were ever externalized.

Why it's acceptable for now: L3 is a **bundled** Cortex plugin shipped inside core dist, so the relative import resolves and we accept the coupling rather than duplicate the provider logic. Proper fix = expose the embedding provider through a `openclaw/plugin-sdk/*` seam, then switch to it. Do that before externalizing L3.

## Tuning knobs (live)

- `scoring.ts` `DEFAULT_FSRS_PARAMS.w2` — global forgetting-rate multiplier, now wired into `fsrsRetrievability` (`R(t)=e^(-(w2·t)/S)`); `1.0` = neutral (preserves prior calibrated behavior), >1 forgets faster.
- `scoring.ts` `DEFAULT_SCORING_CONFIG.weightInformationGain` — now `0.05` (was inert at 0); a small novelty lift for fresh L2 facts. Only L2 facts carry `informationGain`; other tiers score it 0.
- A/B flags via env: `OPENCLAW_MEMORY_L3_NATIVE_COMPACTION` (BabelTele-style dense extraction prompt), `OPENCLAW_MEMORY_L3_SEGMENTED_COMPACTION` (per-topic extraction), `OPENCLAW_MEMORY_L3_DEBUG`.

## Relationship to dreaming

L3 is **independent** of memory-core's Light/Deep/REM dreaming (upstream). One-directional: L3 writes long-term facts into a path memory-core indexes; dreaming picks them up passively. Dreaming never calls L3; L3 never calls dreaming.
