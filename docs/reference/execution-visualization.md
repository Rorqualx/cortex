# Execution Visualization

Graph-based execution visualization layer for agent debugging and time-travel capability.

## Overview

Execution visualization provides structured trace events at phase boundaries throughout agent execution. These events enable:

- DAG-based debugging of agent behavior
- Time-travel capability through execution phases
- Performance profiling at phase granularity
- Distributed tracing correlation via W3C Trace Context

## Configuration

Enable execution visualization in your OpenClaw config:

```json
{
  "executionVisualization": {
    "enabled": true,
    "includeTraceContext": true,
    "phaseLevel": "detailed"
  }
}
```

**Options:**

- `enabled`: Enable/disable execution visualization (default: `false`)
- `includeTraceContext`: Include W3C trace context for distributed tracing (default: `true`)
- `phaseLevel`: Granularity of phase events
  - `"basic"`: Attempt-level events only
  - `"detailed"`: All phase events including compaction, policy, and spawn (default)

## Event Streams

Events are emitted on named streams corresponding to execution domains:

### Attempt Stream

Lifecycle events for a single agent attempt:

- `attempt_start`: Entry to runAgentAttempt
- `planning_complete`: After runtime plan is built
- `compaction_start`: Before compaction begins
- `compaction_complete`: After compaction ends
- `attempt_complete`: Successful attempt completion
- `attempt_failed`: Attempt failed with error

### Compaction Detailed Stream

Fine-grained events within the compaction phase:

- `start`: Compaction entry
- `preparation_start` / `preparation_complete`: Context preparation
- `before_hooks_start` / `before_hooks_complete`: Pre-compaction hooks
- `chunking_start`: Transcript chunking begins
- `summarization_start` / `summarization_complete`: Summary generation
- `after_hooks_start` / `after_hooks_complete`: Post-compaction hooks
- `side_effects_start` / `side_effects_complete`: Side effects (embeddings, etc.)
- `complete`: Compaction finished

### Policy Check Stream

Tool policy validation events for each policy layer:

- `deny_list_start` / `deny_list_complete`: Deny-list validation
- `allow_list_start` / `allow_list_complete`: Allow-list validation
- `capability_start` / `capability_complete`: Capability check
- `permission_start` / `permission_complete`: Permission validation
- `prompt_aware_start` / `prompt_aware_complete`: Prompt-aware tool filtering
- `deny_first_start` / `deny_first_complete`: Deny-first rule enforcement
- `sandbox_start` / `sandbox_complete`: Sandbox policy check
- `rate_limit_start` / `rate_limit_complete`: Rate limit validation

### Spawn Stream

Subagent spawn lifecycle events:

- `fast_spawn_start` / `fast_spawn_complete`: Fast spawn mode
- `full_spawn_start` / `full_spawn_complete`: Full spawn mode
- `env_resolution_start` / `env_resolution_complete`: Environment resolution
- `pre_fly_checks_start` / `pre_fly_checks_complete`: Safety checks
- `registry_validation_start` / `registry_validation_complete`: Registry validation
- `runtime_plugins_start` / `runtime_plugins_complete`: Runtime plugin loading
- `thread_binding_start` / `thread_binding_complete`: Thread binding
- `gateway_spawn_start` / `gateway_spawn_complete`: Gateway spawn call
- `post_spawn_sync_start` / `post_spawn_sync_complete`: Post-spawn synchronization

### Lifecycle Extended Stream

Extended lifecycle events:

- `context_load_start` / `context_load_complete`: Context loading
- `runtime_init_start` / `runtime_init_complete`: Runtime initialization
- `delivery_start` / `delivery_complete`: Message delivery

## W3C Trace Context

Events support distributed tracing via W3C Trace Context headers:

```typescript
type W3CTraceContext = {
  traceId?: string; // Unique identifier for the entire trace
  spanId?: string; // Unique identifier for this span
  parentSpanId?: string; // Identifier for the parent span
};
```

This enables correlation of events across:

- Parent and child agent attempts
- Subagent spawn hierarchies
- External service calls (when propagated)

## Event Payload

Each execution phase event contains:

```typescript
type ExecutionPhaseEvent = {
  stream: ExecutionPhaseStream; // Event stream
  phase: string; // Specific phase
  startedAt?: number; // Phase start time (epoch ms)
  endedAt?: number; // Phase end time (epoch ms)
  durationMs?: number; // Calculated duration
  metadata?: Record<string, unknown>; // Phase-specific data
  traceContext?: W3CTraceContext; // Distributed tracing context
  status?: "started" | "running" | "completed" | "failed";
};
```

## Phase Tracking Helper

The `PhaseTracker` class simplifies tracking phase durations:

```typescript
import { createPhaseTracker } from "./infra/agent-execution-events.js";

const tracker = createPhaseTracker({
  runId: "abc123",
  stream: "attempt",
  sessionKey: "session-key",
  traceContext: { traceId: "parent-trace", spanId: "parent-span" },
});

// Start a phase
tracker.start("attempt_start");

// Complete it (duration calculated automatically)
tracker.complete("attempt_start", { metadata: "value" });

// Or mark as failed
tracker.failed("attempt_start", { error: "something failed" });
```

## Event Consumption

Listen to execution events via the agent event stream:

```typescript
import { onAgentEvent } from "./infra/agent-events.js";

onAgentEvent((event) => {
  if (event.stream === "attempt") {
    console.log(`Phase ${event.data.phase}: ${event.data.status}`);
  }
});
```

## Use Cases

### Performance Profiling

Identify slow phases by comparing `durationMs` across attempts:

```typescript
const slowPhases = events
  .filter((e) => e.durationMs && e.durationMs > 1000)
  .sort((a, b) => b.durationMs - a.durationMs);
```

### DAG Visualization

Build a directed acyclic graph of execution flow:

```typescript
const edges = [];
for (let i = 1; i < events.length; i++) {
  edges.push({
    from: events[i - 1].phase,
    to: events[i].phase,
    duration: events[i].durationMs,
  });
}
```

### Distributed Tracing

Correlate events across service boundaries using trace IDs:

```typescript
const traceGroups = events.reduce((acc, e) => {
  const traceId = e.traceContext?.traceId;
  if (traceId) acc.set(traceId, [...(acc.get(traceId) || []), e]);
  return acc;
}, new Map());
```

## See Also

- [Compaction](/compaction) - Session compaction process
- [Subagents](/tools/subagents) - Subagent spawn lifecycle
