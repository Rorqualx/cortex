// Internal hook types define runtime hook event families and payload contracts.
export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";

const KNOWN_INTERNAL_HOOK_EVENT_FAMILIES = [
  "command",
  "session",
  "agent",
  "gateway",
  "message",
] as const satisfies readonly InternalHookEventType[];

/**
 * Event keys emitted by core trigger sites (see docs/automation/hooks.md
 * events table — keep both in sync when adding a trigger). Hooks can also
 * subscribe to a bare family key to receive every action of that family.
 * Plugins can emit additional keys via the deprecated plugin-sdk/hook-runtime
 * barrel, so anything outside this set is flagged as a likely typo
 * (advisory), not rejected.
 */
export const KNOWN_INTERNAL_HOOK_EVENT_KEYS = [
  "agent:bootstrap",
  "command:new",
  "command:reset",
  "command:stop",
  "gateway:pre-restart",
  "gateway:shutdown",
  "gateway:startup",
  "message:preprocessed",
  "message:received",
  "message:sent",
  "message:transcribed",
  "session:compact:after",
  "session:compact:before",
  "session:patch",
] as const;

export function isKnownInternalHookEventKey(key: string): boolean {
  return (
    (KNOWN_INTERNAL_HOOK_EVENT_KEYS as readonly string[]).includes(key) ||
    (KNOWN_INTERNAL_HOOK_EVENT_FAMILIES as readonly string[]).includes(key)
  );
}

export interface InternalHookEvent {
  /** The type of event (command, session, agent, gateway, etc.) */
  type: InternalHookEventType;
  /** The specific action within the type (e.g., 'new', 'reset', 'stop') */
  action: string;
  /** The session key this event relates to */
  sessionKey: string;
  /** Additional context specific to the event */
  context: Record<string, unknown>;
  /** Timestamp when the event occurred */
  timestamp: Date;
  /** Messages to send back to the user (hooks can push to this array) */
  messages: string[];
}

export type InternalHookHandler = (event: InternalHookEvent) => Promise<void> | void;

/**
 * Canonical set of internal hook event keys that a dispatch site actually emits.
 * A key is either a bare type (subscribe to every action of that type) or a
 * `type:action` / `type:action:phase` key. The loader uses this to warn when a
 * hook subscribes to an event nothing emits (a HOOK.md typo or stale registry),
 * which would otherwise fail silently — the handler simply never fires.
 *
 * CONTRACT: keep in sync with the `createInternalHookEvent(...)` emission sites.
 * Command actions are the closed set new|reset|stop; compaction emits the
 * two-segment compact:before / compact:after actions under the `session` type.
 */
export const KNOWN_INTERNAL_HOOK_EVENTS: ReadonlySet<string> = new Set([
  // Bare types — a hook may subscribe to every action of a type.
  "command",
  "session",
  "agent",
  "gateway",
  "message",
  // command:<action> — closed set (ResetCommandAction + stop)
  "command:new",
  "command:reset",
  "command:stop",
  // session:<action>
  "session:patch",
  "session:compact:before",
  "session:compact:after",
  // agent:<action>
  "agent:bootstrap",
  // gateway:<action>
  "gateway:startup",
  "gateway:shutdown",
  "gateway:pre-restart",
  // message:<action>
  "message:received",
  "message:transcribed",
  "message:preprocessed",
  "message:sent",
]);

/** True when `event` is a hook event key that some dispatch site emits. */
export function isKnownInternalHookEvent(event: string): boolean {
  return KNOWN_INTERNAL_HOOK_EVENTS.has(event);
}
