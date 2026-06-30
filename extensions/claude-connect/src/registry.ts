// Persistent session registry mapping an opaque handle -> the Claude Code
// session id (+ cwd/mode) so turns resume across tool calls and gateway
// restarts. Backed by the shared OpenClaw state DB via plugin KV (no JSON
// sidecar); the live Claude conversation itself lives in Claude Code's own
// per-project session store and is reached with `--resume <claudeSessionId>`.
import type { OpenClawPluginApi } from "../api.js";
import type { SessionMode } from "./claude-args.js";

export type SessionRecord = {
  /** Claude Code session id; absent until the first turn establishes one. */
  claudeSessionId?: string;
  cwd: string;
  mode: SessionMode;
  label?: string;
  createdAt: number;
};

export type SessionRegistry = {
  put(handle: string, record: SessionRecord): Promise<void>;
  get(handle: string): Promise<SessionRecord | undefined>;
  delete(handle: string): Promise<boolean>;
};

const NAMESPACE = "sessions";
const MAX_ENTRIES = 10_000;

// One store handle per plugin runtime; opening the keyed store is the only
// supported plugin-owned persistence seam and resolves to `plugin_state_entries`.
const registries = new WeakMap<object, SessionRegistry>();

export function getSessionRegistry(api: OpenClawPluginApi): SessionRegistry {
  const existing = registries.get(api);
  if (existing) {
    return existing;
  }
  const store = api.runtime.state.openKeyedStore<SessionRecord>({
    namespace: NAMESPACE,
    maxEntries: MAX_ENTRIES,
  });
  const registry: SessionRegistry = {
    put: (handle, record) => store.register(handle, record),
    get: (handle) => store.lookup(handle),
    delete: (handle) => store.delete(handle),
  };
  registries.set(api, registry);
  return registry;
}
