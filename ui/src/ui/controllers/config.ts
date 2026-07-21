// Control UI controller manages config gateway state.
import { applyMergePatch } from "../../../../src/config/merge-patch.ts";
import { generateGatewayToken } from "../gateway-token.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { ConfigSchemaResponse, ConfigSnapshot, ConfigUiHints } from "../types.ts";
import type { JsonSchema } from "../views/config-form.shared.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../chat/clipboard.ts";
import { coerceFormValues } from "./config/form-coerce.ts";
import { parseJson5Text, warmJson5 } from "../json5-runtime.ts";
import {
  cloneConfigObject,
  removePathValue,
  sanitizeRedactedFormForSubmit,
  serializeConfigForm,
  setPathValue,
} from "./config/form-utils.ts";

/** Configured gateway token shown in the overview Gateway Token section. */
export type GatewayTokenView = {
  loading: boolean;
  token: string | null;
  source: string | null;
  secretRefConfigured: boolean;
  error: string | null;
};

export type ConfigAutoSaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

/** Debounce window between the last form edit and its automatic config.set. */
const CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS = 800;

/** Reads the additive ack hash from a config.set/config.apply response. */
function readAckHash(ack: unknown): string | null {
  const hash = (ack as { hash?: unknown } | null | undefined)?.hash;
  return typeof hash === "string" && hash.length > 0 ? hash : null;
}

/**
 * Gateway contract: requireConfigBaseHash in
 * src/gateway/server-methods/config.ts rejects writes whose baseHash no
 * longer matches the file with exactly this message. A conflict means another
 * writer changed openclaw.json; retrying the whole-form draft would clobber
 * their edit, so callers surface a reload affordance instead.
 */
function isConfigBaseHashConflictError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("config changed since last load");
}

export type ConfigState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  overviewGatewayToken: GatewayTokenView | null;
  applySessionKey: string;
  configLoading: boolean;
  configRaw: string;
  configRawOriginal: string;
  configRawOriginalParsed: Record<string, unknown> | null;
  configRawOriginalParsePending: Promise<void> | null;
  configValid: boolean | null;
  configIssues: unknown[];
  configSaving: boolean;
  configApplying: boolean;
  updateRunning: boolean;
  configAutoSaveStatus: ConfigAutoSaveStatus;
  /** True when the config file revision differs from the active Gateway runtime. */
  configNeedsApply: boolean;
  configSnapshot: ConfigSnapshot | null;
  configDraftBaseHash?: string | null;
  configSchema: unknown;
  configSchemaVersion: string | null;
  configSchemaLoading: boolean;
  configUiHints: ConfigUiHints;
  configForm: Record<string, unknown> | null;
  configFormOriginal: Record<string, unknown> | null;
  configFormDirty: boolean;
  configFormMode: "form" | "raw";
  configSearchQuery: string;
  configActiveSection: string | null;
  configActiveSubsection: string | null;
  pendingUpdateExpectedVersion: string | null;
  pendingUpdateHandoff: boolean;
  updateStatusBanner: { tone: "danger" | "warn" | "info"; text: string } | null;
  overviewGeneratingToken: boolean;
  lastError: string | null;
  chatError?: string | null;
};

const autoAllowlistedPluginIdsByState = new WeakMap<ConfigState, Set<string>>();
const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";

export type LoadConfigOptions = {
  discardPendingChanges?: boolean;
};

const requestVersionsByState = new WeakMap<ConfigState, { config: number; schema: number }>();
const connectionEpochsByState = new WeakMap<object, number>();

type ConfigGatewayClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type ConfigConnectionState = {
  client: ConfigGatewayClient | null;
  connected: boolean;
};

function nextRequestVersion(state: ConfigState, key: "config" | "schema"): number {
  const current = requestVersionsByState.get(state) ?? { config: 0, schema: 0 };
  const next = { ...current, [key]: current[key] + 1 };
  requestVersionsByState.set(state, next);
  return next[key];
}

function currentConfigConnectionEpoch(state: object): number {
  return connectionEpochsByState.get(state) ?? 0;
}

function invalidateConfigConnection(state: object): void {
  connectionEpochsByState.set(state, currentConfigConnectionEpoch(state) + 1);
}

function isCurrentConfigConnection(
  state: ConfigConnectionState,
  client: ConfigGatewayClient,
  connectionEpoch: number,
): boolean {
  return (
    state.connected &&
    state.client === client &&
    currentConfigConnectionEpoch(state) === connectionEpoch
  );
}

function isCurrentRequest(
  state: ConfigState,
  key: "config" | "schema",
  version: number,
  client: GatewayBrowserClient,
  connectionEpoch: number,
): boolean {
  return (
    isCurrentConfigConnection(state, client, connectionEpoch) &&
    requestVersionsByState.get(state)?.[key] === version
  );
}

/** Resolves true only when a current-epoch snapshot was actually applied. */
export async function loadConfig(
  state: ConfigState,
  options: LoadConfigOptions = {},
  isCurrentLoad: () => boolean = () => true,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const version = nextRequestVersion(state, "config");
  state.configLoading = true;
  state.lastError = null;
  state.chatError = null;
  try {
    const res = await client.request<ConfigSnapshot>("config.get", {});
    if (!isCurrentRequest(state, "config", version, client, connectionEpoch) || !isCurrentLoad()) {
      return false;
    }
    applyConfigSnapshot(state, res, options);
    return true;
  } catch (err) {
    if (isCurrentRequest(state, "config", version, client, connectionEpoch)) {
      state.lastError = String(err);
    }
    return false;
  } finally {
    if (isCurrentRequest(state, "config", version, client, connectionEpoch)) {
      state.configLoading = false;
    }
  }
}

/**
 * Generate a gateway token and persist it to gateway.auth.{mode,token}.
 *
 * Uses config.patch (a deep merge-patch) so only the auth keys change; the
 * gateway validates, writes, and live-rotates its shared secret, keeping the
 * current (device-authenticated) session connected. Returns the plaintext token
 * on success so the caller can reveal it in the field — the gateway never sends
 * a token back, so generating it client-side is the only way to display it.
 */
export async function generateAndSaveGatewayToken(state: ConfigState): Promise<string | null> {
  if (!state.client || !state.connected) {
    state.lastError = "Connect to the gateway before generating a token.";
    return null;
  }
  if (state.overviewGeneratingToken) {
    return null;
  }
  state.overviewGeneratingToken = true;
  state.lastError = null;
  try {
    // config.patch is an optimistic write guarded by the on-disk config hash, so
    // read a fresh snapshot immediately before patching to avoid a stale-hash reject.
    const snapshot = await state.client.request<ConfigSnapshot>("config.get", {});
    const baseHash = snapshot.hash;
    if (!baseHash) {
      state.lastError = "Config hash unavailable; reload and retry.";
      return null;
    }
    const token = generateGatewayToken();
    const raw = JSON.stringify({ gateway: { auth: { mode: "token", token } } });
    await state.client.request("config.patch", { raw, baseHash });
    state.updateStatusBanner = {
      tone: "info",
      text: "Gateway token generated and saved. Other clients using a token must reconnect with the new one.",
    };
    return token;
  } catch (err) {
    state.lastError = `Failed to save gateway token: ${String(err)}`;
    return null;
  } finally {
    state.overviewGeneratingToken = false;
  }
}

/**
 * Fetch the configured gateway token for display (reveal-on-demand).
 *
 * The gateway redacts the token from every other RPC; this admin-scoped call is
 * the one deliberate egress. Returns the token to fill the field, or null with a
 * banner when it's externally managed (SecretRef) or simply not configured.
 */
/**
 * Load the configured gateway token into state for the overview section.
 * Admin-gated server-side (gateway.auth.token.get); callers should only invoke
 * this for admin sessions. SecretRef-managed tokens come back with token=null.
 */
export async function loadGatewayTokenInfo(state: ConfigState): Promise<void> {
  if (!state.client || !state.connected) {
    return;
  }
  const prev = state.overviewGatewayToken;
  state.overviewGatewayToken = {
    loading: true,
    token: prev?.token ?? null,
    source: prev?.source ?? null,
    secretRefConfigured: prev?.secretRefConfigured ?? false,
    error: null,
  };
  try {
    const res = await state.client.request<{
      token?: string | null;
      source?: string | null;
      secretRefConfigured?: boolean;
    }>("gateway.auth.token.get", {});
    state.overviewGatewayToken = {
      loading: false,
      token: res.token ?? null,
      source: res.source ?? null,
      secretRefConfigured: Boolean(res.secretRefConfigured),
      error: null,
    };
  } catch (err) {
    state.overviewGatewayToken = {
      loading: false,
      token: null,
      source: null,
      secretRefConfigured: false,
      error: String(err),
    };
  }
}

export async function loadConfigSchema(state: ConfigState) {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state.configSchemaLoading) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const version = nextRequestVersion(state, "schema");
  state.configSchemaLoading = true;
  try {
    const res = await client.request<ConfigSchemaResponse>("config.schema", {});
    if (!isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      return;
    }
    applyConfigSchema(state, res);
  } catch (err) {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.lastError = String(err);
    }
  } finally {
    if (isCurrentRequest(state, "schema", version, client, connectionEpoch)) {
      state.configSchemaLoading = false;
    }
  }
}

function applyConfigSchema(state: ConfigState, res: ConfigSchemaResponse) {
  state.configSchema = res.schema ?? null;
  state.configUiHints = res.uiHints ?? {};
  state.configSchemaVersion = res.version ?? null;
}

function asConfigRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function resolveEditableSnapshotConfig(
  snapshot: ConfigSnapshot | null | undefined,
): Record<string, unknown> | null {
  return (
    asConfigRecord(snapshot?.sourceConfig) ??
    asConfigRecord(snapshot?.resolved) ??
    asConfigRecord(snapshot?.config)
  );
}

export function applyConfigSnapshot(
  state: ConfigState,
  snapshot: ConfigSnapshot,
  options: LoadConfigOptions = {},
) {
  const preservePendingChanges = state.configFormDirty && options.discardPendingChanges !== true;
  if (options.discardPendingChanges === true) {
    // Discard resets pending edits and stale save status, but NOT the restart
    // banner: a saved-but-unapplied config still needs an apply even after
    // the local draft is thrown away.
    state.configAutoSaveStatus = "idle";
  }
  // Upstream config.get additions not yet on the fork's ConfigSnapshot wire
  // type; read structurally so older gateways (fields absent) keep the
  // process-local configNeedsApply value.
  const revisionFields = snapshot as ConfigSnapshot & {
    configRevisionHash?: string | null;
    appliedConfigHash?: string | null;
  };
  const currentRevisionHash = revisionFields.configRevisionHash ?? snapshot.hash ?? null;
  if (revisionFields.appliedConfigHash !== undefined) {
    state.configNeedsApply = currentRevisionHash !== revisionFields.appliedConfigHash;
  }
  const draftBaseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash ?? null;
  state.configSnapshot = snapshot;
  const editableConfig = resolveEditableSnapshotConfig(snapshot);
  const rawAvailable =
    typeof snapshot.raw === "string" || Boolean(editableConfig) || Boolean(state.configForm);
  if (!rawAvailable && state.configFormMode === "raw") {
    state.configFormMode = "form";
  }
  const rawFromSnapshot: string =
    typeof snapshot.raw === "string"
      ? snapshot.raw
      : editableConfig
        ? serializeConfigForm(editableConfig)
        : state.configRaw;
  if (!preservePendingChanges) {
    state.configRaw = rawFromSnapshot;
  } else if (state.configFormMode !== "raw" && state.configForm) {
    state.configRaw = serializeConfigForm(state.configForm);
  } else if (state.configFormMode !== "raw") {
    state.configRaw = rawFromSnapshot;
  }
  state.configValid = typeof snapshot.valid === "boolean" ? snapshot.valid : null;
  state.configIssues = Array.isArray(snapshot.issues) ? snapshot.issues : [];

  if (!preservePendingChanges) {
    state.configForm = cloneConfigObject(editableConfig ?? {});
    state.configFormOriginal = cloneConfigObject(editableConfig ?? {});
    setConfigRawOriginal(state, rawFromSnapshot);
    state.configFormDirty = false;
    state.configFormMode = "form";
    state.configDraftBaseHash = snapshot.hash ?? null;
    autoAllowlistedPluginIdsByState.delete(state);
  } else {
    state.configDraftBaseHash = draftBaseHash;
  }
}

function asJsonSchema(value: unknown): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchema;
}

/**
 * Serialize the form state for submission to `config.set` / `config.apply`.
 *
 * HTML `<input>` elements produce string `.value` properties, so numeric and
 * boolean config fields can leak into `configForm` as strings.  We coerce
 * them back to their schema-defined types before JSON serialization so the
 * gateway's Zod validation always sees correctly typed values.
 */
function serializeFormForSubmit(state: ConfigState): string {
  // A clean snapshot submits its raw bytes verbatim: reserializing the parsed
  // form would destroy JSON5 comments/formatting the file already has (the
  // restart banner's apply right after a raw-mode save hits exactly this).
  if (!state.configFormDirty && typeof state.configSnapshot?.raw === "string") {
    return state.configSnapshot.raw;
  }
  if (state.configFormMode !== "form" || !state.configForm) {
    return state.configRaw;
  }
  const schema = asJsonSchema(state.configSchema);
  const form = schema
    ? (coerceFormValues(state.configForm, schema) as Record<string, unknown>)
    : state.configForm;
  const sanitized = sanitizeRedactedFormForSubmit(
    form,
    state.configFormOriginal,
    state.configRawOriginalParsed,
  );
  return serializeConfigForm(sanitized);
}

type ConfigSubmitMethod = "config.set" | "config.apply";
type ConfigSubmitBusyKey = "configSaving" | "configApplying";

function resolveUpdateStatusBanner(params: {
  status?: string;
  reason?: string;
  handoff?: { command?: string; message?: string };
}): {
  tone: "danger" | "warn" | "info";
  text: string;
} {
  const status = (params.status ?? "error").trim() || "error";
  const reason = (params.reason ?? "unexpected-error").trim() || "unexpected-error";
  const tone = status === "skipped" ? "warn" : "danger";
  const handoffCommand = params.handoff?.command?.trim();
  const handoffMessage = params.handoff?.message?.trim();
  const handoffUnavailableGuidance = handoffCommand
    ? `Run \`${handoffCommand}\` from a shell outside the Gateway process.`
    : (handoffMessage ??
      "OpenClaw could not find a safe supervisor handoff. Run `openclaw update` from a shell outside the Gateway process.");
  const guidance =
    {
      dirty: "Commit or stash changes, then retry.",
      "no-upstream": "Set an upstream branch, then retry.",
      "not-git-install":
        "Not a git checkout. Run `openclaw update` from the CLI for a global reinstall.",
      "not-openclaw-root":
        "Run the update from an OpenClaw checkout or use the CLI global reinstall path.",
      "deps-install-failed": "Dependency install failed. Fix the install error and retry.",
      "build-failed": "Build failed. Fix the build error and retry.",
      "ui-build-failed": "The control UI rebuild failed. Fix the UI build error and retry.",
      "global-install-failed":
        "The global package install did not verify on disk. Retry or reinstall from the CLI.",
      "restart-disabled":
        "The update was not applied because gateway restarts are disabled. Enable restarts in config, then retry — or run `openclaw update` from the CLI.",
      "restart-unavailable":
        "This global install cannot be safely replaced while restarts are disabled and no supervisor is present.",
      "managed-service-handoff-unavailable": handoffUnavailableGuidance,
      "restart-unhealthy":
        "The replacement process never became healthy. The previous process stayed up so you can recover.",
      "doctor-failed": "Doctor repair failed. Run `openclaw doctor --non-interactive` and retry.",
    }[reason] ?? "See the gateway logs for the exact failure and retry once the cause is fixed.";
  return {
    tone,
    text: `Update ${status}: ${reason}. ${guidance}`,
  };
}

/**
 * Adopts a successful write ack as the authoritative local snapshot BEFORE
 * any reload: the submitted bytes are on disk under the acked hash, so the
 * raw/hash/originals must never keep describing the pre-save file (a failed
 * best-effort reload would otherwise leave stale-bytes paths alive — e.g.
 * apply re-submitting the old raw, or a revert-during-reload comparing
 * clean). Server-resolved values (secret redaction) still refresh via the
 * follow-up reload, which is purely cosmetic from here on.
 */
function adoptConfigSetAck(state: ConfigState, submittedRaw: string, ackHash: string | null) {
  const parsed = parseConfigRawDraft(submittedRaw);
  state.configSnapshot = {
    ...state.configSnapshot,
    raw: submittedRaw,
    hash: ackHash ?? state.configSnapshot?.hash ?? null,
    valid: true,
    issues: [],
    ...(parsed ? { config: parsed, sourceConfig: parsed } : {}),
  };
  state.configValid = true;
  state.configIssues = [];
  setConfigRawOriginal(state, submittedRaw);
  if (parsed) {
    state.configFormOriginal = cloneConfigObject(parsed);
  }
  state.configDraftBaseHash = ackHash;
  if (!state.configFormDirty) {
    // Clean drafts snap to the persisted bytes, mirroring what a reload's
    // non-preserving snapshot application would do.
    state.configRaw = submittedRaw;
    if (parsed) {
      state.configForm = cloneConfigObject(parsed);
    }
  }
}

// Legacy hashless ack: when the follow-up reload returns exactly the submitted
// bytes, rebase a preserved dirty draft onto that authoritative hash. Foreign
// content matches neither and stays fail-closed.
function reconcileHashlessWriteReload(state: ConfigState, submittedRaw: string) {
  if (state.configSnapshot?.raw !== submittedRaw) {
    return;
  }
  const hash = state.configSnapshot.hash ?? null;
  if (state.configFormDirty) {
    state.configDraftBaseHash = hash ?? state.configDraftBaseHash;
  }
}

async function submitConfigChange(
  state: ConfigState,
  method: ConfigSubmitMethod,
  busyKey: ConfigSubmitBusyKey,
  extraParams: Record<string, unknown> = {},
  onSubmitted?: (info: { raw: string; ackHash: string | null }) => void,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected) {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  // Claim busy before any await so a second click cannot slip past the busy
  // state while a JSON5 original parse settles; finally releases it.
  state[busyKey] = true;
  state.lastError = null;
  state.chatError = null;
  try {
    if (state.configRawOriginalParsePending) {
      // JSON5 originals parse asynchronously on first load; sanitize needs them.
      await state.configRawOriginalParsePending;
      if (!isCurrent()) {
        return false;
      }
    }
    const raw = serializeFormForSubmit(state);
    const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
    if (!baseHash) {
      state.lastError = "Config hash missing; reload and retry.";
      return false;
    }
    // Dispatch-phase report (ackHash null): if the connection dies before the
    // ack arrives, reconnect reconciliation still needs the submitted bytes
    // to recognize its own committed write. The post-ack report below
    // overwrites this with the real hash.
    onSubmitted?.({ raw, ackHash: null });
    const ack = await client.request(method, { raw, baseHash, ...extraParams });
    // The gateway acks writes with the persisted snapshot hash. Adopt it as
    // the new draft base; config.get remains the source of applied revision truth.
    const ackHash = readAckHash(ack);
    // Reported before the epoch check: dispose-chained teardown flushes need
    // this flight's own submission even though state mutation may be blocked.
    onSubmitted?.({ raw, ackHash });
    if (!isCurrent()) {
      return false;
    }
    // Same bytes-vs-submission rule as autosave: an edit made while this
    // manual write was in flight must stay dirty (its autosave deferred into
    // a trailing run), or adoption would snap the draft back to the older
    // submitted bytes and silently discard the newer edit.
    if (serializeFormForSubmit(state) === raw) {
      state.configFormDirty = false;
      autoAllowlistedPluginIdsByState.delete(state);
    } else {
      state.configFormDirty = true;
    }
    adoptConfigSetAck(state, raw, ackHash);
    if (method === "config.apply") {
      // Older gateways omit appliedConfigHash, so keep the former process-local
      // behavior. New gateways replace this optimistic value on config.get.
      state.configNeedsApply = false;
      state.configAutoSaveStatus = "idle";
    } else {
      state.configNeedsApply = true;
    }
    // Best-effort UI refresh; correctness no longer depends on it.
    await loadConfig(state);
    if (!isCurrent()) {
      return false;
    }
    if (!ackHash) {
      reconcileHashlessWriteReload(state, raw);
    }
    if (method === "config.set") {
      // "Saved" would lie next to a draft the user re-dirtied during the
      // reload; the rescheduled save reports its own completion.
      state.configAutoSaveStatus = state.configFormDirty ? "idle" : "saved";
    }
    return true;
  } catch (err) {
    if (isCurrent()) {
      state.lastError = String(err);
      if (isConfigBaseHashConflictError(err)) {
        // Applies conflict the same way saves do so the UI offers Reload.
        state.configAutoSaveStatus = "conflict";
      } else if (method === "config.set") {
        state.configAutoSaveStatus = "error";
      }
    }
    return false;
  } finally {
    if (isCurrent()) {
      state[busyKey] = false;
    }
  }
}

/**
 * Teardown flush after an in-flight save: submits the latest draft once,
 * based only on that flight's own in-memory ack hash. Callers skip the flush
 * entirely (fail closed) when no in-memory ack hash exists.
 */
function teardownFlushConfigDraft(
  state: ConfigState,
  client: GatewayBrowserClient,
  baseHash: string,
): void {
  // Must stay synchronous: page unload destroys the context before any
  // deferred work runs. If a JSON5 original parse is still pending, sanitize
  // passes placeholders through; the gateway restores restorable sentinels
  // (restoreRedactedValues) and rejects unrestorable ones, so the worst case
  // matches not flushing at all while the common case saves the draft.
  const raw = serializeFormForSubmit(state);
  void client.request("config.set", { raw, baseHash }).catch(() => undefined);
}

/**
 * Auto-save submission for debounced form edits. Unlike the manual
 * `submitConfigChange` path it never raises `configSaving` (editors must stay
 * interactive while typing) and it only clears the dirty flag when the draft
 * still matches the submitted bytes — edits made while the request was in
 * flight stay dirty so the trailing save picks them up.
 */
async function autoSaveConfig(
  state: ConfigState,
  onAck?: (ackHash: string | null) => void,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || !state.configFormDirty || state.configFormMode !== "form") {
    return false;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  if (state.configRawOriginalParsePending) {
    // JSON5 originals parse asynchronously on first load; sanitize needs them.
    // Await only when pending: teardown flushes rely on a synchronous prefix.
    // Entry stays serialized across this await: runAutoSave's synchronous
    // in-flight check folds concurrent triggers into one trailing save.
    await state.configRawOriginalParsePending;
    if (!isCurrent() || !state.configFormDirty || state.configFormMode !== "form") {
      return false;
    }
  }
  const submittedRaw = serializeFormForSubmit(state);
  const baseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash;
  if (!baseHash) {
    state.configAutoSaveStatus = "error";
    state.lastError = "Config hash missing; reload and retry.";
    return false;
  }
  state.configAutoSaveStatus = "saving";
  state.lastError = null;
  state.chatError = null;
  try {
    const ack = await client.request("config.set", { raw: submittedRaw, baseHash });
    // The gateway acks with the persisted snapshot hash. Applied revision
    // truth arrives on config.get.
    const ackHash = readAckHash(ack);
    // Reported before the epoch check: dispose-chained teardown flushes need
    // this flight's own ack even though state mutation below is blocked.
    onAck?.(ackHash);
    if (!isCurrent()) {
      return false;
    }
    state.configNeedsApply = true;
    // The submitted bytes are now the authoritative original: a draft that no
    // longer matches them (mid-flight edits, or a revert back to the pre-save
    // value) stays dirty so the trailing save runs. Computed before adoption
    // so the comparison sees the pre-save snapshot for reverted-clean drafts.
    const drained = serializeFormForSubmit(state) === submittedRaw;
    if (drained) {
      state.configFormDirty = false;
      autoAllowlistedPluginIdsByState.delete(state);
    } else {
      state.configFormDirty = true;
    }
    adoptConfigSetAck(state, submittedRaw, ackHash);
    if (!ackHash) {
      // Only a hashless ack needs a reload to re-derive the snapshot. With a
      // hash the adopted snapshot IS authoritative, and reloading here would
      // flash configLoading and lock the editors between keystrokes.
      await loadConfig(state);
      if (!isCurrent()) {
        return false;
      }
      reconcileHashlessWriteReload(state, submittedRaw);
    }
    // "Saved" would lie next to a still-dirty draft (edits during the
    // request or reload); the trailing save reports its own completion.
    state.configAutoSaveStatus = state.configFormDirty ? "idle" : "saved";
    return true;
  } catch (err) {
    if (isCurrent()) {
      state.lastError = String(err);
      state.configAutoSaveStatus = isConfigBaseHashConflictError(err) ? "conflict" : "error";
    }
    return false;
  }
}

function syncConfigDraft(state: ConfigState, nextForm: Record<string, unknown>) {
  const original = cloneConfigObject(
    state.configFormOriginal ?? resolveEditableSnapshotConfig(state.configSnapshot) ?? {},
  );
  const nextRaw = serializeConfigForm(nextForm);
  const originalRaw = serializeConfigForm(original);
  state.configForm = nextForm;
  state.configRaw = nextRaw;
  state.configFormDirty = nextRaw !== originalRaw;
  // configFormMode tracks which draft is authoritative for submission; a form
  // edit supersedes any earlier raw-text draft.
  state.configFormMode = "form";
  resetStaleAutoSaveStatus(state);
}

/**
 * Any mutation invalidates a lingering "Saved"/"Save failed" indicator: a
 * dirty edit is about to reschedule, and a clean revert makes the old
 * failure moot (its error is cleared too). Two states persist regardless:
 * "saving" reports the in-flight request, and "conflict" marks the snapshot
 * itself stale — only a reload clears it, no local edit can.
 */
function resetStaleAutoSaveStatus(state: ConfigState) {
  if (state.configAutoSaveStatus === "saving" || state.configAutoSaveStatus === "conflict") {
    return;
  }
  if (!state.configFormDirty && state.configAutoSaveStatus === "error") {
    state.lastError = null;
  }
  state.configAutoSaveStatus = "idle";
}

export async function saveConfig(
  state: ConfigState,
  onSubmitted?: (info: { raw: string; ackHash: string | null }) => void,
): Promise<boolean> {
  return submitConfigChange(state, "config.set", "configSaving", {}, onSubmitted);
}

export async function applyConfig(state: ConfigState): Promise<boolean> {
  return submitConfigChange(state, "config.apply", "configApplying", {
    sessionKey: state.applySessionKey,
  });
}

export async function runUpdate(state: ConfigState) {
  if (!state.client || !state.connected) {
    return;
  }
  state.updateRunning = true;
  state.lastError = null;
  state.chatError = null;
  state.updateStatusBanner = null;
  try {
    const res = await state.client.request<{
      ok?: boolean;
      result?: { status?: string; reason?: string; after?: { version?: string | null } };
      handoff?: { status?: string; command?: string; message?: string };
    }>("update.run", {
      sessionKey: state.applySessionKey,
    });
    const status = res.result?.status ?? (res.ok === true ? "ok" : "error");
    const handoffStarted =
      res.ok === true &&
      status === "skipped" &&
      res.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
      res.handoff?.status === "started";
    if (handoffStarted) {
      state.pendingUpdateExpectedVersion = res.result?.after?.version ?? null;
      state.pendingUpdateHandoff = true;
      return;
    }
    if (status === "ok" && res.ok === true) {
      state.pendingUpdateExpectedVersion = res.result?.after?.version ?? null;
      state.pendingUpdateHandoff = false;
      return;
    }
    state.pendingUpdateExpectedVersion = null;
    state.pendingUpdateHandoff = false;
    state.updateStatusBanner = resolveUpdateStatusBanner({
      status,
      reason: res.result?.reason,
      handoff: res.handoff,
    });
  } catch (err) {
    state.lastError = String(err);
    state.pendingUpdateExpectedVersion = null;
    state.pendingUpdateHandoff = false;
  } finally {
    state.updateRunning = false;
  }
}
function parseConfigRawDraft(raw: string): Record<string, unknown> | null {
  try {
    const parsed = parseJson5Text(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Parse the authoritative raw once at ingestion so submit-time sanitizing
// stays synchronous and never races the lazy JSON5 parser. Submit paths await
// configRawOriginalParsePending so a JSON5 config racing the first parser load
// cannot bypass redaction sanitizing.
function setConfigRawOriginal(state: ConfigState, raw: string) {
  state.configRawOriginal = raw;
  state.configRawOriginalParsePending = null;
  try {
    state.configRawOriginalParsed = asConfigRecord(parseJson5Text(raw));
    return;
  } catch {
    state.configRawOriginalParsed = null;
  }
  const pending = warmJson5()
    .then((json5) => {
      if (state.configRawOriginal !== raw || state.configRawOriginalParsePending !== pending) {
        return;
      }
      try {
        state.configRawOriginalParsed = asConfigRecord(json5.parse(raw));
      } catch {
        state.configRawOriginalParsed = null;
      }
    })
    // Never-rejecting and self-clearing: submit gates await this promise, and
    // a failed chunk load must not wedge every later save of this state.
    .catch(() => undefined)
    .finally(() => {
      if (state.configRawOriginalParsePending === pending) {
        state.configRawOriginalParsePending = null;
      }
    });
  state.configRawOriginalParsePending = pending;
}

function mutateConfigForm(state: ConfigState, mutate: (draft: Record<string, unknown>) => void) {
  let base: Record<string, unknown>;
  if (state.configFormDirty && state.configFormMode === "raw") {
    // A dirty raw draft is authoritative. Form patches (Quick Settings shares
    // this capability) may only apply on top of its parsed content — building
    // on the stale parsed form would silently destroy the raw edits.
    // Contract: merging onto the parsed raw draft is intentional — content is
    // preserved, but the unsaved raw draft's formatting/comments are not once
    // form editing resumes.
    const parsedRawDraft = parseConfigRawDraft(state.configRaw);
    if (!parsedRawDraft) {
      // Unparseable raw draft: refuse the form edit and tell the user to
      // resolve the raw buffer first; the raw draft stays authoritative.
      state.configAutoSaveStatus = "error";
      state.lastError = t("configView.rawDraftBlocksFormEdit");
      return;
    }
    base = parsedRawDraft;
  } else {
    base = cloneConfigObject(
      state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot) ?? {},
    );
  }
  mutate(base);
  syncConfigDraft(state, base);
}

function trackAutoAllowlistedPluginId(state: ConfigState, pluginId: string) {
  const pluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (pluginIds) {
    pluginIds.add(pluginId);
  } else {
    autoAllowlistedPluginIdsByState.set(state, new Set([pluginId]));
  }
}

function untrackAutoAllowlistedPluginId(state: ConfigState, pluginId: string) {
  const pluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (!pluginIds) {
    return;
  }
  pluginIds.delete(pluginId);
  if (pluginIds.size === 0) {
    autoAllowlistedPluginIdsByState.delete(state);
  }
}

function syncEnabledPluginAllowlist(
  state: ConfigState,
  draft: Record<string, unknown>,
  path: Array<string | number>,
  value: unknown,
) {
  if (
    path.length !== 4 ||
    path[0] !== "plugins" ||
    path[1] !== "entries" ||
    typeof path[2] !== "string" ||
    path[3] !== "enabled"
  ) {
    return;
  }
  const pluginId = path[2];
  const plugins =
    draft.plugins && typeof draft.plugins === "object" && !Array.isArray(draft.plugins)
      ? (draft.plugins as Record<string, unknown>)
      : null;
  const allow = Array.isArray(plugins?.allow) ? plugins.allow : null;
  if (!allow) {
    untrackAutoAllowlistedPluginId(state, pluginId);
    return;
  }
  if (value === true) {
    if (allow.includes(pluginId)) {
      return;
    }
    if (allow.length === 0) {
      untrackAutoAllowlistedPluginId(state, pluginId);
      return;
    }
    setPathValue(draft, ["plugins", "allow"], [...allow, pluginId]);
    trackAutoAllowlistedPluginId(state, pluginId);
    return;
  }
  const autoAllowlistedPluginIds = autoAllowlistedPluginIdsByState.get(state);
  if (!autoAllowlistedPluginIds?.has(pluginId)) {
    return;
  }
  setPathValue(
    draft,
    ["plugins", "allow"],
    allow.filter((entry) => entry !== pluginId),
  );
  untrackAutoAllowlistedPluginId(state, pluginId);
}

export function updateConfigFormValue(
  state: ConfigState,
  path: Array<string | number>,
  value: unknown,
) {
  mutateConfigForm(state, (draft) => {
    setPathValue(draft, path, value);
    if (path[0] === "plugins" && path[1] === "allow") {
      autoAllowlistedPluginIdsByState.delete(state);
      return;
    }
    syncEnabledPluginAllowlist(state, draft, path, value);
  });
}

export function updateConfigRawValue(state: ConfigState, value: string) {
  // Raw drafts may carry JSON5 comments; warm the parser before any
  // mutateConfigForm/diff path needs it synchronously.
  void warmJson5().catch(() => undefined);
  state.configRaw = value;
  // A raw-text edit becomes the authoritative draft; without this,
  // serializeFormForSubmit would submit the stale form and drop raw edits.
  state.configFormMode = "raw";
  state.configFormDirty = value !== state.configRawOriginal;
  resetStaleAutoSaveStatus(state);
  if (state.configFormDirty) {
    state.configDraftBaseHash = state.configDraftBaseHash ?? state.configSnapshot?.hash ?? null;
  } else {
    state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  }
}

export function stageConfigPreset(state: ConfigState, patch: Record<string, unknown>) {
  const snapshotConfig = resolveEditableSnapshotConfig(state.configSnapshot);
  const baseSource = state.configForm ?? snapshotConfig;
  if (!baseSource || (!state.configForm && !state.configSnapshot?.hash)) {
    return;
  }
  const base = cloneConfigObject(baseSource);
  const merged = applyMergePatch(base, patch);
  if (!merged || typeof merged !== "object" || Array.isArray(merged)) {
    return;
  }
  syncConfigDraft(state, cloneConfigObject(merged as Record<string, unknown>));
}

export function resetConfigPendingChanges(state: ConfigState) {
  const editableConfig = resolveEditableSnapshotConfig(state.configSnapshot);
  state.configForm = cloneConfigObject(state.configFormOriginal ?? editableConfig ?? {});
  state.configRaw =
    state.configRawOriginal ??
    serializeConfigForm(state.configFormOriginal ?? editableConfig ?? {});
  state.configFormDirty = false;
  state.configFormMode = "form";
  state.configDraftBaseHash = state.configSnapshot?.hash ?? null;
  autoAllowlistedPluginIdsByState.delete(state);
}

export function removeConfigFormValue(state: ConfigState, path: Array<string | number>) {
  mutateConfigForm(state, (draft) => removePathValue(draft, path));
}

export function updateMcpServerEnabled(state: ConfigState, name: string, enabled: boolean) {
  mutateConfigForm(state, (draft) => {
    const serverPath = ["mcp", "servers", name];
    if (!enabled) {
      setPathValue(draft, [...serverPath, "enabled"], false);
      return;
    }

    removePathValue(draft, [...serverPath, "enabled"]);
    const mcp = asConfigRecord(draft.mcp);
    const servers = asConfigRecord(mcp?.servers);
    const server = asConfigRecord(servers?.[name]);
    if (server && Object.keys(server).length === 0) {
      removePathValue(draft, serverPath);
    }
  });
}

export function findAgentConfigEntryIndex(
  config: Record<string, unknown> | null,
  agentId: string,
): number {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return -1;
  }
  const list = (config as { agents?: { list?: unknown[] } } | null)?.agents?.list;
  if (!Array.isArray(list)) {
    return -1;
  }
  return list.findIndex(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      "id" in entry &&
      (entry as { id?: string }).id === normalizedAgentId,
  );
}

export function ensureAgentConfigEntry(state: ConfigState, agentId: string): number {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return -1;
  }
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const existingIndex = findAgentConfigEntryIndex(source, normalizedAgentId);
  if (existingIndex >= 0) {
    return existingIndex;
  }
  const list = (source as { agents?: { list?: unknown[] } } | null)?.agents?.list;
  const nextIndex = Array.isArray(list) ? list.length : 0;
  updateConfigFormValue(state, ["agents", "list", nextIndex, "id"], normalizedAgentId);
  return nextIndex;
}

export function stageDefaultAgentConfigEntry(state: ConfigState, agentId: string): boolean {
  const normalizedAgentId = agentId.trim();
  if (!normalizedAgentId) {
    return false;
  }
  const source = state.configForm ?? resolveEditableSnapshotConfig(state.configSnapshot);
  const targetIndex = findAgentConfigEntryIndex(source, normalizedAgentId);
  if (targetIndex < 0) {
    return false;
  }
  mutateConfigForm(state, (draft) => {
    const list = (draft as { agents?: { list?: unknown[] } } | null)?.agents?.list;
    if (!Array.isArray(list)) {
      return;
    }
    for (let i = 0; i < list.length; i++) {
      const entry = list[i];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (i === targetIndex) {
        record.default = true;
      } else {
        delete record.default;
      }
    }
  });
  return true;
}

export async function openConfigFile(state: ConfigState): Promise<void> {
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  const connectionEpoch = currentConfigConnectionEpoch(state);
  const isCurrent = () => isCurrentConfigConnection(state, client, connectionEpoch);
  state.lastError = null;
  state.chatError = null;
  try {
    const res = await client.request<{ ok: boolean; path?: string; error?: string }>(
      "config.openFile",
      {},
    );
    if (!isCurrent()) {
      return;
    }
    if (!res.ok) {
      let errorMessage = res.error || "Failed to open config file";
      const path = res.path || state.configSnapshot?.path;
      if (path) {
        if (await copyToClipboard(path)) {
          errorMessage += `\n\nFile path copied to clipboard: ${path}`;
        } else {
          errorMessage += `\n\nFile path: ${path}`;
        }
      }
      if (isCurrent()) {
        state.lastError = errorMessage;
      }
    }
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    const errorMessage = String(err);
    const path = state.configSnapshot?.path;
    if (path) {
      await copyToClipboard(path);
    }
    if (isCurrent()) {
      state.lastError = errorMessage;
    }
  }
}
