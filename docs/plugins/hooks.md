---
summary: "Plugin hooks: intercept agent, tool, message, session, and Gateway lifecycle events"
title: "Plugin hooks"
read_when:
  - You are building a plugin that needs before_tool_call, before_agent_reply, message hooks, or lifecycle hooks
  - You need to block, rewrite, or require approval for tool calls from a plugin
  - You are deciding between internal hooks and plugin hooks
---

Plugin hooks are in-process extension points for OpenClaw plugins. Use them
when a plugin needs to inspect or change agent runs, tool calls, message flow,
session lifecycle, subagent routing, installs, or Gateway startup.

Use [internal hooks](/automation/hooks) instead when you want a small
operator-installed `HOOK.md` script for command and Gateway events such as
`/new`, `/reset`, `/stop`, `agent:bootstrap`, or `gateway:startup`.

## Quick start

Register typed plugin hooks with `api.on(...)` from your plugin entry:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "tool-preflight",
  name: "Tool Preflight",
  register(api) {
    api.on(
      "before_tool_call",
      async (event) => {
        if (event.toolName !== "web_search") {
          return;
        }

        return {
          requireApproval: {
            title: "Run web search",
            description: `Allow search query: ${String(event.params.query ?? "")}`,
            severity: "info",
            timeoutMs: 60_000,
            timeoutBehavior: "deny",
          },
        };
      },
      { priority: 50 },
    );
  },
});
```

Hook handlers run sequentially in descending `priority`. Same-priority hooks
keep registration order.

`api.on(name, handler, opts?)` accepts:

| Option             | Effect                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `matcher`          | Non-empty list of canonical OpenClaw tool ids handled by `before_tool_call` or `after_tool_call`, such as `exec`, `apply_patch`, or `spawn_agent`. Omit to match all tools. Empty lists, wildcards, blanks, and provider-specific aliases are invalid. |
| `priority`         | Ordering; higher runs first.                                                                                                                                                                                                                           |
| `registrationId`   | Stable identity for one registration inside a plugin. Skill evaluators use it as `evaluatorId`; otherwise the plugin id is used.                                                                                                                       |
| `timeoutMs`        | Per-hook await budget. When it expires, OpenClaw stops awaiting that handler and moves on. It does not cancel the handler or its side effects. Omit to use the runner's default per-hook timeout.                                                      |
| `eligibleTriggers` | For `before_agent_reply` only, limits host dispatch to one or more of `cron`, `heartbeat`, or `user`.                                                                                                                                                  |

Trigger eligibility is enforced by the host before it invokes the handler. A
hook registered with `eligibleTriggers: ["heartbeat", "cron"]` is therefore
inactive for user turns and does not block recovery of an interrupted user
turn. Omitted, empty, malformed, or partly unknown lists remain unrestricted
so dispatch and recovery fail closed. Other hook kinds do not accept this
option.

Operators can also set hook budgets without patching plugin code:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "hooks": {
          "timeoutMs": 30000,
          "timeouts": {
            "before_prompt_build": 90000,
            "agent_end": 60000
          }
        }
      }
    }
  }
}
```

`hooks.timeouts.<hookName>` overrides `hooks.timeoutMs`, which overrides the
plugin-authored `api.on(..., { timeoutMs })` value. Each value must be a
positive integer up to 600000 ms. Prefer per-hook overrides for known-slow
hooks so one plugin does not get a longer budget everywhere.

A timed-out handler promise continues running because hook callbacks do not
receive a timeout-owned cancellation signal. `before_tool_call` receives the
owning tool call's `ctx.abortSignal`, but hook timeout expiry does not abort it.
The hook dispatch can release its Gateway admission while that plugin work is
still in progress. Plugins that own long-running work must provide their own
cancellation and shutdown lifecycle.

Policy hooks `before_tool_call` and `before_install` use a 15-second default per
handler. A timeout fails closed: the tool call or installation is rejected
instead of continuing without a policy decision.

`gateway_stop` uses a five-second default per handler. Timed-out handlers are
logged and shutdown continues so plugin cleanup cannot consume the Gateway
process watchdog.

Outbound modifying hooks `message_sending` and `reply_payload_sending` use a
15-second default per handler. If one times out, OpenClaw logs the plugin error
and continues with the latest payload so the serialized delivery lane can
settle. Set a larger per-hook budget for plugins that intentionally do slower
work before delivery.

Channel plugins that use `createReplyDispatcher` can likewise declare a larger
positive per-stage budget with `beforeDeliverOptions: { timeoutMs }`, or when
appending work with `dispatcher.appendBeforeDeliver(handler, { timeoutMs })`.
Without an owner-declared budget, those callbacks use the same 15-second
default so a hung callback cannot retain the serialized delivery lane.

Each hook receives `event.context.pluginConfig`, the resolved config for the
plugin that registered that handler. Use it for hook decisions that need
current plugin options; OpenClaw injects it per handler without mutating the
shared event object seen by other plugins.

## Hook catalog

Hooks are grouped by the surface they extend. Names in **bold** accept a
decision result (block, cancel, override, or require approval); all others are
observation-only.

**Agent turn**

| Hook                            | Purpose                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `before_model_resolve`          | Override provider or model before session messages load                                  |
| `agent_turn_prepare`            | Consume queued plugin turn injections and add same-turn context before prompt hooks      |
| `before_prompt_build`           | Add prompt context or narrow the current turn's submitted tool surface                   |
| `before_agent_start`            | Compatibility-only combined phase; prefer the two hooks above                            |
| **`before_agent_run`**          | Inspect the final prompt and session messages before model submission; can block the run |
| **`before_agent_reply`**        | Short-circuit the model turn with a synthetic reply or silence                           |
| **`before_agent_finalize`**     | Inspect the natural final answer and request one more model pass                         |
| `agent_end`                     | Observe final messages, success state, and run duration                                  |
| `heartbeat_prompt_contribution` | Add heartbeat-only context for background monitor and lifecycle plugins                  |

**Conversation observation**

- `model_call_started` / `model_call_ended` - observe sanitized provider/model call metadata, timing, outcome, and bounded request-id hashes without prompt or response content
- `llm_input` - observe provider input (system prompt, prompt, history)
- `llm_output` - observe provider output, usage, and the resolved `contextTokenBudget` when available

**Tools**

- **`before_tool_call`** - rewrite tool params, block execution, or require approval
- `after_tool_call` - observe tool results, errors, and duration
- `resolve_exec_env` - contribute plugin-owned environment variables to `exec`
- **`tool_result_persist`** - rewrite the assistant message produced from a tool result
- **`before_message_write`** - inspect or block an in-progress message write (rare)

**Messages and delivery**

| Hook                        | Purpose                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| **`inbound_claim`**         | Claim an inbound message for the plugin that owns its conversation binding |
| `channel_pairing_requested` | Observe newly created DM pairing requests                                  |
| `message_received`          | Observe inbound content, sender, thread, and metadata                      |
| **`message_sending`**       | Rewrite outbound content or cancel delivery                                |
| **`reply_payload_sending`** | Mutate or cancel normalized reply payloads before delivery                 |
| `message_sent`              | Observe outbound delivery success or failure                               |
| **`before_dispatch`**       | Inspect or rewrite an outbound dispatch before channel handoff             |
| **`reply_dispatch`**        | Participate in the final reply-dispatch pipeline                           |

`inbound_claim` is not a global pre-routing broadcast. OpenClaw invokes it only
for the plugin that owns the message's core-managed conversation binding. To
suppress an ordinary agent turn before model input without retaining the
original prompt in transcript, use `before_agent_run`. To short-circuit an agent
turn with a synthetic reply or silence, use `before_agent_reply`.

**Sessions and compaction**

- `session_start` / `session_end` - track session lifecycle boundaries. The event's `reason` is one of `new`, `reset`, `idle`, `daily`, `compaction`, `deleted`, `shutdown`, `restart`, or `unknown`. The `shutdown` and `restart` values fire from the gateway shutdown finalizer when the process is stopped or restarted while sessions are still active, so downstream plugins (such as memory or transcript stores) can finalize ghost rows that would otherwise be left in an open state across restarts. The finalizer is bounded so a slow plugin cannot block SIGTERM/SIGINT.
- `before_compaction` / `after_compaction` - observe or annotate compaction cycles
- `before_reset` - observe session-reset events (`/reset`, programmatic resets)

**Subagents**

- `subagent_spawned` / `subagent_ended` - observe subagent launch and completion.
- `subagent_delivery_target` - compatibility hook for completion delivery when no core session binding can project a route.
- `subagent_spawning` - deprecated compatibility hook. Core now prepares `thread: true` subagent bindings through channel session-binding adapters before `subagent_spawned` fires.
- `subagent_spawned` includes `resolvedModel` and `resolvedProvider` when OpenClaw has resolved the child session's native model before launch.

**Lifecycle**

| Hook                             | Purpose                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `gateway_start` / `gateway_stop` | Start or stop plugin-owned services with the Gateway                                                 |
| `deactivate`                     | Deprecated compatibility alias for `gateway_stop`; use `gateway_stop` in new plugins                 |
| `cron_reconciled`                | Reconcile against the complete Gateway cron state after startup or reload                            |
| `cron_changed`                   | Observe Gateway-owned cron lifecycle changes (added, updated, removed, started, finished, scheduled) |
| **`before_install`**             | Inspect staged skill or plugin install material from a loaded plugin runtime                         |
| **`skill_proposal_evaluate`**    | Evaluate one exact Skill Workshop draft and return attributed findings, metrics, or a decision       |
| `skill_proposal_changed`         | Observe durable Skill Workshop proposal lifecycle events after they commit                           |
| `skill_changed`                  | Observe committed live-skill create, update, and removal events                                      |

### Skill lifecycle and evaluation

Use `skill_proposal_evaluate` for static analyzers, security scanners,
benchmarks, model-based graders, or other third-party evaluators. OpenClaw
passes an immutable candidate bundle with file hashes and a tree hash. Update
proposals also include the complete current skill as `baseline`. Text files use
UTF-8 content; binary files use base64.

Evaluator registrations run concurrently. Give each evaluator a stable
`registrationId`:

```typescript
api.on(
  "skill_proposal_evaluate",
  async (event) => {
    const score = await evaluateBundle(event.candidate, event.baseline);
    return {
      evaluatorVersion: "rules-2026-07",
      mode: "baseline-comparison",
      decision: score.regressed ? "revise" : "pass",
      summary: score.summary,
      metrics: score.metrics,
      findings: score.findings,
    };
  },
  { registrationId: "quality-regression", timeoutMs: 90_000 },
);
```

Stored outcomes identify the evaluator, plugin id, plugin package version,
status, and returned result. Timeouts and thrown errors are recorded as
attributed error outcomes; they do not fail the whole evaluation. Applying a
proposal is blocked only when a completed evaluator returns
`decision: "block"`. Apply revalidates the evaluated target tree under the
Workshop mutation lock, so any live skill asset drift requires reevaluation.
The combined persisted evaluator result is capped at 512 KiB.

`skill_proposal_changed` fires after the matching proposal row and append-only
lifecycle event commit. It carries the event id, sequence, exact proposal
revision hash, optional correlation id, and evaluation outcomes.
`skill_changed` fires after a live skill create, update, or removal commits and
includes before/after artifacts with content, tree, declared, and source
versions when available.

These hooks are primitives, not an optimization scheduler. A plugin or external
controller can observe a durable proposal event, evaluate its exact revision hash,
revise with that hash and a correlation id, then repeat. OpenClaw does not
automatically revise proposals or run an unbounded evaluation loop.
Event replay is byte-bounded and returns `nextSequence` when another page is
available.

## Debug runtime hooks

Use `before_model_resolve` when a plugin needs to switch the provider or model
for an agent turn. It runs before model resolution; `llm_output` only runs after
a model attempt produces assistant output.

For proof of the effective session model, inspect runtime registrations, then
use `openclaw sessions` or the Gateway session/status surfaces. When debugging
provider payloads, start the Gateway with `--raw-stream` and
`--raw-stream-path <path>`; those flags write raw model stream events to a jsonl
file.

## Tool call policy

`before_tool_call` receives:

- `event.toolName`
- `event.params`
- optional `event.toolKind` and `event.toolInputKind`, host-authoritative
  discriminators for tools that intentionally share names; for example, outer
  code-mode `exec` calls use `toolKind: "code_mode_exec"` and
  include `toolInputKind: "javascript" | "typescript"` when the input language
  is known
- optional `event.derivedPaths`, containing best-effort host-derived target path
  hints for well-known tool envelopes such as `apply_patch`; when present,
  these paths may be incomplete or may over-approximate what the tool will
  actually touch (for example, with malformed or partial inputs)
- optional `event.runId`
- optional `event.toolCallId`
- context fields such as `ctx.agentId`, `ctx.sessionKey`, `ctx.sessionId`,
  `ctx.runId`, `ctx.toolKind`, `ctx.toolInputKind`, and diagnostic `ctx.trace`
- optional `ctx.abortSignal`, which aborts when the owning tool call is
  cancelled; handlers should pass it to cancellable I/O and remove any
  listeners they register
- optional `ctx.requester`, the host-derived requester that initiated the current
  message run. It can include `channel`, `accountId`, `senderId`,
  `senderIsOwner`, and provider-native `roleIds`. Missing fields are unproven,
  not false assurances; fail closed when policy requires them.

It can return:

```typescript
type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    pluginId?: string;
    onResolution?: (
      decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled",
    ) => Promise<void> | void;
  };
};
```

Hook guard behavior for typed lifecycle hooks:

- `block: true` is terminal and skips lower-priority handlers.
- `block: false` is treated as no decision.
- `params` rewrites the tool parameters for execution.
- `requireApproval` pauses the agent run and asks the user through plugin
  approvals. The `/approve` command can approve both exec and plugin approvals.
  In Codex app-server report-mode native `PreToolUse` relays, this is deferred
  to the matching app-server approval request; see [Codex harness runtime](/plugins/codex-harness-runtime#hook-boundaries).
- A lower-priority `block: true` can still block after a higher-priority hook
  requested approval.
- `onResolution` receives the resolved approval decision - `allow-once`,
  `allow-always`, `deny`, `timeout`, or `cancelled`.

See [Plugin permission requests](/plugins/plugin-permission-requests) for
approval routing, decision behavior, and when to use `requireApproval` instead
of optional tools or exec approvals.

Bundled plugins that need host-level policy can register trusted tool policies
with `api.registerTrustedToolPolicy(...)`. These run before ordinary
`before_tool_call` hooks and before external plugin decisions. Use them only
for host-trusted gates such as workspace policy, budget enforcement, or
reserved workflow safety. External plugins should use normal `before_tool_call`
hooks.

Trusted policies may set `matcher` to the same canonical tool-id list accepted
by `before_tool_call`. Omit the matcher to retain match-all behavior.

### Exec environment hook

`resolve_exec_env` lets plugins contribute environment variables to `exec`
tool invocations after the base exec environment is built and before the
command runs. It receives:

- `event.sessionKey`
- `event.toolName`, currently always `"exec"`
- `event.host`, one of `"gateway"`, `"sandbox"`, or `"node"`
- context fields such as `ctx.agentId`, `ctx.sessionKey`,
  `ctx.messageProvider`, and `ctx.channelId`

Return a `Record<string, string>` to merge into the exec environment. Handlers
run in priority order, and later hook results override earlier hook results for
the same key.

Hook output is filtered through the host exec environment key policy before it
is merged. Invalid keys, `PATH`, and dangerous host override keys such as
`LD_*`, `DYLD_*`, `NODE_OPTIONS`, proxy variables, and TLS override variables
are dropped. The filtered plugin env is included in gateway approval/audit
metadata and forwarded to node-host execution requests.

### Tool result persistence

Tool results can include structured `details` for UI rendering, diagnostics,
media routing, or plugin-owned metadata. Treat `details` as runtime metadata,
not prompt content:

- OpenClaw strips `toolResult.details` before provider replay and compaction
  input so metadata does not become model context.
- Persisted session entries keep only bounded `details`. Oversized details are
  replaced with a compact summary and `persistedDetailsTruncated: true`.
- `tool_result_persist` and `before_message_write` run before the final
  persistence cap. Hooks should still keep returned `details` small and avoid
  placing prompt-relevant text only in `details`; put model-visible tool output
  in `content`.

## Prompt and model hooks

Use the phase-specific hooks for new plugins:

- `before_model_resolve`: receives only the current prompt and attachment
  metadata. Return `providerOverride` or `modelOverride`.
- `agent_turn_prepare`: receives the current prompt, prepared session messages,
  and any exactly-once queued injections drained for this session. Return
  `prependContext` or `appendContext`.
- `before_prompt_build`: receives the current prompt and session messages.
  Return `prependContext`, `appendContext`, `systemPrompt`,
  `prependSystemContext`, `appendSystemContext`, or `toolsAllow`. `toolsAllow`
  can only narrow the host-resolved tool surface for the current turn; `[]`
  submits no optional tools, while omitting it leaves the existing surface unchanged.
  Restrictions returned by multiple hooks are intersected. The embedded runner
  and Copilot harness apply this field to their turn-scoped submitted tool
  surfaces. The Codex app-server harness rejects restrictive values because its
  dynamic tools are thread-scoped and Codex `turn/start` has no tool-surface
  override; use the embedded or Copilot runtime when a plugin requires this
  policy.
- `heartbeat_prompt_contribution`: runs only for heartbeat turns and returns
  `prependContext` or `appendContext`. It is intended for background monitors
  that need to summarize current state without changing user-initiated turns.

`before_agent_start` remains for compatibility. Prefer the explicit hooks above
so your plugin does not depend on a legacy combined phase.

`before_agent_run` runs after prompt construction and before any model input,
including prompt-local image loading and `llm_input` observation. It receives
the current user input as `prompt`, plus loaded session history in `messages`
and the active system prompt. Return `{ outcome: "block", reason, message? }`
to stop the run before the model can read the prompt. `reason` is internal;
`message` is the user-facing replacement. The only supported outcomes are
`pass` and `block`; unsupported decision shapes fail closed.

When a run is blocked, OpenClaw stores only the replacement text in
`message.content` plus non-sensitive block metadata such as the blocking plugin
id and timestamp. The original user text is not retained in transcript or future
context. Internal block reasons are treated as sensitive and excluded from
transcript, history, broadcast, log, and diagnostics payloads. Observability
should use sanitized fields such as blocker id, outcome, timestamp, or a safe
category.

`before_agent_start` and `agent_end` include `event.runId` when OpenClaw can
identify the active run. The same value is also available on `ctx.runId`.
Cron-driven runs also expose `ctx.jobId` (the originating cron job id) so
plugin hooks can scope metrics, side effects, or state to a specific scheduled
job.

For channel-originated runs, `ctx.messageProvider` is the provider surface such
as `discord` or `telegram`, while `ctx.channelId` is the conversation target
identifier when OpenClaw can derive one from the session key or delivery
metadata.

`agent_end` is an observation hook. Gateway and persistent harness paths run it
fire-and-forget after the turn, while short-lived one-shot CLI paths wait for the
hook promise before process cleanup so trusted plugins can flush terminal
observability or capture state. The hook runner applies a 30 second timeout so a
wedged plugin or embedding endpoint cannot leave the hook promise pending
forever. A timeout is logged and OpenClaw continues; it does not cancel
plugin-owned network work unless the plugin also uses its own abort signal.

Use `model_call_started` and `model_call_ended` for provider-call telemetry
that should not receive raw prompts, history, responses, headers, request
bodies, or provider request IDs. These hooks include stable metadata such as
`runId`, `callId`, `provider`, `model`, optional `api`/`transport`, terminal
`durationMs`/`outcome`, and `upstreamRequestIdHash` when OpenClaw can derive a
bounded provider request-id hash. When the runtime has resolved context-window
metadata, the hook event and context also include `contextTokenBudget`, the
effective token budget after model/config/agent caps, plus
`contextWindowSource` and `contextWindowReferenceTokens` when a lower cap was
applied.

`before_agent_finalize` runs only when a harness is about to accept a natural
final assistant answer. It is not the `/stop` cancellation path and does not
run when the user aborts a turn. Return `{ action: "revise", reason }` to ask
the harness for one more model pass before finalization, `{ action:
"finalize", reason? }` to force finalization, or omit a result to continue.
Codex native `Stop` hooks are relayed into this hook as OpenClaw
`before_agent_finalize` decisions.

When returning `action: "revise"`, plugins can include `retry` metadata to make
the extra model pass bounded and replay-safe:

```typescript
type BeforeAgentFinalizeRetry = {
  instruction: string;
  idempotencyKey?: string;
  maxAttempts?: number;
};
```

`instruction` is appended to the revision reason sent to the harness.
`idempotencyKey` lets the host count retries for the same plugin request across
equivalent finalize decisions, and `maxAttempts` caps how many extra passes the
host will allow before continuing with the natural final answer.

This is the seam for **rules-based verification**: run a deterministic check
(linter, type check, tests on the files the turn touched) and, on failure, feed
the specific failing rule back as the revision reason. Rules-based feedback that
names what failed and why is a higher-quality, lower-latency verify signal than
an LLM-as-judge pass. Keep the gate opt-in and bound it with `maxAttempts`, since
every revision costs an extra model round-trip.

```typescript
// before_agent_finalize handler
async ({ event }) => {
  const result = await runProjectChecks(event.cwd); // your lint/test runner
  if (result.ok) {
    return; // continue to finalize
  }
  return {
    action: "revise",
    reason: `Verification failed before finalizing:\n${result.failureSummary}`,
    retry: { instruction: "Fix the reported failures, then finish.", maxAttempts: 1 },
  };
};
```

Implement this as a plugin `before_agent_finalize` hook rather than core config:
the seam is generic and the check command, file scope, and result parsing are
project-specific. Caveat: the host refuses a revision once the turn has produced
a deterministic side effect (for example a delivered message), so a verify gate
can only correct answers whose side effects have not yet been committed.

Non-bundled plugins that need raw conversation hooks (`before_model_resolve`,
`agent_turn_prepare`, `before_prompt_build`, `before_agent_reply`, `llm_input`,
`llm_output`, `before_agent_finalize`, `agent_end`, or `before_agent_run`) must
set:

```json
{
  "plugins": {
    "entries": {
      "my-plugin": {
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

`agent_turn_prepare` and `before_prompt_build` also mutate prompt construction,
so they require conversation access and remain subject to
`plugins.entries.<id>.hooks.allowPromptInjection`. Prompt-mutating hooks and
durable next-turn injections can be disabled per plugin by setting that option
to `false`.

### Session extensions and next-turn injections

Workflow plugins can persist small JSON-compatible session state with
`api.registerSessionExtension(...)` and update it through the Gateway
`sessions.pluginPatch` method. Session rows project registered extension state
through `pluginExtensions`, letting Control UI and other clients render
plugin-owned status without learning plugin internals.

Use `api.enqueueNextTurnInjection(...)` when a plugin needs durable context to
reach the next model turn exactly once. OpenClaw drains queued injections before
prompt hooks, drops expired injections, and deduplicates by `idempotencyKey`
per plugin. This is the right seam for approval resumes, policy summaries,
background monitor deltas, and command continuations that should be visible to
the model on the next turn but should not become permanent system prompt text.

Cleanup semantics are part of the contract. Session extension cleanup and
runtime lifecycle cleanup callbacks receive `reset`, `delete`, `disable`, or
`restart`. The host removes the owning plugin's persistent session extension
state and pending next-turn injections for reset/delete/disable; restart keeps
durable session state while cleanup callbacks let plugins release scheduler
jobs, run context, and other out-of-band resources for the old runtime
generation.

## Message hooks

Use message hooks for channel-level routing and delivery policy:

- `message_received`: observe inbound content, sender, `threadId`, `messageId`,
  `senderId`, optional run/session correlation, and metadata.
- `message_sending`: rewrite `content` or return `{ cancel: true }`.
- `reply_payload_sending`: rewrite normalized `ReplyPayload` objects (including
  `presentation`, `delivery`, media refs, and text) or return `{ cancel: true }`.
- `message_sent`: observe final success or failure.

For audio-only TTS replies, `content` may contain the hidden spoken transcript
even when the channel payload has no visible text/caption. Rewriting that
`content` updates the hook-visible transcript only; it is not rendered as a
media caption.

Message hook contexts expose stable correlation fields when available:
`ctx.sessionKey`, `ctx.runId`, `ctx.messageId`, `ctx.senderId`, `ctx.trace`,
`ctx.traceId`, `ctx.spanId`, `ctx.parentSpanId`, and `ctx.callDepth`. Inbound
and `before_dispatch` contexts also expose reply metadata when the channel has
visibility-filtered quoted message data: `replyToId`, `replyToBody`, and
`replyToSender`. Prefer these first-class fields before reading legacy metadata.

`before_dispatch` receives the canonical inbound `messageId` in both its event
and context.

Prefer typed `threadId` and `replyToId` fields before using channel-specific
metadata.

Decision rules:

- `message_sending` with `cancel: true` is terminal.
- `message_sending` with `cancel: false` is treated as no decision.
- Rewritten `content` continues to lower-priority hooks unless a later hook
  cancels delivery.
- `reply_payload_sending` runs after payload normalization and before channel
  delivery, including replies routed back to the originating channel. Handlers
  run sequentially and each handler sees the latest payload produced by
  higher-priority handlers.
- `reply_payload_sending` payloads do not expose runtime trust markers such as
  `trustedLocalMedia`; plugins can edit payload shape but cannot grant local
  media trust.
- `message_sending` can return `cancelReason` and bounded `metadata` with a
  cancellation. New message lifecycle APIs expose this as a suppressed delivery
  outcome with reason `cancelled_by_message_sending_hook`; legacy direct
  delivery keeps returning an empty result array for compatibility.
- `message_sent` is observation-only. Handler failures are logged and do not
  change the delivery result.

## Install hooks

`before_install` runs after the operator-owned `security.installPolicy` check
when one is configured. The `builtinScan` field remains in the event payload for
compatibility, but OpenClaw no longer runs built-in install-time dangerous-code
blocking, so it is an empty `ok` result. Return additional findings or
`{ block: true, blockReason }` to stop the install.

`block: true` is terminal. `block: false` is treated as no decision.
Handler failures block the install fail-closed.

## Gateway lifecycle

Use `gateway_start` for plugin services that need Gateway-owned state. The
context exposes `ctx.config`, `ctx.workspaceDir`, and `ctx.getCron?.()` for
cron inspection and updates. Use `gateway_stop` to clean up long-running
resources.

Do not rely on the internal `gateway:startup` hook for plugin-owned runtime
services.

`cron_changed` fires for gateway-owned cron lifecycle events with a typed
event payload covering `added`, `updated`, `removed`, `started`, `finished`,
and `scheduled` reasons. The event carries a `PluginHookGatewayCronJob`
snapshot (including `state.nextRunAtMs`, `state.lastRunStatus`, and
`state.lastError` when present) plus a `PluginHookGatewayCronDeliveryStatus`
of `not-requested` | `delivered` | `not-delivered` | `unknown`. Removed
events still carry the deleted job snapshot so external schedulers can
reconcile state. Use `ctx.getCron?.()` and `ctx.config` from the runtime
context when syncing external wake schedulers, and keep OpenClaw as the
source of truth for due checks and execution.

## Upcoming deprecations

A few hook-adjacent surfaces are deprecated but still supported. Migrate
before the next major release:

- **Plaintext channel envelopes** in `inbound_claim` and `message_received`
  handlers. Read `BodyForAgent` and the structured user-context blocks
  instead of parsing flat envelope text. See
  [Plaintext channel envelopes → BodyForAgent](/plugins/sdk-migration#active-deprecations).
- **`before_agent_start`** remains for compatibility. New plugins should use
  `before_model_resolve` and `before_prompt_build` instead of the combined
  phase.
- **`subagent_spawning`** remains for compatibility with older plugins, but
  new plugins should not return thread routing from it. Core prepares
  `thread: true` subagent bindings through channel session-binding adapters
  before `subagent_spawned` fires.
- **`deactivate`** remains as a deprecated cleanup compatibility alias until
  after 2026-08-16. New plugins should use `gateway_stop`.
- **`onResolution` in `before_tool_call`** now uses the typed
  `PluginApprovalResolution` union (`allow-once` / `allow-always` / `deny` /
  `timeout` / `cancelled`) instead of a free-form `string`.

For the full list - memory capability registration, provider thinking
profile, external auth providers, provider discovery types, task runtime
accessors, and the `command-auth` → `command-status` rename - see
[Plugin SDK migration → Active deprecations](/plugins/sdk-migration#active-deprecations).

## Related

- [Plugin SDK migration](/plugins/sdk-migration) - active deprecations and removal timeline
- [Building plugins](/plugins/building-plugins)
- [Plugin SDK overview](/plugins/sdk-overview)
- [Plugin entry points](/plugins/sdk-entrypoints)
- [Internal hooks](/automation/hooks)
- [Plugin architecture internals](/plugins/architecture-internals)
