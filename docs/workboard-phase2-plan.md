# Phase 2: Deep Integration — Expanded Plan

<!-- markdownlint-disable MD024 -- phased plan intentionally repeats Steps/Current state/Target subheadings per section -->

## 2.1 Merge SQLite into Core DB

### Pattern

Core uses additive schema in `src/state/openclaw-state-db.ts`:

```ts
ensureSchema(db, pathname) → db.exec(SCHEMA_SQL) → ensureAdditiveStateColumns(db)
```

Tables are `CREATE TABLE IF NOT EXISTS`, columns are `ALTER TABLE ADD COLUMN` (idempotent).

### Steps

1. Add 4 workboard tables to `src/state/openclaw-state-schema.sql` (the generated SQL constant)
2. Add workboard columns to `ensureAdditiveStateColumns()` for future migrations
3. Create `src/db/workboard-queries.ts` — thin query functions replacing `sqlite-store.ts`:
   - `listCards(db, filter)`, `createCard(db, card)`, `updateCard(db, id, patch)`, etc.
4. Create migration `src/state/migrations/workboard-kv-to-core.ts`:
   - Opens old `workboard.db`, reads all rows, inserts into `gateway.db`
   - Runs in transaction, verified row counts, then deletes old file
5. Update `WorkboardStore` constructor to accept `DatabaseSync` instead of `WorkboardKeyedStore`
6. Delete `src/workboard/sqlite-store.ts` and `src/workboard/persistence-types.ts`

### Key decision

WorkboardStore currently uses `WorkboardKeyedStore<T>` interface (lookup/register/update/delete/entries/count).
We'll replace with direct `DatabaseSync` calls via `workboard-queries.ts`.

---

## 2.2 Remove Gateway RPC Layer

### Current state

`src/workboard/gateway.ts` has 30 methods registered via `register(methodName, handler)`.
UI calls them through the gateway RPC bus.

### Target

Each method becomes a direct function export from `src/workboard/api.ts`.
UI imports `api.ts` explicitly, no message routing.

### Steps

1. Create `src/workboard/api.ts`:

   ```ts
   export async function wbListCards(store, { boardId, status, section, limit, offset });
   export async function wbCreateCard(store, params);
   // ... all 30 methods as named exports
   ```

2. Update `src/ui/controllers/workboard.ts` — import from `api.ts` instead of calling gateway RPC
3. Add workboard gateway methods to `src/gateway/methods/core-descriptors.ts`:

   ```ts
   {
     name: "workboard.cards.list",
     scopes: ["operator.read"],
     handler: (params) => wbListCards(workboardStore, params),
   }
   ```

4. Delete `src/workboard/gateway.ts`

### UI call sites to update (find from Phase 1 exploration)

- `src/ui/controllers/workboard.ts` — creates/reads/updates cards via gateway
- `src/ui/views/workboard.ts` — lists cards, boards, stats

---

## 2.3 Replace TypeBox Imports

### Current state

`src/workboard/tools.ts` imports `Type` from `"typebox"` (npm package).

### Discovery

Core already uses TypeBox! It's re-exported from `src/agents/schema/typebox.ts`:

```ts
export { Type, type TSchema, type Static } from "@sinclair/typebox";
```

### Steps

1. Change `import { Type } from "typebox"` → `import { Type } from "../agents/schema/typebox.js"`
2. Remove `typebox` from `package.json` dependencies (if no other consumer)

### Impact

Zero code changes beyond the import path. Tool schemas stay identical.

---

## 2.4 First-class Subagent Integration

### Current state

Dispatcher calls `params.subagent({ sessionKey, message, ... })` via injection.

### Target

Dispatcher calls `spawnSubagentDirect(params, context)` directly.

### Steps

1. In `src/workboard/dispatcher.ts`, import `spawnSubagentDirect` from `../../agents/subagent-spawn.js`
2. Build `SpawnSubagentContext` from the dispatch context:

   ```ts
   const ctx: SpawnSubagentContext = {
     agentSessionKey: ownerSessionKey,
     workspaceDir: card.workspaceDir,
   };
   ```

3. Map dispatcher params to `SpawnSubagentParams`:
   - `message` → `task`
   - `sessionKey` → `taskName`
   - `model` → `model`
   - `deliver: false` → `expectsCompletionMessage: false`
   - `lightContext` → `lightContext`
   - `lane` → (not in spawnSubagentDirect, use taskName for idempotency)
4. Handle `SpawnSubagentResult` — extract `runId`, `childSessionKey`
5. Remove `WorkboardSubagent` callback type from dispatcher.ts

### Key interface change

```ts
// Before
export async function dispatchAndStartWorkboardCards(params: {
  store: WorkboardStore;
  subagent: WorkboardSubagent; // callback
  options?: WorkboardDispatchStartOptions;
});

// After
export async function dispatchAndStartWorkboardCards(params: {
  store: WorkboardStore;
  subagentCtx: SpawnSubagentContext; // context object
  config: OpenClawConfig;
  options?: WorkboardDispatchStartOptions;
});
```

---

## 2.5 Replace Commander CLI

### Current state

`src/workboard/cli.ts` uses `commander` (`Command` type, `addGatewayClientOptions`, etc.).

### Target

Core CLI uses `CoreCommandDescriptor` pattern from `src/cli/program/command-registry-core.ts`.

### Steps

1. Create `src/cli/commands/workboard.ts` following core pattern:

   ```ts
   export const workboardCommand: CoreCommandDescriptor = {
     name: "workboard",
     description: "Manage Workboard cards and worker dispatch",
     load: () => import("./workboard-handler.js"),
   };
   ```

2. Move CLI logic from `src/workboard/cli.ts` → `src/cli/commands/workboard-handler.ts`
3. Register in `command-registry-core.ts`:

   ```ts
   import { workboardCommand } from "../commands/workboard.js";
   CORE_COMMAND_DESCRIPTORS.push(workboardCommand);
   ```

4. Delete `src/workboard/cli.ts`

---

## 2.6 Feature Flag

### Steps

1. Add `workboard: boolean` to core config schema:

   ```ts
   // src/config/schema.ts (or types.openclaw.ts)
   features?: {
     workboard?: boolean;  // default: true
   };
   ```

2. At module initialization, check config:

   ```ts
   if (config.features?.workboard === false) return;
   ```

3. DB tables created regardless (idempotent CREATE TABLE IF NOT EXISTS)
4. Tools not registered when disabled

---

## 2.7 Cleanup

### Delete

- `src/workboard/gateway.ts`
- `src/workboard/sqlite-store.ts`
- `src/workboard/persistence-types.ts`
- `src/workboard/cli.ts`
- `extensions/workboard/` (entire directory)
- Remove workboard from bundled plugin metadata

### Keep

- `src/workboard/store.ts` — domain logic
- `src/workboard/tools.ts` — tool definitions (minor imports updated)
- `src/workboard/types.ts` — type definitions
- `src/workboard/dispatcher.ts` — dispatch lifecycle
- `src/workboard/command.ts` — slash command handler
- `src/workboard/card-lookup.ts` — utility
- `src/workboard/mod.ts` — entry point (updated)
- `src/workboard/api.ts` — new direct API (replaces gateway)

---

## Files Summary

| Step             | Create                                   | Modify                                                               | Delete                                    |
| ---------------- | ---------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- |
| 2.1 DB merge     | `src/db/workboard-queries.ts`, migration | `openclaw-state-schema.sql`, `openclaw-state-db.ts`, `store.ts`      | `sqlite-store.ts`, `persistence-types.ts` |
| 2.2 Gateway      | `src/workboard/api.ts`                   | `ui/controllers/workboard.ts`, `gateway/methods/core-descriptors.ts` | `gateway.ts`                              |
| 2.3 TypeBox      | —                                        | `tools.ts` (1 import line)                                           | —                                         |
| 2.4 Subagent     | —                                        | `dispatcher.ts`, `mod.ts`                                            | —                                         |
| 2.5 CLI          | `cli/commands/workboard.ts`              | `command-registry-core.ts`                                           | `src/workboard/cli.ts`                    |
| 2.6 Feature flag | —                                        | `config/types.ts`, `mod.ts`                                          | —                                         |
| 2.7 Cleanup      | —                                        | `bundled-plugin-metadata.ts`                                         | `extensions/workboard/`                   |
