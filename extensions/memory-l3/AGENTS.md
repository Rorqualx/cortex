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

Now that L3 is default-on, the storage revisit-trigger below is live: L3 is no
longer single-writer-by-opt-in, so migrating the mutable indexes to SQLite is
owed work (tracked, not yet done).

## Canonical identity

- Engine id is **`memory-l3`** everywhere that matters: `registerContextEngine("memory-l3")` (`index.ts`), `engine.info.id` (`engine.ts`), manifest `id` + `contracts.contextEngines`, and the slot value users set (`plugins.slots.contextEngine: "memory-l3"`). Resolution is by registered id only (`src/context-engine/registry.ts` `resolveContextEngine`) — the manifest contract is discovery/health metadata.
- "hierarchical-l3" survives only as a **human/brand label** in output headers and prose (e.g. `## Memory (hierarchical-l3)`), never as an id. Do not reintroduce it as a contract/slot id.

## Deliberate deviation 1 — file-based storage (not SQLite)

Root rule: OpenClaw-owned runtime state is SQLite-only, no JSON/JSONL/markdown sidecars. **L3 intentionally violates this**: all tiers live as files under `<workspace>/.openclaw/l3/` plus `~/.openclaw/shared-memory/longterm-shared.json`, with embeddings as inline JSON arrays and no FTS.

Why the rule exists (and what we trade away by deviating):

- **Atomicity/concurrency** — SQLite gives ACID + WAL across processes (gateway, CLI, crons, sub-agents). We only have an in-process `AsyncMutex` + atomic write-rename (`storage.ts`), so cross-process concurrent writes are _not_ guaranteed safe.
- **One source of truth + migrations** — doctor owns one canonical store; sidecars become migration debt (cf. the `.migrated` files the short-term store left behind).
- **Indexed query/perf** — FTS + indexes vs O(n) full-file JSON scans loaded into memory.

Why we chose files anyway:

- The tier model is **human-inspectable by design** — `l2/*.md`, `l3/*.md`, `longterm.md`, `longterm-typed.md` are meant to be read/diffed/grepped by an operator, and the long-term tier is deliberately mirrored to `<workspace>/memory/.l3/<date>.md` so memory-core's indexer + dreaming pick it up unchanged.
- Append-only JSONL (`l1_archive/`) is a replay artifact, a legitimate named-product-artifact use.
- L3 is opt-in/experimental and single-writer in practice (one agent per workspace).

Revisit trigger: if L3 goes default-on or multi-writer, migrate the mutable indexes (`edges.json`, `entities.json`, `retrieval-signals.json`, `topic-links.json`, `state.json`, `msg/*/chunks.json`, shared store) into the per-agent / shared SQLite DBs. Keep the markdown tiers as exported artifacts.

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
