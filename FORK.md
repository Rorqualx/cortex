# Cortex — OpenClaw Fork

> **Repo:** https://github.com/Rorqualx/cortex
> **Branch:** `memory-fork` (tracks `upstream/main` with fork-specific features)
> **Upstream:** https://github.com/openclaw/openclaw

This fork extends OpenClaw with custom subsystems for persistent memory, autonomous self-improvement, and enhanced UI streaming. All fork features are protected by `merge=ours` in `.gitattributes` to survive upstream merges cleanly.

---

## Features

### Feature A — SSE Transport Default for GPT-5 API-Key Models

**Problem:** OpenAI GPT-5 models over WebSocket had reliability issues (connection drops, partial deltas). SSE (Server-Sent Events) transport proved more stable.

**Solution:** Default to `transport=sse` for OpenAI models using API-key auth, with an explicit opt-in for WebSocket.

| File                                                     | Purpose                                 |
| -------------------------------------------------------- | --------------------------------------- |
| `src/agents/embedded-agent-runner/extra-params.ts`       | Transport selection logic (1,052 lines) |
| `src/agents/embedded-agent-runner-extraparams-*.test.ts` | Per-provider transport tests            |
| `docs/concepts/model-providers.md`                       | Documentation of transport behavior     |

---

### Feature B — packageVersion Plumbing on Bundled Plugins

**Problem:** Bundled plugin catalog entries didn't carry version info, making update checks unreliable.

**Solution:** Added `packageVersion` to bundled-plugin type entries in the channel catalog registry.

| File                                      | Purpose                         |
| ----------------------------------------- | ------------------------------- |
| `src/plugins/channel-catalog-registry.ts` | Version info on catalog entries |

---

### Feature C — LLM Thinking Stream to Control UI

**Problem:** LLM "thinking" content (chain-of-thought, reasoning tokens) was consumed server-side but invisible to users in the Control UI.

**Solution:** Added `deltaThinking` field to the gateway chat protocol. The gateway accumulates thinking deltas per run and piggybacks them on chat delta broadcasts. The UI renders thinking content in real-time alongside regular chat output.

**Protocol change:**

```typescript
// packages/gateway-protocol/src/schema/logs-chat.ts
{
  state: "delta",
  deltaText: string,
  deltaThinking?: string,  // NEW — incremental thinking content
  replace?: boolean,
}
```

**Server-side:**
| File | Purpose |
|------|---------|
| `src/gateway/server-chat-state.ts` | Per-run `thinkingBuffers` + `deltaLastBroadcastThinking` maps |
| `src/gateway/server-chat.ts` | `accumulateThinkingDelta()` + `resolveThinkingDelta()` piggyback on flush |

**UI:**
| File | Purpose |
|------|---------|
| `ui/src/ui/chat/build-chat-items.ts` | Extract thinking content from delta events |
| `ui/src/ui/chat/grouped-render.ts` | Render thinking blocks in chat |
| `ui/src/ui/chat/run-lifecycle.ts` | Track thinking state per run |
| `ui/src/ui/controllers/chat.ts` | Wire thinking into chat controller |
| `ui/src/ui/views/chat.ts` | Display in chat view |
| `ui/src/styles/chat/grouped.css` | Thinking block styling |
| `ui/src/ui/types/chat-types.ts` | Thinking type definitions |
| `ui/src/ui/app.ts` / `app-render.ts` / `app-view-state.ts` | App-level wiring |

---

## Extensions

### memory-l3 — Hierarchical 3-Tier Memory Engine

**Location:** `extensions/memory-l3/`

A persistent hierarchical memory engine plugin that gives agents long-term recall across sessions.

#### Architecture

```
L1 (Sliding Window)     — Recent context, bounded by token count
L2 (Compacted Chunks)   — Mid-term summaries, extract+update prompt compaction
L3 (Long-Term Typed Facts) — Semantic embeddings, epoch-based consolidation
```

#### How It Works

1. **Ingest** — Each session turn feeds into an ingest buffer
2. **L1 Selection** — Sliding window picks recent context within token budget
3. **L2 Compaction** — When chunks exceed threshold, LLM compacts into mid-term summaries
4. **L3 Consolidation** — Epoch boundaries trigger typed-fact extraction with semantic embeddings
5. **Retrieval** — Blended retrieval across all three tiers with scoring

#### L3 Long-Term Tier

- **Typed facts** — Structured data (dates, decisions, preferences) extracted via LLM with regex grounding
- **Semantic embeddings** — sqlite-vec for similarity search
- **Promotion/demotion** — Recurring facts get promoted; stale facts get demoted
- **Cross-brain reconciliation** — Flags contradictions between prose memory and typed values
- **On-disk format** — `memory/.l3/YYYY-MM-DD.md` snapshots (auto-generated, don't edit directly)

#### Left Brain / Right Brain Model

- **Left brain** — Typed fact extraction via `PROMPT_VERSION=4` + regex grounding
- **Right brain** — Prose-based memory (standard compaction)
- **Corpus callosum** — Merges both representations during consolidation

#### LongMemEval Benchmark

Built-in benchmark harness for measuring memory quality:

| Metric          | Baseline | After improvements |
| --------------- | -------- | ------------------ |
| LLM-judge score | 64%      | 71% (+7pp)         |

Key improvements:

- `no-UNKNOWN` answer strategy (+16pp from Bundle 1)
- Chain-of-thought prompting
- Semantic embeddings with top-K bump
- Timestamps + soft guidance in memory section (+6pp)
- Recall-vs-event disambiguation (+1pp)

#### Files (8,334 lines)

```
extensions/memory-l3/
├── src/
│   ├── engine.ts              # Main engine — wires all tiers
│   ├── sliding-window.ts      # L1 selector
│   ├── compaction.ts          # L2 compactor
│   ├── longterm.ts            # L3 long-term tier
│   ├── longterm-typed.ts      # L3 typed facts (left brain)
│   ├── reconciliation.ts      # Cross-brain reconciliation
│   ├── consolidation.ts       # Epoch-based consolidation scorer
│   ├── retrieval.ts           # Blended retrieval across tiers
│   ├── scoring.ts             # Relevance scoring
│   ├── epoch.ts               # Epoch boundary detection
│   ├── ingest.ts              # Session ingest buffer
│   ├── storage.ts             # SQLite persistence
│   ├── llm.ts                 # LLM prompt management
│   ├── grounding.ts           # Regex grounding for typed facts
│   ├── dedup.ts               # Deduplication
│   ├── token-estimate.ts      # Token counting
│   └── types.ts               # Type definitions
├── scripts/
│   ├── check-retrieval.mjs    # Live retrieval debugging
│   ├── preview-consolidation.mjs  # Consolidation preview
│   ├── replay-compaction.mjs  # Compaction replay
│   ├── run-longmemeval.mjs    # Benchmark runner
│   └── score-longmemeval.mjs  # Benchmark scorer
├── openclaw.plugin.json       # Plugin manifest
└── package.json
```

---

### skill-forge — Autonomous Self-Improvement Pipeline

**Location:** `src/skill-forge/`

Captures runtime failures, distills patterns, and auto-generates SKILL.md files to prevent recurring mistakes.

#### Pipeline Stages

```
1. Capture   — Watch for runtime errors, tool failures, and retry patterns
2. Detect    — Identify recurring failure patterns (embedding clustering)
3. Distill   — LLM distills failure pattern into a skill description
4. Gate      — Quality gate: validate skill is useful and non-trivial
5. Promote   — Write SKILL.md to ~/.openclaw/skill-forge/skills/
6. Telemetry — Track skill usage and effectiveness
```

#### Key Components

| Component                | Purpose                                        |
| ------------------------ | ---------------------------------------------- |
| `watcher.ts`             | File system watcher for failure events         |
| `capture.ts`             | Failure event capture and normalization        |
| `detector.ts`            | Pattern detection via embedding similarity     |
| `embedding-clusterer.ts` | Cluster similar failures                       |
| `distiller.ts`           | LLM-based failure → skill distillation         |
| `distiller-llm.ts`       | Prompt templates for distillation              |
| `gate.ts`                | Quality gate — reject trivial/duplicate skills |
| `promoter.ts`            | Write promoted skills to disk                  |
| `replay-gate.ts`         | Prevent replaying already-promoted patterns    |
| `pipeline.ts`            | Orchestrate the full pipeline                  |
| `autostart.ts`           | Auto-start pipeline on gateway boot            |
| `cli-actions.ts`         | CLI commands for manual pipeline control       |
| `telemetry.ts`           | Usage tracking and effectiveness metrics       |

#### Files (4,672 lines)

```
src/skill-forge/
├── autostart.ts         # Boot integration
├── capture.ts           # Failure capture
├── cli-actions.ts       # CLI interface
├── detector.ts          # Pattern detection
├── distiller.ts         # LLM distillation
├── distiller-llm.ts     # Prompt templates
├── embedding-clusterer.ts  # Embedding clustering
├── embedding-provider.ts   # Embedding interface
├── gate.ts              # Quality gate
├── paths.ts             # File path management
├── pipeline.ts          # Pipeline orchestration
├── promoter.ts          # Skill promotion
├── replay-gate.ts       # Replay prevention
├── telemetry.ts         # Usage tracking
├── types.ts             # Type definitions
└── watcher.ts           # File watching
```

---

## Merge Strategy

All fork-modified files are protected in `.gitattributes` with `merge=ours`:

- **Fork-exclusive code** (`extensions/memory-l3/`, `memory/.l3/`) — fully owned by fork
- **Fork patches to upstream files** (Feature A/B/C) — keeps our version on conflict; non-overlapping upstream changes merge normally
- **Upstream merges** — Regular catch-up merges from `upstream/main` (two staged legs to reduce conflict surface)

---

## Statistics

| Feature                    | Lines Added | Files   |
| -------------------------- | ----------- | ------- |
| memory-l3                  | 8,334       | 44      |
| skill-forge                | 4,672       | 32      |
| Feature A (SSE transport)  | 6,101       | 7       |
| Feature B (packageVersion) | 12          | 1       |
| Feature C (thinking UI)    | ~265        | 16      |
| **Total fork-specific**    | **~19,384** | **100** |

---

## Commits

112 fork commits on `memory-fork`, covering:

- 30+ memory-l3 implementation commits (scaffold → L1 → L2 → L3 → left brain → benchmark → fixes)
- 1 skill-forge commit (Phase 1–5 in one shot)
- 3 upstream catch-up merges
- Multiple `.gitattributes` and merge-strategy refinements
- Feature C (thinking stream to UI)

---

_Last updated: 2026-06-03_
