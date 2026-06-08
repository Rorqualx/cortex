# Workboard Core Integration — Master Plan

## Phase 1: Lift-and-Shift (Week 1)

Goal: workboard works from core with zero functional regression. Still uses its own
SQLite file and gateway layer but no longer loaded as a plugin.

### 1.1 Create core module

```
src/workboard/
├── mod.ts               # Core module entry (replaces index.ts)
├── store.ts              # Domain logic (copied verbatim)
├── types.ts              # Type definitions (copied verbatim)
├── tools.ts              # Tool definitions (minor import fixes)
├── sqlite-store.ts       # SQLite layer (keep own file for now)
├── gateway.ts            # Gateway RPC handlers (keep for now)
├── dispatcher.ts         # Dispatch lifecycle (minor import fixes)
├── command.ts            # CLI slash command (minor import fixes)
├── card-lookup.ts        # Utility (copied verbatim)
└── cli.ts                # CLI subcommands (minor import fixes)
```

### 1.2 Rewrite imports

| Old (plugin SDK)                      | New (core)                            |
| ------------------------------------- | ------------------------------------- |
| `openclaw/plugin-sdk/core`            | `../mcp/json-result.ts`               |
| `openclaw/plugin-sdk/plugin-entry`    | (removed — `mod.ts` exports directly) |
| `openclaw/plugin-sdk/plugin-runtime`  | `../agents/subagent.ts`               |
| `openclaw/plugin-sdk/state-paths`     | `../config/state-paths.ts`            |
| `openclaw/plugin-sdk/error-runtime`   | `../errors/format.ts`                 |
| `openclaw/plugin-sdk/gateway-runtime` | (removed — direct call)               |

### 1.3 Register in core startup

```typescript
// src/startup.ts (or wherever plugins load)
import { createWorkboardModule } from "./workboard/mod.ts";
const workboard = createWorkboardModule(db, subagentSystem);
workboard.registerTools(toolRegistry);
workboard.registerGatewayMethods(gatewayRouter);
```

### 1.4 Keep separate SQLite file

- `~/.openclaw/workboard.db` stays as-is
- No schema changes
- Existing data survives the migration

### 1.5 Remove plugin

- Delete `extensions/workboard/`
- Remove workboard from `bundled-plugin-metadata.ts`
- Clean up `openclaw.plugin.json` loading path

**Deliverable:** Workboard IS core. No more plugin loading. All 35 tools functional.
All existing cards/boards/attachments preserved.

---

## Phase 2: Deep Integration (Weeks 2-3)

Detailed, step-level plan at [`docs/workboard-phase2-plan.md`](./workboard-phase2-plan.md).

### Summary

| Step | Action                                                  | Lines |
| ---- | ------------------------------------------------------- | ----- |
| 2.1  | Merge SQLite into core DB + migration                   | ~300  |
| 2.2  | Replace gateway RPC with direct API exports             | ~400  |
| 2.3  | Replace TypeBox import (trivial, core uses TypeBox too) | 1     |
| 2.4  | Wire dispatcher to spawnSubagentDirect                  | ~100  |
| 2.5  | Replace Commander CLI with CoreCommandDescriptor        | ~150  |
| 2.6  | Feature flag `features.workbook`                        | ~30   |
| 2.7  | Delete old plugin + cleanup                             | —     |

**Deliverable:** Workboard indistinguishable from native core features.
Zero plugin SDK traces. Same DB, same CLI, same schema, same subagent system.

---

## Migration Path (End User)

### Existing installs (Phase 1)

- `~/.openclaw/workboard.db` stays → zero data loss
- Plugin directory disappears → no user action needed
- All cards, boards, attachments preserved

### Phase 2

- Core DB migration copies workboard tables into `gateway.db`
- Old `workboard.db` deleted after successful migration
- User sees no change — same cards, same boards, same UI

---

## Risk Assessment

| Risk                                    | Severity | Mitigation                                                       |
| --------------------------------------- | -------- | ---------------------------------------------------------------- |
| Data loss during DB merge               | High     | Migration runs in transaction, verified before deleting old file |
| Subagent API mismatch                   | Medium   | Snap current PluginRuntime interface, freeze during transition   |
| UI breaks without gateway               | Medium   | Phase 1 keeps gateway → Phase 2 rewires UI → test both paths     |
| TypeBox replacement breaks tool schemas | Low      | 1:1 schema mapping, TypeBox shapes are simple objects            |
| Build size increase                     | Low      | ~15K lines ≈ minimal impact on bundle                            |

---

## Files by Phase

### Phase 1 (Create)

```
src/workboard/mod.ts
src/workboard/store.ts
src/workboard/types.ts
src/workboard/tools.ts
src/workboard/sqlite-store.ts
src/workboard/gateway.ts
src/workboard/dispatcher.ts
src/workboard/command.ts
src/workboard/card-lookup.ts
src/workboard/cli.ts
```

### Phase 1 (Modify)

```
src/startup.ts              # Register workboard module
src/mcp/tool-registry.ts    # (if exists) or tool bootstrap path
extensions/workboard/       # → DELETE entire directory
```

### Phase 2 (Create)

```
src/db/migrations/0XX_workboard.ts
src/db/workboard-queries.ts
src/workboard/api.ts
```

### Phase 2 (Modify)

```
src/db/schema.ts            # +4 workboard tables
src/ui/...workboard views   # Import from api.ts instead of gateway
src/workboard/tools.ts      # Replace TypeBox with core schema
src/workboard/cli.ts        # Replace commander with core CLI
src/workboard/dispatcher.ts # Direct subagent import
```

### Phase 2 (Delete)

```
src/workboard/sqlite-store.ts
src/workboard/gateway.ts
extensions/workboard/       # Already deleted in Phase 1
```

---

## Estimated Effort

| Phase     | New Files | Modified | Deleted | Lines Changed | ETA         |
| --------- | --------- | -------- | ------- | ------------- | ----------- |
| Phase 1   | 10        | 2-3      | 19      | ~1,200        | 4 days      |
| Phase 2   | 3         | 6        | 2       | ~2,000        | 8 days      |
| **Total** | **13**    | **8-9**  | **21**  | **~3,200**    | **12 days** |

Phase 1 is mechanically straightforward — import rewrites and registration.
Phase 2 requires more design decisions (DB migration shape, core schema builder, CLI integration) but the domain logic doesn't change.
