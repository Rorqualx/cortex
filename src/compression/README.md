# Context Compression Pipeline

Post-processing compression layer that runs after context engine `assemble()` returns, before the model sees the messages. Compresses tool-result content to reduce token usage by 70-95%.

## Architecture

```
assemble() → AssembleResult { messages[] }
         ↓
  ┌──────────────────────────────────────┐
  │  COMPRESSION PIPELINE                │
  │                                      │
  │  1. CacheAligner (stub — Phase 3)    │
  │  2. ContentRouter (type detection)   │
  │     ├→ SmartCrusher (JSON arrays)    │
  │     ├→ SearchCompressor (grep/glob)  │
  │     ├→ LogCompressor (build/test)    │
  │     ├→ DiffCompressor (unified diff) │
  │     └→ Passthrough (everything else) │
  │  3. TokenBudgetEnforcer (trim to fit)│
  └──────────────────────────────────────┘
         ↓
  Compressed messages → model
```

**Key constraint:** Only tool-result content is compressed. User messages, system prompts, and assistant responses pass through untouched.

## Files

| File                       | Purpose                                           |
| -------------------------- | ------------------------------------------------- |
| `types.ts`                 | Config, result types, defaults                    |
| `scoring.ts`               | Importance scoring for JSON array items           |
| `smart-crusher.ts`         | JSON array statistical sampling                   |
| `search-compressor.ts`     | grep/glob output compression                      |
| `log-compressor.ts`        | Build/test/log pattern compression                |
| `diff-compressor.ts`       | Unified diff compression                          |
| `cache-aligner.ts`         | Prefix stabilization (Phase 3 stub)               |
| `token-budget-enforcer.ts` | Token budget enforcement                          |
| `content-router.ts`        | Content type detection + dispatch                 |
| `index.ts`                 | Pipeline entry point (`compressAssembledContext`) |

## Config

```json
{
  "compression": {
    "enabled": true,
    "minContentChars": 800,
    "targetRatio": 0.3,
    "maxArrayItems": 20,
    "enabledTypes": {
      "jsonArrays": true,
      "searchResults": true,
      "logs": true,
      "diffs": true
    },
    "ccr": {
      "enabled": false
    }
  }
}
```

Disabled by default. Set `"enabled": true"` in `openclaw.json` to activate.

## Compressors

### SmartCrusher — JSON Arrays

- Parses JSON arrays, scores items by importance (errors, unique values, position)
- Selects representative subset using 30/15/55 split (head/merit/tail)
- Factors constant fields into `_constant_fields` header
- Adds `_stats` summary with totals, error count, file count

**Savings:** 70-90% on grep results, API responses, file listings.

### SearchCompressor — Grep/Glob

- Detects `file:line:content` format
- Groups by file, keeps 2 per file + error matches
- Adds summary line

**Savings:** 80-95% on large grep/glob outputs.

### LogCompressor — Build/Test Logs

- Detects log patterns (timestamps, log levels, test results)
- Always keeps errors, warnings, stack traces
- Collapses repeated lines into count markers

**Savings:** 85-95% on build/test output.

### DiffCompressor — Unified Diffs

- Keeps all context lines and removals
- Summarizes large additions (keep first/last 3, count rest)

**Savings:** 70-90% on large diffs.

## CCR — Reversible Cache

When `ccr.enabled: true`, compressed content is stored in a SQLite-backed cache:

1. Compression stores original content with SHA-256 hash key
2. Compressed output gets a marker: `[200 items → 15. Retrieve: hash=abc123]`
3. Model can call `ccr_retrieve` tool with the hash to get original data back
4. Optional `query` parameter filters results via keyword search

### Files

| File                     | Purpose                                          |
| ------------------------ | ------------------------------------------------ |
| `ccr/store.ts`           | SQLite-backed LRU cache (node:sqlite, zero deps) |
| `ccr/retrieval-tool.ts`  | Tool definition + compression marker helpers     |
| `ccr/context-tracker.ts` | Cross-turn relevance detection                   |
| `ccr/index.ts`           | Barrel export                                    |

### CCR Config

```json
{
  "compression": {
    "enabled": true,
    "ccr": {
      "enabled": true,
      "maxEntries": 1000,
      "ttlSeconds": 3600
    }
  }
}
```

### ContextTracker

Tracks what was compressed across turns. When the model asks about something
that was compressed earlier, the pipeline can proactively expand relevant data.
Keyword-based relevance scoring with stop-word filtering.

### ccr_retrieve Tool Executor

`createCCRRetrieveTool(store)` returns a Tool object with:

- OpenAI-format tool definition
- `execute()` function that reads from the CCR store
- Optional `query` parameter for filtered keyword search
- Graceful fallback when search returns no results

Injected into `effectiveTools` when CCR is enabled and content was compressed.

## Telemetry

When compression is active, structured logs include:

- Messages compressed count
- Total savings percent
- Character count before/after
- CCR entries stored
- Per-type breakdown (e.g., `json_array:3(85%), search:1(92%)`)

## Integration

Hooked into `attempt.ts` after context engine assemble, before model call:

```typescript
const compressionConfig = params.config?.compression;
if (compressionConfig?.enabled) {
  const { compressAssembledContext, resolveCompressionConfig } =
    await import("../../compression/index.js");
  const resolved = resolveCompressionConfig(compressionConfig);
  const compressed = await compressAssembledContext(
    activeSession.messages,
    resolved,
    params.contextTokenBudget,
  );
  activeSession.agent.state.messages = compressed.messages;
}
```

Dynamic import means zero overhead when disabled.

## Phases

| Phase | Status  | What                                                                              |
| ----- | ------- | --------------------------------------------------------------------------------- |
| 1     | ✅ Done | SmartCrusher + SearchCompressor + LogCompressor + DiffCompressor + pipeline shell |
| 2     | ✅ Done | CCR reversible cache (node:sqlite) + retrieval tool + context tracker             |
| 3     | ✅ Done | Cache aligner (prefix stabilization) + token budget enforcer with forward refs    |
| 4     | ✅ Done | Log + diff compressors (built in Phase 1)                                         |
| 5     | ✅ Done | CCR retrieve tool executor + tool injection + telemetry + config                  |

## Testing

```bash
npx vitest run src/compression/compression.test.ts
```

75 tests covering: scoring, SmartCrusher, SearchCompressor, LogCompressor, DiffCompressor, ContentRouter, TokenBudgetEnforcer (with forward refs), pipeline shell, config resolution, CCR Store, ContextTracker, retrieval tool helpers, CCR pipeline integration, CacheAligner, CCR retrieve tool executor.
