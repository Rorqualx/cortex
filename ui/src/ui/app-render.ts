import { normalizeFastMode } from "@openclaw/normalization-core/string-coerce";
import { html, nothing } from "lit";
import { guard } from "lit/directives/guard.js";
import { styleMap } from "lit/directives/style-map.js";
import { i18n, t } from "../i18n/index.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  confirmDestructiveSessionReset,
  createChatSessionsLoadOverrides,
  hasAbortableSessionRun,
  refreshChat,
  scopedAgentListParamsForSession,
  scopedAgentParamsForSession,
} from "./app-chat.ts";
import { DEFAULT_CRON_FORM } from "./app-defaults.ts";
import { renderUsageTab } from "./app-render-usage-tab.ts";
import {
  collectChannelChatNavCandidates,
  renderChatControls,
  renderTab,
  resolveAssistantAttachmentAuthToken,
  resolveDashboardHeaderContext,
  renderSidebarConnectionStatus,
  renderTopbarThemeModeToggle,
  createChatSession,
  dismissChatError,
  switchChatSession,
} from "./app-render.helpers.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess, warnQueryToken } from "./app-settings.ts";
import type { AppViewState } from "./app-view-state.ts";
import { agentAvatarUrl } from "./avatar/agent-avatar.ts";
import { resolveChatModelSelectState } from "./chat-model-select-state.ts";
import {
  renderChatTabBar,
  renderCollapsedChatTab,
  savePersistedTabs,
} from "./chat/chat-tab-bar.ts";
import { reconcileChatRunLifecycle } from "./chat/run-lifecycle.ts";
import {
  renderChatSessionSelect,
  renderSidebarAgentSelect,
  renderSidebarModelSelect,
  resolveChatAgentFilterId,
  resolveDreamingAgentOptions,
  resolvePreferredSessionForAgent,
  resolvePreferredSessionForAgentSurface,
  switchChatModel,
} from "./chat/session-controls.ts";
import {
  controlUiNowMs,
  recordControlUiRenderTiming,
  roundedControlUiDurationMs,
} from "./control-ui-performance.ts";
import { loadActivity, loadMoreActivity } from "./controllers/activity.ts";
import type { ActivityControllerHost } from "./controllers/activity.ts";
import { refreshAgentAvatarCards } from "./controllers/agent-avatars.ts";
import { loadAgentFileContent, loadAgentFiles, saveAgentFile } from "./controllers/agent-files.ts";
import { loadAgentIdentities, loadAgentIdentity } from "./controllers/agent-identity.ts";
import { loadAgentSkills } from "./controllers/agent-skills.ts";
import {
  buildToolsEffectiveRequestKey,
  loadAgents,
  loadToolsCatalog,
  loadToolsEffective,
  resetToolsEffectiveState,
  refreshVisibleToolsEffectiveForCurrentSession,
  saveAgentsConfig,
} from "./controllers/agents.ts";
import { setAssistantAvatarOverride } from "./controllers/assistant-identity.ts";
import { loadChannels } from "./controllers/channels.ts";
import {
  handleBranchNavigate,
  loadBranches,
  loadChatHistory,
  loadEarlierMessages,
  editResendRunId,
  sendChatMessage,
} from "./controllers/chat.ts";
import {
  applyConfig,
  ensureAgentConfigEntry,
  findAgentConfigEntryIndex,
  generateAndSaveGatewayToken,
  loadConfig,
  openConfigFile,
  resetConfigPendingChanges,
  runUpdate,
  saveConfig,
  stageDefaultAgentConfigEntry,
  stageConfigPreset,
  updateConfigRawValue,
  updateConfigFormValue,
  removeConfigFormValue,
  updateMcpServerEnabled,
} from "./controllers/config.ts";
import {
  loadCronJobsPage,
  loadCronRuns,
  loadMoreCronRuns,
  toggleCronJob,
  runCronJob,
  removeCronJob,
  addCronJob,
  startCronEdit,
  startCronClone,
  cancelCronEdit,
  validateCronForm,
  hasCronFormErrors,
  normalizeCronFormState,
  getVisibleCronJobs,
  updateCronJobsFilter,
  updateCronRunsFilter,
} from "./controllers/cron.ts";
import { loadDebug, callDebugMethod } from "./controllers/debug.ts";
import {
  approveDevicePairing,
  loadDevices,
  rejectDevicePairing,
  removeOtherPairedDevices,
  removePairedDeviceEntry,
  revokeDeviceToken,
  rotateDeviceToken,
} from "./controllers/devices.ts";
import {
  backfillDreamDiary,
  copyDreamingArchivePath,
  dedupeDreamDiary,
  ALL_AGENTS_ID,
  loadDreamDiary,
  loadDreamingStatus,
  loadL3LayerContent,
  loadL3LayerList,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
  repairDreamingArtifacts,
  resetGroundedShortTerm,
  resetDreamDiary,
  resolveConfiguredDreaming,
  updateDreamingEnabled,
} from "./controllers/dreaming.ts";
import {
  loadExecApprovals,
  removeExecApprovalsFormValue,
  saveExecApprovals,
  updateExecApprovalsFormValue,
} from "./controllers/exec-approvals.ts";
import { loadLogs } from "./controllers/logs.ts";
import {
  createModelProvidersState,
  loadModelProviders,
  probeProvider,
  saveProviderApiKey,
} from "./controllers/model-providers.ts";
import { loadNodes } from "./controllers/nodes.ts";
import { loadPresence } from "./controllers/presence.ts";
import {
  branchSessionFromCheckpoint,
  deleteSessionsAndRefresh,
  loadSessions,
  parseSessionsFilterInteger,
  patchSession,
  restoreSessionFromCheckpoint,
  toggleSessionCompactionCheckpoints,
} from "./controllers/sessions.ts";
import {
  runForgePipeline,
  promoteSkill,
  retireSkill,
  runDecaySweep,
  selectSkillForge,
  setSkillForgeMode,
  loadSkillForgeMode as loadSkillForgeModeController,
} from "./controllers/skill-forge.ts";
import {
  closeClawHubDetail,
  installFromClawHub,
  loadSkillCard,
  installSkill,
  loadClawHubDetail,
  loadSkills,
  reconcileSkillsAgentId,
  saveSkillApiKey,
  searchClawHub,
  setClawHubSearchQuery,
  setSkillsAgentId,
  updateSkillEdit,
  updateSkillEnabled,
} from "./controllers/skills.ts";
import { captureSessionToWorkboard, getWorkboardState } from "./controllers/workboard.ts";
import { getCronJobPayload } from "./cron-payload.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "./external-link.ts";
import { formatTimeMs } from "./format.ts";
import { icons } from "./icons.ts";
import { createLazyView, renderLazyView } from "./lazy-view.ts";
import {
  iconForTab,
  isSettingsTab,
  normalizeBasePath,
  pathForTab,
  SETTINGS_TABS,
  TAB_GROUPS,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "./navigation.ts";
import { resolveAgentArgPath } from "./path-arg.ts";
import { isPluginEnabledInConfigSnapshot } from "./plugin-activation.ts";
import { resolveSessionDisplayName } from "./session-display.ts";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "./session-key.ts";
import "./components/dashboard-header.ts";
import type { PendingEdit } from "./sidebar-content.ts";
import {
  getLocalAgentAvatarOverride,
  loadLocalAssistantIdentity,
  setLocalAgentAvatarOverride,
} from "./storage.ts";
import { normalizeStringEntries } from "./string-coerce.ts";
import { normalizeOptionalString } from "./string-coerce.ts";
import type {
  AgentsFilesGetResult,
  AgentsFilesListResult,
  AgentFileEntry,
  CronJob,
  FastMode,
} from "./types.ts";
import { isRenderableControlUiAvatarUrl } from "./views/agents-utils.ts";
import {
  resolveAgentConfig,
  resolveConfiguredCronModelSuggestions,
  resolveEffectiveModelFallbacks,
  resolveModelPrimary,
  sortLocaleStrings,
} from "./views/agents-utils.ts";
import { renderChat, resolveActiveFileFromMessages } from "./views/chat.ts";
import { renderCommandPalette } from "./views/command-palette.ts";
import { getPresetById } from "./views/config-presets.ts";
import {
  renderQuickSettings,
  type QuickSettingsAgentCard,
  type QuickSettingsChannel,
} from "./views/config-quick.ts";
import { renderConfig, type ConfigProps } from "./views/config.ts";
import {
  renderCronQuickCreate,
  createDefaultDraft,
  draftToCronFormPatch,
} from "./views/cron-quick-create.ts";
import { renderDreamingRestartConfirmation } from "./views/dreaming-restart-confirmation.ts";
import { renderDreaming, type DreamingAgentOption } from "./views/dreaming.ts";
import { renderGatewayUrlConfirmation } from "./views/gateway-url-confirmation.ts";
import { renderLoginGate } from "./views/login-gate.ts";
// Self-registering <openclaw-exec-approval> element (upstream modal-queue shape).
import "./views/exec-approval.ts";
import { renderMcp } from "./views/mcp.ts";
import { renderModelProvidersTab } from "./views/model-providers-tab.ts";
import { renderOverview } from "./views/overview.ts";
import { createPanelRefreshStatus, failPanelRefresh } from "./views/panel-refresh-status.ts";
import { renderPixelAgentsStrip } from "./views/pixel-office.ts";
import { renderRsil } from "./views/rsil.ts";

let pendingUpdate: (() => void) | undefined;
let thinkingTickInterval: ReturnType<typeof setInterval> | undefined;

const notifyLazyViewChanged = () => pendingUpdate?.();

function runUiTask<Args extends unknown[]>(
  task: (...args: Args) => Promise<unknown>,
): (...args: Args) => void {
  return (...args) => {
    void task(...args);
  };
}

export function loadSkillForgeMode(): "board" | "grid" {
  return loadSkillForgeModeController();
}

function setSkillForgeModeLocal(state: AppViewState, mode: "board" | "grid"): void {
  setSkillForgeMode(state, mode);
}

function renderSettingsSectionNav(state: AppViewState) {
  if (!isSettingsTab(state.tab)) {
    return nothing;
  }
  return html`
    <nav class="settings-section-nav" aria-label=${t("common.settingsSections")}>
      ${SETTINGS_TABS.map((tab) => {
        const active = state.tab === tab;
        const href = pathForTab(tab, state.basePath);
        return html`
          <a
            href=${href}
            class="settings-section-nav__item ${active ? "settings-section-nav__item--active" : ""}"
            @click=${(event: MouseEvent) => {
              if (
                event.defaultPrevented ||
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              state.setTab(tab);
            }}
            title=${titleForTab(tab)}
          >
            <span class="settings-section-nav__icon" aria-hidden="true"
              >${icons[iconForTab(tab)]}</span
            >
            <span class="settings-section-nav__label">${titleForTab(tab)}</span>
          </a>
        `;
      })}
    </nav>
  `;
}

function renderSettingsWorkspace(state: AppViewState, body: unknown) {
  return html`
    <section class="settings-workspace">
      ${renderSettingsSectionNav(state)}
      <div class="settings-workspace__body">${body}</div>
    </section>
  `;
}

// Known agent channel surfaces mapped to nav label/icon.
// Discovered dynamically from cached sessions (e.g., kimi-claw → agent:<id>:main).
const AGENT_CHANNEL_SURFACE_META: Record<string, { label: string; icon: unknown }> = {
  "kimi-claw": { label: "Kimi", icon: icons.brain },
};

// Cap conversations shown under the CHANNELS nav group; the full list lives in
// the Conversations view. Newest chats win so the nav stays scannable.
const MAX_CHANNEL_CHAT_NAV_ITEMS = 12;

function resolveChannelsNavItems(
  state: AppViewState,
): Array<{ key: string; label: string; icon: unknown }> {
  const configuredChannels = state.channelsSnapshot?.channels ?? {};
  const channelLabels = state.channelsSnapshot?.channelLabels ?? {};
  const channelMeta = new Map(
    (state.channelsSnapshot?.channelMeta ?? []).map((m) => [m.id.toLowerCase(), m]),
  );
  const channelOrder = state.channelsSnapshot?.channelOrder ?? [];
  // Search across ALL cached agent sessions, not just the current scope
  const allCachedSessions = [
    ...(state.sessionsResult?.sessions ?? []),
    ...Object.values(state.chatAgentSessionRowsByAgent ?? {}).flat(),
  ];

  // Discover agent channel surfaces from cached sessions (e.g., kimi-claw).
  // Prefer non-default agents so plugin-created channels map to their
  // dedicated agent instead of the default one.
  const defaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const surfaceToAgents = new Map<string, Set<string>>();
  for (const row of allCachedSessions) {
    const parsed = parseAgentSessionKey(row.key);
    if (!parsed) {
      continue;
    }
    const surface = parsed.rest.split(":")[0]?.toLowerCase();
    if (!surface || !AGENT_CHANNEL_SURFACE_META[surface]) {
      continue;
    }
    const agents = surfaceToAgents.get(surface) ?? new Set<string>();
    agents.add(parsed.agentId);
    surfaceToAgents.set(surface, agents);
  }

  const agentSurfaceAgents = new Map<string, string>();
  for (const [surface, agentIds] of surfaceToAgents) {
    const agentsArray = [...agentIds];
    const nonDefault = agentsArray.filter((id) => normalizeAgentId(id) !== defaultAgentId);
    let chosen: string | undefined;
    if (nonDefault.length === 1) {
      chosen = nonDefault[0];
    } else if (nonDefault.length > 1) {
      // Multiple non-default agents — pick the one whose name matches the surface label
      const surfaceLabel = AGENT_CHANNEL_SURFACE_META[surface]?.label?.toLowerCase();
      const match = surfaceLabel
        ? nonDefault.find((id) => {
            const agent = state.agentsList?.agents.find((a) => a.id === id);
            const name = (agent?.identity?.name ?? agent?.name ?? "").toLowerCase();
            return name.includes(surfaceLabel);
          })
        : undefined;
      chosen = match ?? nonDefault[0];
    } else {
      chosen = agentsArray[0];
    }
    if (chosen !== undefined) {
      agentSurfaceAgents.set(surface, chosen);
    }
  }

  // Channel ids the gateway knows about, EXCLUDING agent surfaces (those keep
  // their own pinned row), used to recognize which cached sessions are real
  // channel conversations.
  const knownChannelIds = new Set<string>();
  for (const id of channelOrder) {
    knownChannelIds.add(id.toLowerCase());
  }
  for (const id of channelMeta.keys()) {
    knownChannelIds.add(id);
  }
  for (const id of Object.keys(configuredChannels)) {
    knownChannelIds.add(id.toLowerCase());
  }
  for (const surface of agentSurfaceAgents.keys()) {
    knownChannelIds.delete(surface);
  }

  // Nothing configured -> nothing to show (the nav renders "No channels
  // connected"); don't surface stray sessions for cataloged-but-unconfigured channels.
  if (Object.keys(configuredChannels).length === 0 && agentSurfaceAgents.size === 0) {
    return [];
  }

  // Per-chat candidates, newest first. The cap is global, so only the survivors
  // count as "represented by a chat row"; a configured channel whose chats all
  // fall past the cap still gets its channel-type row below, never vanishing.
  const candidates = collectChannelChatNavCandidates(allCachedSessions, knownChannelIds);
  const survivingChats = candidates.slice(0, MAX_CHANNEL_CHAT_NAV_ITEMS);
  const channelsWithSurvivingChat = new Set(survivingChats.map((candidate) => candidate.channelId));
  // Newest known chat per channel, reused as the click target for a channel-type
  // row whose chats all fall past the cap.
  const newestChatKeyByChannel = new Map<string, string>();
  for (const candidate of candidates) {
    if (!newestChatKeyByChannel.has(candidate.channelId)) {
      newestChatKeyByChannel.set(candidate.channelId, candidate.key);
    }
  }

  // Channel-type / agent-surface rows, in server order. A channel-type row is the
  // fallback for a configured channel with no surviving chat row, so every
  // configured channel stays reachable.
  const ids = new Set<string>();
  for (const id of Object.keys(configuredChannels)) {
    ids.add(id.toLowerCase());
  }
  for (const surface of agentSurfaceAgents.keys()) {
    ids.add(surface);
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of channelOrder) {
    const lower = id.toLowerCase();
    if (ids.has(lower) && !seen.has(lower)) {
      ordered.push(id);
      seen.add(lower);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }

  const typeItems: Array<{ key: string; label: string; icon: unknown }> = [];
  for (const channelId of ordered) {
    const id = channelId.toLowerCase();
    const agentId = agentSurfaceAgents.get(id);
    const surfaceMeta = AGENT_CHANNEL_SURFACE_META[id];

    if (agentId && surfaceMeta) {
      typeItems.push({
        key: resolvePreferredSessionForAgentSurface(state, agentId, id),
        label: surfaceMeta.label,
        icon: surfaceMeta.icon,
      });
      continue;
    }

    if (channelsWithSurvivingChat.has(id)) {
      continue;
    }

    const label = channelMeta.get(id)?.label ?? channelLabels[id] ?? channelId;
    typeItems.push({
      key:
        newestChatKeyByChannel.get(id) ??
        buildAgentMainSessionKey({ agentId: resolveSidebarDefaultAgentId(state) }),
      label,
      icon: icons.messageSquare,
    });
  }

  // Idle/capped channel-type + agent-surface rows first (stable ordering), then
  // the newest conversations. Labels are resolved only for surviving chats.
  const chatItems = survivingChats.map((candidate) => ({
    key: candidate.key,
    label: resolveSessionDisplayName(candidate.key, candidate.row),
    icon: icons.messageSquare,
  }));

  return [...typeItems, ...chatItems].filter((r) => r.key);
}

function renderChannelsNavItems(state: AppViewState, collapsed: boolean) {
  const channels = resolveChannelsNavItems(state);
  if (channels.length === 0 && !collapsed) {
    return html`<div class="nav-item nav-item--muted">No channels connected</div>`;
  }
  return channels.map(
    (ch) => html`
      <button
        type="button"
        class="nav-item ${state.tab === "chat" && state.sessionKey === ch.key
          ? "nav-item--active"
          : ""}"
        title=${ch.label}
        @click=${() => {
          if (ch.key !== state.sessionKey) {
            switchChatSession(state, ch.key);
          }
          state.setTab("chat");
        }}
      >
        <span class="nav-item__icon" aria-hidden="true">${ch.icon}</span>
        ${!collapsed ? html`<span class="nav-item__text">${ch.label}</span>` : nothing}
      </button>
    `,
  );
}

function resolveSidebarDefaultAgentId(state: AppViewState): string {
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { defaultAgentId?: string } }
    | undefined;
  return normalizeAgentId(
    state.agentsList?.defaultId ?? snapshot?.sessionDefaults?.defaultAgentId ?? "main",
  );
}

function resolveMainSessionKeyForState(state: AppViewState): string {
  // Mirrors the gateway's resolveMainSessionKey guard: the default agent's
  // main session cannot be deleted, so views hide destructive actions for it.
  const snapshot = state.hello?.snapshot as
    | { sessionDefaults?: { mainSessionKey?: string; mainKey?: string } }
    | undefined;
  return (
    normalizeOptionalString(state.agentsList?.mainKey) ??
    normalizeOptionalString(snapshot?.sessionDefaults?.mainSessionKey) ??
    normalizeOptionalString(snapshot?.sessionDefaults?.mainKey) ??
    `agent:${resolveSidebarDefaultAgentId(state)}:main`
  );
}

function renderSidebarSessions(state: AppViewState) {
  const collapsed = state.settings.navCollapsed;
  // A new session no longer waits on the active run: switching preserves the
  // running session's runtime, so it keeps going in the background. Only the
  // brief send-RPC window blocks (its ack writes foreground). Gate on
  // chatSendsInFlight, not chatSending, which stays true for the whole run.
  const sendRpcInFlight = (state.chatSendsInFlight ?? 0) > 0;
  const newSessionDisabled = !state.connected || !state.client || sendRpcInFlight;
  const newSessionTitle = !state.connected
    ? "Connect to create a new session"
    : sendRpcInFlight
      ? "Sending…"
      : "New session";

  return html`
    <section class="sidebar-sessions ${collapsed ? "sidebar-sessions--collapsed" : ""}">
      <button
        type="button"
        class="sidebar-new-session"
        title=${newSessionTitle}
        aria-label=${t("chat.runControls.newSession")}
        ?disabled=${newSessionDisabled}
        @click=${async () => {
          if (newSessionDisabled) {
            return;
          }
          if (await createChatSession(state)) {
            state.setTab("chat" as import("./navigation.ts").Tab);
          }
        }}
      >
        <span class="sidebar-new-session__icon" aria-hidden="true">${icons.plus}</span>
        ${collapsed
          ? nothing
          : html`<span class="sidebar-new-session__label"
              >${t("chat.runControls.newSession")}</span
            >`}
      </button>
      ${collapsed
        ? nothing
        : html`
            <div class="sidebar-agent-controls">
              ${renderSidebarAgentSelect(state)} ${renderSidebarModelSelect(state)}
            </div>
          `}
    </section>
  `;
}

function renderSidebarChatNavControls(state: AppViewState) {
  const collapsed = state.settings.navCollapsed;
  // Single conversation navigator: the session-switcher dropdown already
  // searches and paginates every thread, so no separate recent list is shown.
  // It doubles as the Chat nav entry, so carry the active-tab accent styling.
  const active = state.tab === "chat";
  return html`
    <div class="sidebar-chat-nav-controls">
      <div
        class="sidebar-session-select ${collapsed
          ? "sidebar-session-select--collapsed"
          : ""} ${active ? "sidebar-session-select--active" : ""}"
      >
        ${renderChatSessionSelect(state, switchChatSession, {
          compact: collapsed,
          sessionSwitcherOnly: true,
          surface: "sidebar",
        })}
      </div>
    </div>
  `;
}

// Lazy-loaded view modules are deferred so the initial bundle stays small.
// The shared loader renders visible fallback states instead of leaving a tab blank.
const lazyAgents = createLazyView(() => import("./views/agents.ts"), notifyLazyViewChanged);
const lazyActivity = createLazyView(() => import("./views/activity.ts"), notifyLazyViewChanged);
const lazyChannels = createLazyView(() => import("./views/channels.ts"), notifyLazyViewChanged);
const lazyConversations = createLazyView(
  () => import("./views/conversations.ts"),
  notifyLazyViewChanged,
);
const lazyCron = createLazyView(() => import("./views/cron.ts"), notifyLazyViewChanged);
const lazyVault = createLazyView(() => import("./views/vault-view.ts"), notifyLazyViewChanged);
const lazyVaultAddModal = createLazyView(
  () => import("./components/vault-add-modal.ts"),
  notifyLazyViewChanged,
);
const lazyDebug = createLazyView(() => import("./views/debug.ts"), notifyLazyViewChanged);
const lazyInstances = createLazyView(() => import("./views/instances.ts"), notifyLazyViewChanged);
const lazyLogs = createLazyView(() => import("./views/logs.ts"), notifyLazyViewChanged);
const lazyNodes = createLazyView(() => import("./views/nodes.ts"), notifyLazyViewChanged);
const lazySessions = createLazyView(() => import("./views/sessions.ts"), notifyLazyViewChanged);
const lazySkillForge = createLazyView(
  () => import("./views/skill-forge.ts"),
  notifyLazyViewChanged,
);
const lazySkills = createLazyView(() => import("./views/skills.ts"), notifyLazyViewChanged);
const lazyUsage = createLazyView(() => import("./views/usage.ts"), notifyLazyViewChanged);
const lazyWorkboard = createLazyView(() => import("./views/workboard.ts"), notifyLazyViewChanged);

type ChatWorkspaceFilesState = {
  activeName: string | null;
  agentId: string;
  error: string | null;
  list: AgentsFilesListResult | null;
  loading: boolean;
  requestId: number;
  activeDir: string | null;
  activeDirFiles: AgentFileEntry[] | null;
};

const chatWorkspaceFilesStates = new WeakMap<AppViewState, ChatWorkspaceFilesState>();
const chatWorkspaceFileOpenRequests = new WeakMap<
  AppViewState,
  { agentId: string; id: number; name: string; sessionKey: string }
>();
/** Tracks the last file auto-previewed so we don't re-open the same file. */
const autoPreviewedFile = new WeakMap<AppViewState, string>();
/** Code-viewer runtime for one view — a single object (not parallel WeakMaps)
 * so every writer updates one place and the invariants stay co-located. */
type CodeViewerState = {
  /** When the file was opened — the scan animates only edits at/after this.
   * Resolver refetches do NOT bump it: an edit completing during another
   * edit's hold must still animate after that hold resolves. */
  openTime: number;
  /** Server-read freshness stamp of the displayed content: every async read
   * (open fetch, resolver refetch) applies only if its read started after
   * this, updating it on apply — a staler read never stomps fresher content. */
  contentTime: number;
  /** When the content was displayed — starts the 2.5s reading window. Distinct
   * from openTime (fetch start), which would deduct fetch latency from it. */
  readingStart: number;
  /** Timer for flipping reading state to false. */
  readingTimer: ReturnType<typeof setTimeout> | null;
  /** When the current edit overlay was shown (start of the 3s hold). */
  editTime: number;
  /** Nudges a render tick just past the hold — the render-tick resolver in the
   * edit-detection block does the actual refresh, so there is exactly one
   * resolution path no matter which writer showed the overlay. */
  editTimer: ReturnType<typeof setTimeout> | null;
  /** Latch: a resolver refetch is in flight (one per hold, not per tick). */
  editResolving: boolean;
  /** Unreadable-content retries for the current hold (capped). */
  editRetries: number;
};
const codeViewerStates = new WeakMap<AppViewState, CodeViewerState>();

function codeViewerState(state: AppViewState): CodeViewerState {
  let cv = codeViewerStates.get(state);
  if (!cv) {
    cv = {
      openTime: 0,
      contentTime: 0,
      readingStart: 0,
      readingTimer: null,
      editTime: 0,
      editTimer: null,
      editResolving: false,
      editRetries: 0,
    };
    codeViewerStates.set(state, cv);
  }
  return cv;
}

/** Spread to end an edit hold — one clear shape for every resolver branch. */
const overlayCleared = { pendingEdit: null, editing: false, reading: false } as const;

/** Fallback "/"-bounded basename match for the edit scan when no workspace root
 * is known to resolve the tool arg (resolveAgentArgPath returned null). A miss
 * strands stale content forever, so this stays deliberately generous; the cost
 * of an over-match — a phantom diff on a same-named sibling — is cosmetic and
 * self-heals via the absolute-path refetch. With a root known the caller uses
 * exact samePathConfident matching instead, so this only covers the pre-list
 * window. */
function entryPathMatchesOpenFile(entryPath: string, fileName: string): boolean {
  return entryPath === fileName || entryPath.endsWith(`/${fileName}`);
}

/** Confident same-path check where guessing "same" shows the wrong file
 * (auto-open suppression, keep-view): equal modulo the macOS /private
 * realpath divergence; broader suffix rules judge nested distinct files equal. */
function samePathConfident(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (!a.startsWith("/") || !b.startsWith("/")) {
    return false;
  }
  const strip = (p: string) => (p.startsWith("/private/") ? p.slice("/private".length) : p);
  return strip(a) === strip(b);
}

/** Restart the 2.5s reading window. Clearing the previous timer keeps an
 * earlier file's pending flip from truncating the new file's window. */
function restartReadingWindow(cv: CodeViewerState) {
  if (cv.readingTimer) {
    clearTimeout(cv.readingTimer);
  }
  cv.readingTimer = null;
  cv.readingStart = Date.now();
}

/** (Re)start the 3s edit hold and schedule a render tick just past it so the
 * render-tick resolver runs even on an otherwise idle UI. */
function armEditHold(cv: CodeViewerState, requestHostUpdate: (() => void) | undefined) {
  cv.editTime = Date.now();
  if (cv.editTimer) {
    clearTimeout(cv.editTimer);
  }
  cv.editTimer = setTimeout(() => {
    cv.editTimer = null;
    requestHostUpdate?.();
  }, 3050);
}

function getChatWorkspaceFilesState(state: AppViewState, agentId: string): ChatWorkspaceFilesState {
  const current = chatWorkspaceFilesStates.get(state);
  if (current?.agentId === agentId) {
    return current;
  }
  const next = {
    activeName: null,
    agentId,
    error: null,
    list: null,
    loading: false,
    requestId: 0,
    activeDir: null,
    activeDirFiles: null,
  };
  chatWorkspaceFilesStates.set(state, next);
  return next;
}

export function formatDreamNextCycle(nextRunAtMs: number | undefined): string | null {
  return (
    formatTimeMs(
      nextRunAtMs,
      {
        hour: "numeric",
        minute: "2-digit",
      },
      "",
    ) || null
  );
}

function resolveDreamingNextCycle(
  status: { phases?: Record<string, { enabled: boolean; nextRunAtMs?: number }> } | null,
): string | null {
  if (!status?.phases) {
    return null;
  }
  let nextRunAtMs: number | undefined;
  for (const phase of Object.values(status.phases)) {
    if (!phase.enabled || typeof phase.nextRunAtMs !== "number") {
      continue;
    }
    if (nextRunAtMs === undefined || phase.nextRunAtMs < nextRunAtMs) {
      nextRunAtMs = phase.nextRunAtMs;
    }
  }
  return formatDreamNextCycle(nextRunAtMs);
}

let clawhubSearchTimer: ReturnType<typeof setTimeout> | null = null;

const UPDATE_BANNER_DISMISS_KEY = "openclaw:control-ui:update-banner-dismissed:v1";
const CRON_THINKING_SUGGESTIONS = ["off", "minimal", "low", "medium", "high"];
const CRON_TIMEZONE_SUGGESTIONS = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function normalizeSuggestionValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

type DismissedUpdateBanner = {
  latestVersion: string;
  channel: string | null;
  dismissedAtMs: number;
};

function loadDismissedUpdateBanner(): DismissedUpdateBanner | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(UPDATE_BANNER_DISMISS_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<DismissedUpdateBanner>;
    if (!parsed || typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      latestVersion: parsed.latestVersion,
      channel: typeof parsed.channel === "string" ? parsed.channel : null,
      dismissedAtMs: typeof parsed.dismissedAtMs === "number" ? parsed.dismissedAtMs : Date.now(),
    };
  } catch {
    return null;
  }
}

function isUpdateBannerDismissed(updateAvailable: unknown): boolean {
  const dismissed = loadDismissedUpdateBanner();
  if (!dismissed) {
    return false;
  }
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  return Boolean(
    latestVersion && dismissed.latestVersion === latestVersion && dismissed.channel === channel,
  );
}

function dismissUpdateBanner(updateAvailable: unknown) {
  const info = updateAvailable as { latestVersion?: unknown; channel?: unknown };
  const latestVersion = info && typeof info.latestVersion === "string" ? info.latestVersion : null;
  if (!latestVersion) {
    return;
  }
  const channel = info && typeof info.channel === "string" ? info.channel : null;
  const payload: DismissedUpdateBanner = {
    latestVersion,
    channel,
    dismissedAtMs: Date.now(),
  };
  try {
    getSafeLocalStorage()?.setItem(UPDATE_BANNER_DISMISS_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

// "channels" intentionally omitted: channel configuration is consolidated into
// the dedicated Channels tab (renderChannels), so Communications only owns the
// message/delivery sections.
const COMMUNICATION_SECTION_KEYS = [
  "messages",
  "broadcast",
  "__notifications__",
  "talk",
  "audio",
] as const;
const APPEARANCE_SECTION_KEYS = ["__appearance__", "ui", "wizard"] as const;
const AUTOMATION_SECTION_KEYS = [
  "commands",
  "hooks",
  "bindings",
  "cron",
  "approvals",
  "plugins",
] as const;
const INFRASTRUCTURE_SECTION_KEYS = [
  "gateway",
  "web",
  "browser",
  "nodeHost",
  "canvasHost",
  "discovery",
  "media",
  "acp",
  "mcp",
] as const;
const AI_AGENTS_SECTION_KEYS = [
  "agents",
  "models",
  "skills",
  "tools",
  "memory",
  "session",
] as const;
type ConfigSectionSelection = {
  activeSection: string | null;
  activeSubsection: string | null;
};

type ConfigTabOverrides = Pick<
  ConfigProps,
  | "formMode"
  | "searchQuery"
  | "activeSection"
  | "activeSubsection"
  | "onFormModeChange"
  | "onSearchChange"
  | "onSectionChange"
  | "onSubsectionChange"
> &
  Partial<
    Pick<
      ConfigProps,
      | "showModeToggle"
      | "navRootLabel"
      | "showRootTab"
      | "includeSections"
      | "excludeSections"
      | "includeVirtualSections"
      | "settingsLayout"
      | "onBackToQuick"
      | "webPush"
      | "onWebPushSubscribe"
      | "onWebPushUnsubscribe"
      | "onWebPushTest"
    >
  >;

const SCOPED_CONFIG_SECTION_KEYS = new Set<string>([
  // "channels" lives in the dedicated Channels tab, not the main config selection.
  "channels",
  ...COMMUNICATION_SECTION_KEYS,
  ...APPEARANCE_SECTION_KEYS,
  ...AUTOMATION_SECTION_KEYS,
  ...INFRASTRUCTURE_SECTION_KEYS,
  ...AI_AGENTS_SECTION_KEYS,
]);

function normalizeMainConfigSelection(
  activeSection: string | null,
  activeSubsection: string | null,
): ConfigSectionSelection {
  if (activeSection && SCOPED_CONFIG_SECTION_KEYS.has(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  return { activeSection, activeSubsection };
}

function normalizeScopedConfigSelection(
  activeSection: string | null,
  activeSubsection: string | null,
  includedSections: readonly string[],
): ConfigSectionSelection {
  if (activeSection && !includedSections.includes(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  return { activeSection, activeSubsection };
}

function countScopedTopLevelSchemaProperties(
  schema: unknown,
  includeSections?: readonly string[],
  excludeSections?: readonly string[],
): number {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return 0;
  }
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return 0;
  }
  const include = includeSections?.length ? new Set(includeSections) : null;
  const exclude = excludeSections?.length ? new Set(excludeSections) : null;
  return Object.keys(properties).filter((key) => {
    if (include && !include.has(key)) {
      return false;
    }
    if (exclude?.has(key)) {
      return false;
    }
    return true;
  }).length;
}

function renderMeasured<T>(
  state: AppViewState,
  surface: string,
  payload: Record<string, unknown>,
  render: () => T,
): T {
  const startedAtMs = controlUiNowMs();
  const result = render();
  recordControlUiRenderTiming(state, surface, {
    ...payload,
    durationMs: roundedControlUiDurationMs(controlUiNowMs() - startedAtMs),
  });
  return result;
}

function renderGuardedChatControls(state: AppViewState) {
  return guard(
    [
      state.sessionKey,
      state.connected,
      state.client,
      state.onboarding,
      state.chatManualRefreshInFlight,
      state.chatLoading,
      state.chatSending,
      state.chatStream,
      state.chatRunId,
      state.chatMobileControlsOpen,
      state.sessionsHideCron ?? true,
      state.sessionsResult,
      state.sessionsShowArchived,
      state.agentsList,
      state.chatModelOverrides,
      state.chatModelSwitchPromises,
      state.chatModelsLoading,
      state.chatModelCatalog,
      state.settings.chatShowThinking,
      state.settings.chatShowToolCalls,
      state.settings.chatAutoScroll,
      state.chatSessionPickerOpen,
      state.chatSessionPickerSurface,
      state.chatSessionPickerQuery,
      state.chatSessionPickerAppliedQuery,
      state.chatSessionPickerLoading,
      state.chatSessionPickerError,
      state.chatSessionPickerResult,
      state.sessionSwitchNotice?.id ?? null,
      state.sessionSwitchNotice?.text ?? null,
      state.sessionSwitchFlashKey,
      i18n.getLocale(),
    ],
    () => renderChatControls(state),
  );
}

function resolveAssistantAvatarUrl(state: AppViewState): string | undefined {
  const list = state.agentsList?.agents ?? [];
  const parsed = parseAgentSessionKey(state.sessionKey);
  const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
  const agent = list.find((entry) => entry.id === agentId);
  const identity = agent?.identity;
  const candidate = identity?.avatarUrl ?? identity?.avatar;
  if (!candidate) {
    return undefined;
  }
  if (isRenderableControlUiAvatarUrl(candidate)) {
    return candidate;
  }
  return undefined;
}

function resolveAssistantAvatarOverride(config: unknown): string | null {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return null;
  }
  const ui = (config as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) {
    return null;
  }
  const assistant = (ui as { assistant?: unknown }).assistant;
  if (!assistant || typeof assistant !== "object" || Array.isArray(assistant)) {
    return null;
  }
  return normalizeOptionalString((assistant as { avatar?: unknown }).avatar) ?? null;
}

function buildAssistantAvatarRoute(basePathValue: string | null | undefined, agentId: string) {
  const basePath = normalizeBasePath(basePathValue ?? "");
  const encoded = encodeURIComponent(agentId);
  return basePath ? `${basePath}/avatar/${encoded}` : `/avatar/${encoded}`;
}

// ── Quick Settings data extraction helpers ──

const KNOWN_CHANNEL_IDS = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "signal", label: "Signal" },
  { id: "imessage", label: "iMessage" },
] as const;

function formatQuickSettingsLabel(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    return "Unknown";
  }
  return trimmed
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const KNOWN_CHANNEL_LABELS = new Map<string, string>(
  KNOWN_CHANNEL_IDS.map(({ id, label }) => [id, label]),
);

function readChannelsConfig(state: AppViewState): Record<string, unknown> {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return {};
  }
  return "channels" in config && config.channels && typeof config.channels === "object"
    ? (config.channels as Record<string, unknown>)
    : {};
}

function toQuickSettingsChannel(
  channelsConfig: Record<string, unknown>,
  id: string,
): QuickSettingsChannel {
  const channelConfig = channelsConfig[id];
  const hasConfig =
    channelConfig != null &&
    typeof channelConfig === "object" &&
    Object.keys(channelConfig).length > 0;
  return {
    id,
    label: KNOWN_CHANNEL_LABELS.get(id) ?? formatQuickSettingsLabel(id),
    connected: hasConfig,
    detail: hasConfig ? "Configured" : undefined,
  };
}

function extractQuickSettingsChannels(state: AppViewState): QuickSettingsChannel[] {
  const channelsConfig = readChannelsConfig(state);
  const configuredIds = Object.keys(channelsConfig).filter((id) => id.trim().length > 0);
  const channelIds =
    configuredIds.length > 0
      ? configuredIds.toSorted((a, b) => a.localeCompare(b))
      : KNOWN_CHANNEL_IDS.map(({ id }) => id);
  return channelIds.map((id) => toQuickSettingsChannel(channelsConfig, id));
}

// Full channel catalog (known roster plus any extra configured ids) for the
// Channels card "+" modal, so operators can reach channels that aren't
// configured yet. The card list stays focused on configured channels.
function extractQuickSettingsChannelCatalog(state: AppViewState): QuickSettingsChannel[] {
  const channelsConfig = readChannelsConfig(state);
  const knownIds: string[] = KNOWN_CHANNEL_IDS.map(({ id }) => id);
  const extraIds = Object.keys(channelsConfig)
    .filter((id) => id.trim().length > 0 && !knownIds.includes(id))
    .toSorted((a, b) => a.localeCompare(b));
  return [...knownIds, ...extraIds].map((id) => toQuickSettingsChannel(channelsConfig, id));
}

function extractMcpServerCount(state: AppViewState): number {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return 0;
  }
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object") {
    return 0;
  }
  const servers =
    "servers" in mcp && mcp.servers && typeof mcp.servers === "object"
      ? (mcp.servers as Record<string, unknown>)
      : {};
  return Object.keys(servers).length;
}

export function extractQuickSettingsSecurity(state: AppViewState): {
  gatewayAuth: string;
  execPolicy: string;
  deviceAuth: boolean;
  browserEnabled: boolean;
  toolProfile: string;
} {
  const config = state.configForm ?? state.configSnapshot?.config;
  if (!config || typeof config !== "object") {
    return {
      gatewayAuth: "unknown",
      execPolicy: "unknown",
      deviceAuth: false,
      browserEnabled: true,
      toolProfile: "full",
    };
  }
  const cfg = config;
  const gateway =
    "gateway" in cfg && cfg.gateway && typeof cfg.gateway === "object"
      ? (cfg.gateway as Record<string, unknown>)
      : null;
  const auth =
    gateway && "auth" in gateway && gateway.auth && typeof gateway.auth === "object"
      ? (gateway.auth as Record<string, unknown>)
      : null;
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    if (mode) {
      gatewayAuth = mode;
    } else if (auth.password) {
      gatewayAuth = "password";
    } else if (auth.token) {
      gatewayAuth = "token";
    } else if (auth.trustedProxy) {
      gatewayAuth = "trusted-proxy";
    } else {
      gatewayAuth = "none";
    }
  }
  let execPolicy = "allowlist";
  let toolProfile = "full";
  const tools = cfg.tools;
  if (tools && typeof tools === "object") {
    const profile = (tools as Record<string, unknown>).profile;
    if (typeof profile === "string") {
      const trimmedProfile = profile.trim();
      if (trimmedProfile) {
        toolProfile = trimmedProfile;
      }
    }
    const exec = (tools as Record<string, unknown>).exec;
    if (exec && typeof exec === "object") {
      const security = (exec as Record<string, unknown>).security;
      if (typeof security === "string") {
        const trimmedSecurity = security.trim();
        if (trimmedSecurity) {
          execPolicy = trimmedSecurity;
        }
      }
    }
  }
  let browserEnabled = true;
  const browser =
    "browser" in cfg && cfg.browser && typeof cfg.browser === "object"
      ? (cfg.browser as Record<string, unknown>)
      : null;
  if (browser && typeof browser.enabled === "boolean") {
    browserEnabled = browser.enabled;
  }
  let deviceAuth = true;
  if (gateway) {
    const controlUi =
      "controlUi" in gateway && gateway.controlUi && typeof gateway.controlUi === "object"
        ? (gateway.controlUi as Record<string, unknown>)
        : null;
    if (controlUi?.dangerouslyDisableDeviceAuth === true) {
      deviceAuth = false;
    }
  }
  return { gatewayAuth, execPolicy, deviceAuth, browserEnabled, toolProfile };
}

function resolveQuickSettingsSessionRow(state: AppViewState) {
  return state.sessionsResult?.sessions?.find((row) => row.key === state.sessionKey);
}

function renderCronQuickCreateForTab(
  state: AppViewState,
  requestHostUpdate: (() => void) | undefined,
) {
  return renderCronQuickCreate({
    open: state.cronQuickCreateOpen,
    step: state.cronQuickCreateStep,
    draft: state.cronQuickCreateDraft ?? createDefaultDraft(),
    onDraftChange: (patch) => {
      state.cronQuickCreateDraft = {
        ...(state.cronQuickCreateDraft ?? createDefaultDraft()),
        ...patch,
      };
      requestHostUpdate?.();
    },
    onStepChange: (step) => {
      state.cronQuickCreateStep = step;
      requestHostUpdate?.();
    },
    onCreate: () => {
      const draft = state.cronQuickCreateDraft ?? createDefaultDraft();
      const formPatch = draftToCronFormPatch(draft);
      state.cronEditingJobId = null;
      state.cronForm = { ...DEFAULT_CRON_FORM, ...formPatch } as typeof state.cronForm;
      requestHostUpdate?.();
      void (async () => {
        const saved = await addCronJob(state);
        if (!saved) {
          requestHostUpdate?.();
          return;
        }
        state.cronQuickCreateOpen = false;
        state.cronQuickCreateStep = "what";
        state.cronQuickCreateDraft = null;
        requestHostUpdate?.();
      })();
    },
    onAdvancedCreate: () => {
      const draft = state.cronQuickCreateDraft ?? createDefaultDraft();
      const formPatch = draftToCronFormPatch(draft);
      state.cronEditingJobId = null;
      state.cronForm = normalizeCronFormState({
        ...DEFAULT_CRON_FORM,
        ...formPatch,
      } as typeof state.cronForm);
      state.cronFieldErrors = validateCronForm(state.cronForm);
      state.cronQuickCreateOpen = false;
      state.cronQuickCreateStep = "what";
      state.cronQuickCreateDraft = null;
      state.cronFormCollapsed = false;
      requestHostUpdate?.();
    },
    onCancel: () => {
      state.cronQuickCreateOpen = false;
      state.cronQuickCreateStep = "what";
      state.cronQuickCreateDraft = null;
      requestHostUpdate?.();
    },
  });
}

// Re-entrancy guard for the edit/resend handler: a rapid second Save must not
// run chat.branch (history rewind) twice. Keyed by view state so it is per-tab.
const editResendInFlight = new WeakSet<object>();

export function renderApp(state: AppViewState) {
  const updatableState = state as AppViewState & { requestUpdate?: () => void };
  const requestHostUpdate =
    typeof updatableState.requestUpdate === "function"
      ? () => updatableState.requestUpdate?.()
      : undefined;
  pendingUpdate = requestHostUpdate;

  // Live tick timer: drive requestUpdate every second while the thinking indicator
  // is active so the elapsed time counter updates in real time.
  const isThinking = state.chatSending || state.chatStream !== null || state.chatRunId !== null;
  if (isThinking && !thinkingTickInterval) {
    thinkingTickInterval = setInterval(() => {
      pendingUpdate?.();
    }, 1000);
  } else if (!isThinking && thinkingTickInterval) {
    clearInterval(thinkingTickInterval);
    thinkingTickInterval = undefined;
  }

  // Gate: require successful gateway connection before showing the dashboard.
  // The gateway URL confirmation overlay is always rendered so URL-param flows still work.
  if (!state.connected) {
    return html` ${renderLoginGate(state)} ${renderGatewayUrlConfirmation(state)} `;
  }

  const presenceCount = state.presenceEntries.length;
  const sessionsCount = state.sessionsResult?.count ?? null;
  const cronNext = state.cronStatus?.nextWakeAtMs ?? null;
  const chatDisabledReason = state.connected ? null : t("chat.disconnected");
  const isChat = state.tab === "chat";
  const headerError = !isChat && state.lastError !== state.chatError ? state.lastError : null;
  const chatViewError = state.lastError;
  const chatHeaderHidden = isChat && (state.onboarding || state.chatHeaderControlsHidden);
  const navDrawerOpen = state.navDrawerOpen && !state.onboarding;
  const navCollapsed = state.settings.navCollapsed && !navDrawerOpen;
  const dashboardHeaderContext = resolveDashboardHeaderContext(state);
  const showThinking = state.onboarding ? false : state.settings.chatShowThinking;
  const showToolCalls = state.onboarding ? true : state.settings.chatShowToolCalls;
  const localAssistantAvatarOverride =
    normalizeOptionalString(loadLocalAssistantIdentity().avatar) ?? null;
  const assistantAvatarUrl = resolveAssistantAvatarUrl(state);
  const chatAssistantAvatarStatus = localAssistantAvatarOverride
    ? "data"
    : (state.chatAvatarStatus ?? state.assistantAvatarStatus ?? null);
  const chatAssistantAvatarReason = localAssistantAvatarOverride
    ? null
    : (state.chatAvatarReason ?? state.assistantAvatarReason ?? null);
  const chatAssistantAvatarMissing =
    chatAssistantAvatarStatus === "none" && chatAssistantAvatarReason === "missing";
  const effectiveAssistantAvatar =
    localAssistantAvatarOverride ?? (chatAssistantAvatarMissing ? null : state.assistantAvatar);
  const configAssistantAvatarStatus = localAssistantAvatarOverride
    ? "data"
    : (state.assistantAvatarStatus ?? state.chatAvatarStatus ?? null);
  const configAssistantAvatarReason = localAssistantAvatarOverride
    ? null
    : (state.assistantAvatarReason ?? state.chatAvatarReason ?? null);
  const configAssistantAvatarSource =
    localAssistantAvatarOverride ?? state.assistantAvatarSource ?? state.chatAvatarSource ?? null;
  const configAssistantAvatarMissing =
    configAssistantAvatarStatus === "none" && configAssistantAvatarReason === "missing";
  const configAssistantAvatar =
    localAssistantAvatarOverride ??
    (configAssistantAvatarMissing || configAssistantAvatarStatus === "local"
      ? null
      : state.assistantAvatar);
  const configAssistantAvatarUrl =
    localAssistantAvatarOverride ??
    (configAssistantAvatarStatus === "local" && state.assistantAgentId
      ? buildAssistantAvatarRoute(state.basePath, state.assistantAgentId)
      : (state.chatAvatarUrl ??
        (configAssistantAvatarMissing ? null : (assistantAvatarUrl ?? null))));
  const defaultAgentId = state.agentsList?.defaultId ?? "";
  const quickSettingsAgents: QuickSettingsAgentCard[] = (state.agentsList?.agents ?? []).map(
    (agent) => {
      const override = getLocalAgentAvatarOverride(agent.id, defaultAgentId);
      const blobUrl = state.agentAvatarUrls?.[agent.id] ?? null;
      const isDefault = agent.id === defaultAgentId;
      return {
        id: agent.id,
        name:
          normalizeOptionalString(agent.name) ??
          normalizeOptionalString(agent.identity?.name) ??
          agent.id,
        description: normalizeOptionalString(agent.description),
        emoji: normalizeOptionalString(agent.identity?.emoji),
        avatarUrl: override ?? blobUrl,
        isDefault,
        hasOverride: Boolean(override),
        // The default agent reuses the legacy single-assistant upload state; other
        // agents persist synchronously, so they never enter a busy/error state.
        uploadBusy: isDefault ? state.assistantAvatarUploadBusy : false,
        uploadError: isDefault ? state.assistantAvatarUploadError : null,
      };
    },
  );
  const configValue =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const configuredDreaming = resolveConfiguredDreaming(configValue);
  const dreamingOn = state.dreamingStatus?.enabled ?? configuredDreaming.enabled;
  const dreamingNextCycle = resolveDreamingNextCycle(state.dreamingStatus);
  // Map each agent's assigned avatar source by normalized id so the dreaming
  // picker honors uploaded avatars; agents without one fall back to the
  // deterministic invader inside agentAvatarUrl().
  const dreamingAvatarSourceById = new Map(
    (state.agentsList?.agents ?? []).map((agent) => [
      normalizeAgentId(agent.id),
      { avatar: agent.identity?.avatar ?? null, avatarUrl: agent.identity?.avatarUrl ?? null },
    ]),
  );
  // The aggregate "all agents" view is folded into the default agent (Davos):
  // a single merged chip that defaults to the aggregate and toggles to the
  // default-agent-only view on click. The default agent is therefore dropped
  // from the per-agent list so it is not shown twice.
  const dreamingDefaultAgentId = normalizeAgentId(state.agentsList?.defaultId ?? "main");
  const dreamingDefaultAgent = (state.agentsList?.agents ?? []).find(
    (agent) => normalizeAgentId(agent.id) === dreamingDefaultAgentId,
  );
  const dreamingDefaultAgentName =
    normalizeOptionalString(dreamingDefaultAgent?.identity?.name) ??
    normalizeOptionalString(dreamingDefaultAgent?.name) ??
    dreamingDefaultAgentId;
  const dreamingAgentOptions: DreamingAgentOption[] = [
    {
      id: ALL_AGENTS_ID,
      label: dreamingDefaultAgentName,
      toggleAgentId: dreamingDefaultAgentId,
      ...(dreamingAvatarSourceById.get(dreamingDefaultAgentId) ?? {}),
    },
    ...resolveDreamingAgentOptions(state)
      .filter((option) => normalizeAgentId(option.id) !== dreamingDefaultAgentId)
      .map((option) => ({
        ...option,
        ...(dreamingAvatarSourceById.get(option.id) ?? {}),
      })),
  ];
  const rawDreamingSelectedAgentId =
    // Default to the aggregate "All" view until the user explicitly picks an
    // agent (null = untouched); an explicit pick follows the active chat agent.
    state.selectedAgentId === null || state.selectedAgentId === ALL_AGENTS_ID
      ? ALL_AGENTS_ID
      : resolveChatAgentFilterId(state, state.sessionKey);
  // Channel/ad-hoc sessions resolve to non-agent ids absent from the dreaming
  // picker; fall back to the first real agent so a button always reflects state.
  const dreamingSelectedAgentId = dreamingAgentOptions.some(
    (option) =>
      option.id === rawDreamingSelectedAgentId ||
      option.toggleAgentId === rawDreamingSelectedAgentId,
  )
    ? rawDreamingSelectedAgentId
    : (dreamingAgentOptions[0]?.id ?? rawDreamingSelectedAgentId);
  const syncDreamingSelectedAgent = () => {
    state.selectedAgentId = dreamingSelectedAgentId;
  };
  const dreamingLoading = state.dreamingStatusLoading || state.dreamingModeSaving;
  const dreamingRefreshLoading = state.dreamingStatusLoading || state.dreamDiaryLoading;
  const refreshDreaming = () => {
    void (async () => {
      syncDreamingSelectedAgent();
      await loadConfig(state);
      await Promise.all([
        loadDreamingStatus(state),
        loadDreamDiary(state),
        loadWikiImportInsights(state),
        loadWikiMemoryPalace(state),
      ]);
    })();
  };
  const openWikiPage = async (lookup: string) => {
    if (!state.client || !state.connected) {
      return null;
    }
    const payload: {
      title?: unknown;
      path?: unknown;
      content?: unknown;
      updatedAt?: unknown;
      totalLines?: unknown;
      truncated?: unknown;
    } | null = await state.client.request("wiki.get", {
      lookup,
      fromLine: 1,
      lineCount: 5000,
    });
    const title =
      typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : lookup;
    const path =
      typeof payload?.path === "string" && payload.path.trim() ? payload.path.trim() : lookup;
    const content =
      typeof payload?.content === "string" && payload.content.length > 0
        ? payload.content
        : "No wiki content available.";
    const updatedAt =
      typeof payload?.updatedAt === "string" && payload.updatedAt.trim()
        ? payload.updatedAt.trim()
        : undefined;
    const totalLines =
      typeof payload?.totalLines === "number" && Number.isFinite(payload.totalLines)
        ? Math.max(0, Math.floor(payload.totalLines))
        : undefined;
    const truncated = payload?.truncated === true;
    return {
      title,
      path,
      content,
      ...(totalLines !== undefined ? { totalLines } : {}),
      ...(truncated ? { truncated } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  };
  const applyDreamingEnabled = (enabled: boolean) => {
    if (
      state.dreamingModeSaving ||
      state.dreamingRestartConfirmLoading ||
      state.dreamingRestartConfirmOpen ||
      dreamingOn === enabled
    ) {
      return;
    }
    state.dreamingPendingEnabled = enabled;
    state.dreamingRestartConfirmOpen = true;
    state.dreamingStatusError = null;
  };
  const cancelDreamingRestart = () => {
    if (state.dreamingRestartConfirmLoading) {
      return;
    }
    state.dreamingRestartConfirmOpen = false;
    state.dreamingPendingEnabled = null;
    state.dreamingStatusError = null;
  };
  const confirmDreamingRestart = () => {
    const enabled = state.dreamingPendingEnabled;
    if (enabled == null || state.dreamingRestartConfirmLoading) {
      return;
    }
    void (async () => {
      state.dreamingRestartConfirmLoading = true;
      state.dreamingStatusError = null;
      try {
        const updated = await updateDreamingEnabled(state, enabled);
        if (!updated) {
          if (!state.dreamingStatusError) {
            state.dreamingStatusError = t("dreaming.restartConfirmation.failed");
          }
          return;
        }
        await loadConfig(state);
        await loadDreamingStatus(state);
        state.dreamingRestartConfirmOpen = false;
        state.dreamingPendingEnabled = null;
      } finally {
        state.dreamingRestartConfirmLoading = false;
      }
    })();
  };
  const resolveSelectedAgentId = () =>
    state.agentsSelectedId ??
    state.agentsList?.defaultId ??
    state.agentsList?.agents?.[0]?.id ??
    null;
  const resolvedAgentId = resolveSelectedAgentId();
  const normalizedChatSessionKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
  const activeSessionAgentId =
    normalizedChatSessionKey === "global" ? null : resolveAgentIdFromSessionKey(state.sessionKey);
  const scopedChatAgentId = scopedAgentParamsForSession(state, state.sessionKey).agentId;
  const chatFallbackAgentId = normalizeAgentId(
    state.assistantAgentId ??
      state.agentsList?.defaultId ??
      state.agentsList?.agents?.[0]?.id ??
      "main",
  );
  const resolveChatWorkspaceAgentId = () => {
    const normalizedKey = normalizeOptionalString(state.sessionKey)?.toLowerCase();
    const activeAgentId =
      normalizedKey === "global" ? null : resolveAgentIdFromSessionKey(state.sessionKey);
    const scopedAgentId = scopedAgentParamsForSession(state, state.sessionKey).agentId;
    return normalizedKey === "global"
      ? (scopedAgentId ?? chatFallbackAgentId)
      : (activeAgentId ?? scopedAgentId ?? chatFallbackAgentId);
  };
  const chatAgentId =
    normalizedChatSessionKey === "global"
      ? (scopedChatAgentId ?? chatFallbackAgentId)
      : (activeSessionAgentId ?? scopedChatAgentId ?? chatFallbackAgentId);
  // Resolve the chat avatar per-agent from the agent's own identity, exactly
  // like the office/workboard: a persisted avatar wins, else the generated
  // invader — so chat matches every other surface for the same agent.
  const chatAgentRow = state.agentsList?.agents.find((a) => a.id === chatAgentId);
  // Legacy single-assistant avatar only applies to the default agent; for others
  // it is the shared/global value and must not leak across agents.
  const isDefaultChatAgent = chatAgentId === (state.agentsList?.defaultId ?? "main");
  const chatAgentAvatar = agentAvatarUrl(chatAgentId, {
    avatar:
      chatAgentRow?.identity?.avatar ?? (isDefaultChatAgent ? effectiveAssistantAvatar : undefined),
    avatarUrl: chatAgentRow?.identity?.avatarUrl,
  });
  const toolsPanelUsesActiveSession = Boolean(resolvedAgentId && resolvedAgentId === chatAgentId);
  const chatWorkspaceFiles = getChatWorkspaceFilesState(state, chatAgentId);
  const currentChatWorkspaceFilesState = () =>
    resolveChatWorkspaceAgentId() === chatAgentId
      ? getChatWorkspaceFilesState(state, chatAgentId)
      : null;
  const getCurrentConfigValue = () =>
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const findAgentIndex = (agentId: string) =>
    findAgentConfigEntryIndex(getCurrentConfigValue(), agentId);
  const ensureAgentIndex = (agentId: string) => ensureAgentConfigEntry(state, agentId);
  const resolveAgentToolsPath = (agentId: string, ensure: boolean) => {
    const index = ensure ? ensureAgentIndex(agentId) : findAgentIndex(agentId);
    return index >= 0 ? (["agents", "list", index, "tools"] as const) : null;
  };
  const resolveAgentModelFormEntry = (index: number) => {
    const list = (getCurrentConfigValue() as { agents?: { list?: unknown[] } } | null)?.agents
      ?.list;
    const existing = Array.isArray(list)
      ? (list[index] as { model?: unknown } | undefined)?.model
      : undefined;
    return {
      basePath: ["agents", "list", index, "model"] as Array<string | number>,
      existing,
    };
  };
  const cronAgentSuggestions = sortLocaleStrings(
    new Set(
      [
        ...(state.agentsList?.agents?.map((entry) => entry.id.trim()) ?? []),
        ...state.cronJobs
          .map((job) => (typeof job.agentId === "string" ? job.agentId.trim() : ""))
          .filter(Boolean),
      ].filter(Boolean),
    ),
  );
  const cronModelSuggestions = sortLocaleStrings(
    new Set(
      [
        ...state.cronModelSuggestions,
        ...resolveConfiguredCronModelSuggestions(configValue),
        ...state.cronJobs
          .map((job) => {
            const payload = getCronJobPayload(job);
            if (payload?.kind !== "agentTurn" || typeof payload.model !== "string") {
              return "";
            }
            return payload.model.trim();
          })
          .filter(Boolean),
      ].filter(Boolean),
    ),
  );
  const visibleCronJobs = getVisibleCronJobs(state);
  const selectedDeliveryChannel =
    state.cronForm.deliveryChannel && state.cronForm.deliveryChannel.trim()
      ? state.cronForm.deliveryChannel.trim()
      : "last";
  const jobToSuggestions = state.cronJobs
    .map((job) => normalizeSuggestionValue(job.delivery?.to))
    .filter(Boolean);
  const accountToSuggestions = (
    selectedDeliveryChannel === "last"
      ? Object.values(state.channelsSnapshot?.channelAccounts ?? {}).flat()
      : (state.channelsSnapshot?.channelAccounts?.[selectedDeliveryChannel] ?? [])
  )
    .flatMap((account) => [
      normalizeSuggestionValue(account.accountId),
      normalizeSuggestionValue(account.name),
    ])
    .filter(Boolean);
  const rawDeliveryToSuggestions = uniquePreserveOrder([
    ...jobToSuggestions,
    ...accountToSuggestions,
  ]);
  const accountSuggestions = uniquePreserveOrder(accountToSuggestions);
  const deliveryToSuggestions =
    state.cronForm.deliveryMode === "webhook"
      ? rawDeliveryToSuggestions.filter((value) => isHttpUrl(value))
      : rawDeliveryToSuggestions;
  const commonConfigProps = {
    raw: state.configRaw,
    originalRaw: state.configRawOriginal,
    valid: state.configValid,
    issues: state.configIssues,
    loading: state.configLoading,
    saving: state.configSaving,
    applying: state.configApplying,
    updating: state.updateRunning,
    connected: state.connected,
    schema: state.configSchema,
    schemaLoading: state.configSchemaLoading,
    uiHints: state.configUiHints,
    formValue: state.configForm,
    originalValue: state.configFormOriginal,
    onRawChange: (next: string) => {
      updateConfigRawValue(state, next);
    },
    onRequestUpdate: requestHostUpdate,
    onFormPatch: (path: Array<string | number>, value: unknown) =>
      updateConfigFormValue(state, path, value),
    channelModalKey: state.configChannelModalKey,
    onOpenChannelModal: (_sectionKey: string, key: string) => {
      state.configChannelModalKey = key;
    },
    onCloseChannelModal: () => {
      state.configChannelModalKey = null;
    },
    onReload: () => void loadConfig(state, { discardPendingChanges: true }),
    onReset: () => resetConfigPendingChanges(state),
    onSave: () => void saveConfig(state),
    onApply: () => void applyConfig(state),
    onUpdate: () => void runUpdate(state),
    onOpenFile: () => void openConfigFile(state),
    version: state.hello?.server?.version ?? "",
    theme: state.theme,
    themeMode: state.themeMode,
    setTheme: (theme, context) => state.setTheme(theme, context),
    setThemeMode: (mode, context) => state.setThemeMode(mode, context),
    hasCustomTheme: Boolean(state.settings.customTheme),
    customThemeLabel: state.settings.customTheme?.label ?? null,
    customThemeSourceUrl: state.settings.customTheme?.sourceUrl ?? null,
    customThemeImportUrl: state.customThemeImportUrl,
    customThemeImportBusy: state.customThemeImportBusy,
    customThemeImportMessage: state.customThemeImportMessage,
    customThemeImportExpanded: state.customThemeImportExpanded,
    customThemeImportFocusToken: state.customThemeImportFocusToken,
    onCustomThemeImportUrlChange: (next) => state.setCustomThemeImportUrl(next),
    onOpenCustomThemeImport: () => state.openCustomThemeImport(),
    onImportCustomTheme: () => void state.importCustomTheme(),
    onClearCustomTheme: () => state.clearCustomTheme(),
    borderRadius: state.settings.borderRadius,
    setBorderRadius: (value) => state.setBorderRadius(value),
    textScale: state.settings.textScale ?? 100,
    setTextScale: (value) => state.setTextScale(value),
    gatewayUrl: state.settings.gatewayUrl,
    assistantName: state.assistantName,
    configPath: state.configSnapshot?.path ?? null,
    rawAvailable:
      typeof state.configSnapshot?.raw === "string" ||
      Boolean(state.configSnapshot?.config) ||
      Boolean(state.configForm),
  } satisfies Omit<
    ConfigProps,
    | "formMode"
    | "searchQuery"
    | "activeSection"
    | "activeSubsection"
    | "onFormModeChange"
    | "onSearchChange"
    | "onSectionChange"
    | "onSubsectionChange"
    | "showModeToggle"
    | "navRootLabel"
    | "includeSections"
    | "excludeSections"
    | "includeVirtualSections"
  >;
  const renderConfigTab = (overrides: ConfigTabOverrides) => {
    const scopedDefaultSection = overrides.includeSections?.[0] ?? null;
    const activeSection = overrides.activeSection ?? scopedDefaultSection;
    const showRootTab = overrides.showRootTab ?? !overrides.includeSections?.length;
    return renderMeasured(
      state,
      "config",
      {
        tab: state.tab,
        formMode: overrides.formMode,
        activeSection,
        activeSubsection: overrides.activeSubsection,
        schemaSectionCount: countScopedTopLevelSchemaProperties(
          commonConfigProps.schema,
          overrides.includeSections,
          overrides.excludeSections,
        ),
        hasSearch: Boolean(overrides.searchQuery?.trim()),
      },
      () =>
        renderConfig({
          ...commonConfigProps,
          includeVirtualSections: false,
          ...overrides,
          activeSection,
          showRootTab,
        }),
    );
  };
  const configSelection = normalizeMainConfigSelection(
    state.configActiveSection,
    state.configActiveSubsection,
  );
  const communicationsSelection = normalizeScopedConfigSelection(
    state.communicationsActiveSection,
    state.communicationsActiveSubsection,
    COMMUNICATION_SECTION_KEYS,
  );
  const appearanceSelection = normalizeScopedConfigSelection(
    state.appearanceActiveSection,
    state.appearanceActiveSubsection,
    APPEARANCE_SECTION_KEYS,
  );
  const automationSelection = normalizeScopedConfigSelection(
    state.automationActiveSection,
    state.automationActiveSubsection,
    AUTOMATION_SECTION_KEYS,
  );
  const infrastructureSelection = normalizeScopedConfigSelection(
    state.infrastructureActiveSection,
    state.infrastructureActiveSubsection,
    INFRASTRUCTURE_SECTION_KEYS,
  );
  const aiAgentsSelection = normalizeScopedConfigSelection(
    state.aiAgentsActiveSection,
    state.aiAgentsActiveSubsection,
    AI_AGENTS_SECTION_KEYS,
  );
  const renderConfigTabForActiveTab = () => {
    switch (state.tab) {
      case "config": {
        // Quick Settings mode — opinionated card layout
        if (state.configSettingsMode === "quick") {
          const configObj = state.configForm ?? state.configSnapshot?.config ?? {};
          const assistantAvatarOverride =
            localAssistantAvatarOverride ?? resolveAssistantAvatarOverride(configObj);
          const agentsDefaults = ((configObj.agents as Record<string, unknown> | undefined)
            ?.defaults ?? {}) as Record<string, unknown>;
          const activeSession = resolveQuickSettingsSessionRow(state);
          const currentModel =
            typeof activeSession?.model === "string"
              ? activeSession.model
              : typeof agentsDefaults.model === "string"
                ? agentsDefaults.model
                : "default";
          const thinkingLevel =
            typeof activeSession?.thinkingLevel === "string"
              ? activeSession.thinkingLevel
              : typeof agentsDefaults.thinkingLevel === "string"
                ? agentsDefaults.thinkingLevel
                : "off";
          const fastMode: FastMode =
            normalizeFastMode(activeSession?.fastMode) ??
            normalizeFastMode(agentsDefaults.fastMode) ??
            false;
          const modelSelect = resolveChatModelSelectState(state);
          const modelSwitching = Boolean(state.chatModelSwitchPromises?.[state.sessionKey]);
          return renderQuickSettings({
            currentModel,
            thinkingLevel,
            fastMode,
            modelOptions: [{ value: "", label: modelSelect.defaultLabel }, ...modelSelect.options],
            selectedModelValue: modelSelect.currentOverride,
            modelSelectDisabled: !state.connected || !state.client || modelSwitching,
            onModelSelect: (value) => {
              void switchChatModel(state, value).then(() => requestHostUpdate?.());
            },
            onThinkingChange: (level) => {
              void patchSession(state, state.sessionKey, { thinkingLevel: level }).then(() =>
                requestHostUpdate?.(),
              );
            },
            onFastModeChange: (mode) => {
              void patchSession(state, state.sessionKey, { fastMode: mode }).then(() =>
                requestHostUpdate?.(),
              );
            },
            channels: extractQuickSettingsChannels(state),
            availableChannels: extractQuickSettingsChannelCatalog(state),
            onChannelConfigure: () => {
              state.setTab("channels");
            },
            automation: {
              cronJobCount: state.cronJobs?.length ?? 0,
              skillCount: state.skillsReport?.skills?.length ?? 0,
              mcpServerCount: extractMcpServerCount(state),
            },
            onManageCron: () => {
              state.setTab("cron");
            },
            onBrowseSkills: () => {
              state.setTab("skills");
            },
            onConfigureMcp: () => {
              state.setTab("mcp");
            },
            security: extractQuickSettingsSecurity(state),
            onSecurityConfigure: () => {
              state.configSettingsMode = "advanced";
              state.configActiveSection = "auth";
              requestHostUpdate?.();
            },
            onBrowserEnabledToggle: (enabled) => {
              updateConfigFormValue(state, ["browser", "enabled"], enabled);
              requestHostUpdate?.();
            },
            onToolProfileChange: (profile) => {
              updateConfigFormValue(state, ["tools", "profile"], profile);
              requestHostUpdate?.();
            },
            theme: state.theme,
            themeMode: state.themeMode,
            hasCustomTheme: Boolean(state.settings.customTheme),
            customThemeLabel: state.settings.customTheme?.label ?? null,
            borderRadius: state.settings.borderRadius,
            textScale: state.settings.textScale ?? 100,
            setTheme: (theme, context) => state.setTheme(theme, context),
            onOpenCustomThemeImport: () => {
              state.setTab("appearance");
              state.appearanceFormMode = "form";
              state.appearanceSearchQuery = "";
              state.appearanceActiveSection = "__appearance__";
              state.appearanceActiveSubsection = null;
              state.openCustomThemeImport();
              requestHostUpdate?.();
            },
            setThemeMode: (mode, context) => state.setThemeMode(mode, context),
            setBorderRadius: (value) => state.setBorderRadius(value),
            setTextScale: (value) => state.setTextScale(value),
            userAvatar: state.userAvatar ?? null,
            onUserAvatarChange: (avatar) => state.applyLocalUserIdentity?.({ avatar }),
            assistantAvatar: configAssistantAvatar,
            assistantAvatarUrl: configAssistantAvatarUrl,
            assistantAvatarSource: configAssistantAvatarSource,
            assistantAvatarStatus: configAssistantAvatarStatus,
            assistantAvatarReason: configAssistantAvatarReason,
            assistantAvatarOverride,
            assistantAvatarUploadBusy: state.assistantAvatarUploadBusy,
            assistantAvatarUploadError: state.assistantAvatarUploadError,
            onAssistantAvatarOverrideChange: (dataUrl) => {
              state.applyAssistantAvatarOverride?.(dataUrl);
            },
            onAssistantAvatarClearOverride: () => {
              setAssistantAvatarOverride(state, null);
              state.chatAvatarUrl = null;
              state.chatAvatarSource = null;
              state.chatAvatarStatus = null;
              state.chatAvatarReason = null;
              state.assistantAvatarUploadError = null;
              void state.loadAssistantIdentity?.().finally(() => requestHostUpdate?.());
              requestHostUpdate?.();
            },
            agents: quickSettingsAgents,
            onAgentAvatarOverrideChange: (agentId, dataUrl) => {
              // The default agent flows through the legacy override so the chat
              // header, lightbox, and bootstrap stay consistent; others persist
              // browser-locally per agent.
              if (agentId === defaultAgentId) {
                state.applyAssistantAvatarOverride?.(dataUrl);
                void refreshAgentAvatarCards(state);
                requestHostUpdate?.();
                return;
              }
              setLocalAgentAvatarOverride(agentId, defaultAgentId, dataUrl);
              requestHostUpdate?.();
            },
            onAgentAvatarClearOverride: (agentId) => {
              if (agentId === defaultAgentId) {
                setAssistantAvatarOverride(state, null);
                state.chatAvatarUrl = null;
                state.chatAvatarSource = null;
                state.chatAvatarStatus = null;
                state.chatAvatarReason = null;
                state.assistantAvatarUploadError = null;
                void state.loadAssistantIdentity?.().finally(() => requestHostUpdate?.());
                // Re-fetch the default agent's IDENTITY.md photo for the grid.
                void refreshAgentAvatarCards(state);
                requestHostUpdate?.();
                return;
              }
              setLocalAgentAvatarOverride(agentId, defaultAgentId, null);
              requestHostUpdate?.();
            },
            basePath: state.basePath ?? "",
            configObject: configObj,
            savedConfigObject:
              (state.configSnapshot?.config as Record<string, unknown> | null) ?? {},
            configDirty: state.configFormDirty,
            configSaving: state.configSaving,
            configApplying: state.configApplying,
            configReady: Boolean(state.configSnapshot?.hash),
            onSelectPreset: (presetId) => {
              const preset = getPresetById(presetId);
              if (!preset) {
                return;
              }
              stageConfigPreset(state, preset.patch);
              requestHostUpdate?.();
            },
            onResetConfig: () => resetConfigPendingChanges(state),
            onSaveConfig: () => void saveConfig(state),
            onApplyConfig: () => void applyConfig(state),
            onAdvancedSettings: () => {
              state.configSettingsMode = "advanced";
              requestHostUpdate?.();
            },
            connected: state.connected,
            gatewayUrl: state.settings.gatewayUrl,
            assistantName: state.assistantName,
            version: state.hello?.server?.version ?? "",
          });
        }
        // Advanced mode — full config form with accordion groups
        return renderConfigTab({
          formMode: state.configFormMode,
          searchQuery: state.configSearchQuery,
          activeSection: configSelection.activeSection,
          activeSubsection: configSelection.activeSubsection,
          onFormModeChange: (mode) => (state.configFormMode = mode),
          onSearchChange: (query) => (state.configSearchQuery = query),
          onSectionChange: (section) => {
            state.configActiveSection = section;
            state.configActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.configActiveSubsection = section),
          showModeToggle: true,
          settingsLayout: "accordion",
          onBackToQuick: () => {
            state.configSettingsMode = "quick";
            requestHostUpdate?.();
          },
          excludeSections: [
            // Channels config has a dedicated tab now; keep it out of main Settings.
            "channels",
            ...COMMUNICATION_SECTION_KEYS,
            ...AUTOMATION_SECTION_KEYS,
            ...INFRASTRUCTURE_SECTION_KEYS,
            ...AI_AGENTS_SECTION_KEYS,
            "ui",
            "wizard",
          ],
        });
      }
      case "channels":
        return renderLazyView(lazyChannels, (m) =>
          m.renderChannels({
            connected: state.connected,
            loading: state.channelsLoading,
            snapshot: state.channelsSnapshot,
            lastError: state.channelsError,
            lastSuccessAt: state.channelsLastSuccess,
            whatsappMessage: state.whatsappLoginMessage,
            whatsappQrDataUrl: state.whatsappLoginQrDataUrl,
            whatsappConnected: state.whatsappLoginConnected,
            whatsappBusy: state.whatsappBusy,
            configSchema: state.configSchema,
            configSchemaLoading: state.configSchemaLoading,
            configForm: state.configForm,
            configUiHints: state.configUiHints,
            configSaving: state.configSaving,
            configFormDirty: state.configFormDirty,
            channelModalKey: state.configChannelModalKey,
            onOpenChannelModal: (_sectionKey: string, key: string) => {
              state.configChannelModalKey = key;
            },
            onCloseChannelModal: () => {
              state.configChannelModalKey = null;
            },
            nostrProfileFormState: state.nostrProfileFormState,
            nostrProfileAccountId: state.nostrProfileAccountId,
            // Detail pane reuses the existing channel-config selection state so the
            // per-channel config form stays reachable under upstream's list/detail view.
            selectedChannel: state.configChannelModalKey,
            onShowDetail: (channelId: string) => {
              state.configChannelModalKey = channelId;
              requestHostUpdate?.();
            },
            onCloseDetail: () => {
              state.configChannelModalKey = null;
              requestHostUpdate?.();
            },
            setupBlockedByDirtyConfig: false,
            // Channel setup wizard is an upstream-only feature with no fork gateway
            // wiring yet; keep it idle so the list/detail config UI works. Deferred.
            wizard: { phase: "idle" },
            wizardMultiselect: [],
            onStartSetup: () => undefined,
            onWizardAnswer: () => undefined,
            onWizardToggleMultiselect: () => undefined,
            onWizardClose: () => undefined,
            onRefresh: (probe) => void loadChannels(state, probe),
            onWhatsAppStart: (force) => void state.handleWhatsAppStart(force),
            onWhatsAppWait: () => void state.handleWhatsAppWait(),
            onWhatsAppLogout: () => void state.handleWhatsAppLogout(),
            onConfigPatch: (path, value) => updateConfigFormValue(state, path, value),
            onConfigSave: () => void state.handleChannelConfigSave(),
            onConfigReload: () => void state.handleChannelConfigReload(),
            onNostrProfileEdit: (accountId, profile) =>
              state.handleNostrProfileEdit(accountId, profile),
            onNostrProfileCancel: () => state.handleNostrProfileCancel(),
            onNostrProfileFieldChange: (field, value) =>
              state.handleNostrProfileFieldChange(field, value),
            onNostrProfileSave: () => void state.handleNostrProfileSave(),
            onNostrProfileImport: () => void state.handleNostrProfileImport(),
            onNostrProfileToggleAdvanced: () => state.handleNostrProfileToggleAdvanced(),
          }),
        );
      case "communications":
        return renderConfigTab({
          formMode: state.communicationsFormMode,
          searchQuery: state.communicationsSearchQuery,
          activeSection: communicationsSelection.activeSection,
          activeSubsection: communicationsSelection.activeSubsection,
          onFormModeChange: (mode) => (state.communicationsFormMode = mode),
          onSearchChange: (query) => (state.communicationsSearchQuery = query),
          onSectionChange: (section) => {
            state.communicationsActiveSection = section;
            state.communicationsActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.communicationsActiveSubsection = section),
          navRootLabel: "Communication",
          includeSections: [...COMMUNICATION_SECTION_KEYS],
          includeVirtualSections: true,
          webPush: {
            supported: state.webPushSupported,
            permission: state.webPushPermission,
            subscribed: state.webPushSubscribed,
            loading: state.webPushLoading,
          },
          onWebPushSubscribe: () => void state.handleWebPushSubscribe(),
          onWebPushUnsubscribe: () => void state.handleWebPushUnsubscribe(),
          onWebPushTest: () => void state.handleWebPushTest(),
        });
      case "appearance":
        return renderConfigTab({
          formMode: state.appearanceFormMode,
          searchQuery: state.appearanceSearchQuery,
          activeSection: appearanceSelection.activeSection,
          activeSubsection: appearanceSelection.activeSubsection,
          onFormModeChange: (mode) => (state.appearanceFormMode = mode),
          onSearchChange: (query) => (state.appearanceSearchQuery = query),
          onSectionChange: (section) => {
            state.appearanceActiveSection = section;
            state.appearanceActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.appearanceActiveSubsection = section),
          navRootLabel: t("tabs.appearance"),
          includeSections: [...APPEARANCE_SECTION_KEYS],
          includeVirtualSections: true,
        });
      case "automation":
        return renderConfigTab({
          formMode: state.automationFormMode,
          searchQuery: state.automationSearchQuery,
          activeSection: automationSelection.activeSection,
          activeSubsection: automationSelection.activeSubsection,
          onFormModeChange: (mode) => (state.automationFormMode = mode),
          onSearchChange: (query) => (state.automationSearchQuery = query),
          onSectionChange: (section) => {
            state.automationActiveSection = section;
            state.automationActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.automationActiveSubsection = section),
          navRootLabel: "Automation",
          includeSections: [...AUTOMATION_SECTION_KEYS],
        });
      case "mcp":
        return renderMcp({
          configObject:
            state.configForm ??
            ((state.configSnapshot?.config as Record<string, unknown> | null) || {}),
          configDirty: state.configFormDirty,
          configSaving: state.configSaving,
          configApplying: state.configApplying,
          connected: state.connected,
          onSaveConfig: () => void saveConfig(state),
          onApplyConfig: () => void applyConfig(state),
          onServerEnabledChange: (name: string, enabled: boolean) => {
            updateMcpServerEnabled(state, name, enabled);
            requestHostUpdate?.();
          },
          editor: renderConfigTab({
            formMode: "form",
            searchQuery: "",
            activeSection: "mcp",
            activeSubsection: null,
            onFormModeChange: () => undefined,
            onSearchChange: () => undefined,
            onSectionChange: () => {
              state.infrastructureActiveSection = "mcp";
              state.infrastructureActiveSubsection = null;
            },
            onSubsectionChange: (section) => (state.infrastructureActiveSubsection = section),
            navRootLabel: "MCP",
            includeSections: ["mcp"],
          }),
        });
      case "infrastructure":
        return renderConfigTab({
          formMode: state.infrastructureFormMode,
          searchQuery: state.infrastructureSearchQuery,
          activeSection: infrastructureSelection.activeSection,
          activeSubsection: infrastructureSelection.activeSubsection,
          onFormModeChange: (mode) => (state.infrastructureFormMode = mode),
          onSearchChange: (query) => (state.infrastructureSearchQuery = query),
          onSectionChange: (section) => {
            state.infrastructureActiveSection = section;
            state.infrastructureActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.infrastructureActiveSubsection = section),
          navRootLabel: "Infrastructure",
          includeSections: [...INFRASTRUCTURE_SECTION_KEYS],
        });
      case "aiAgents":
        return renderConfigTab({
          formMode: state.aiAgentsFormMode,
          searchQuery: state.aiAgentsSearchQuery,
          activeSection: aiAgentsSelection.activeSection,
          activeSubsection: aiAgentsSelection.activeSubsection,
          onFormModeChange: (mode) => (state.aiAgentsFormMode = mode),
          onSearchChange: (query) => (state.aiAgentsSearchQuery = query),
          onSectionChange: (section) => {
            state.aiAgentsActiveSection = section;
            state.aiAgentsActiveSubsection = null;
          },
          onSubsectionChange: (section) => (state.aiAgentsActiveSubsection = section),
          navRootLabel: "AI & Agents",
          includeSections: [...AI_AGENTS_SECTION_KEYS],
        });
      default:
        return nothing;
    }
  };
  const loadAgentPanelDataForSelectedAgent = (agentId: string | null) => {
    if (!agentId) {
      return;
    }
    switch (state.agentsPanel) {
      case "files":
        void loadAgentFiles(state, agentId);
        return;
      case "skills":
        void loadAgentSkills(state, agentId);
        return;
      case "tools":
        void loadToolsCatalog(state, agentId);
        void refreshVisibleToolsEffectiveForCurrentSession(state);
      case "overview":
      case "channels":
      case "cron":
    }
  };
  const refreshAgentsPanelSupplementalData = (panel: AppViewState["agentsPanel"]) => {
    if (panel === "channels") {
      void loadChannels(state, false);
      return;
    }
    if (panel === "cron") {
      void state.loadCron();
    }
  };
  const resetAgentFilesState = (clearLoading = false) => {
    state.agentFilesList = null;
    state.agentFilesError = null;
    state.agentFileActive = null;
    state.agentFileContents = {};
    state.agentFileDrafts = {};
    if (clearLoading) {
      state.agentFilesLoading = false;
    }
  };
  const resetAgentSelectionPanelState = () => {
    resetAgentFilesState(true);
    state.agentSkillsReport = null;
    state.agentSkillsError = null;
    state.agentSkillsAgentId = null;
    state.toolsCatalogResult = null;
    state.toolsCatalogError = null;
    state.toolsCatalogLoading = false;
    resetToolsEffectiveState(state);
  };
  if (
    isChat &&
    state.connected &&
    state.agentsList &&
    !chatWorkspaceFiles.loading &&
    !chatWorkspaceFiles.error &&
    chatWorkspaceFiles.list?.agentId !== chatAgentId
  ) {
    loadChatWorkspaceFiles();
  }
  const refreshChatWorkspaceFiles = () => {
    loadChatWorkspaceFiles({ force: true });
  };
  function loadChatWorkspaceFiles(opts?: { force?: boolean }) {
    if (!state.client || !state.connected || chatWorkspaceFiles.loading) {
      return;
    }
    const requestId = chatWorkspaceFiles.requestId + 1;
    chatWorkspaceFiles.requestId = requestId;
    chatWorkspaceFiles.loading = true;
    chatWorkspaceFiles.error = null;
    if (opts?.force) {
      chatWorkspaceFiles.list = null;
    }
    const requestState = chatWorkspaceFiles;
    void (async () => {
      try {
        const res = await state.client?.request<AgentsFilesListResult | null>("agents.files.list", {
          agentId: chatAgentId,
        });
        const current = currentChatWorkspaceFilesState();
        if (current !== requestState || current.requestId !== requestId) {
          return;
        }
        current.list = res ?? null;
        if (current.activeName && !res?.files.some((file) => file.name === current.activeName)) {
          current.activeName = null;
        }
      } catch (err) {
        const current = currentChatWorkspaceFilesState();
        if (current === requestState && current.requestId === requestId) {
          current.error = String(err);
        }
      } finally {
        const current = currentChatWorkspaceFilesState();
        if (current === requestState && current.requestId === requestId) {
          current.loading = false;
        }
        requestHostUpdate?.();
      }
    })();
  }
  const openChatWorkspaceFile = (name: string, filePath?: string) => {
    chatWorkspaceFiles.activeName = name;
    const previousRequest = chatWorkspaceFileOpenRequests.get(state);
    const openRequest = {
      agentId: chatAgentId,
      id: (previousRequest?.id ?? 0) + 1,
      name,
      sessionKey: state.sessionKey,
    };
    chatWorkspaceFileOpenRequests.set(state, openRequest);
    const isCurrentOpenRequest = () => {
      const currentRequest = chatWorkspaceFileOpenRequests.get(state);
      const currentFiles = currentChatWorkspaceFilesState();
      return (
        currentRequest?.id === openRequest.id &&
        currentRequest.agentId === resolveChatWorkspaceAgentId() &&
        currentRequest.name === name &&
        currentRequest.sessionKey === state.sessionKey &&
        currentFiles?.activeName === name
      );
    };
    const isMarkdownName = /\.(?:md|markdown|mdx)$/i.test(name);
    // Canonical identity key: explicit path, or workspace-prefixed for root
    // name-opens so identity checks compare like forms. Not a fetch param.
    const workspaceRoot = chatWorkspaceFiles.list?.workspace;
    const displayPath = filePath ?? (workspaceRoot ? `${workspaceRoot}/${name}` : undefined);
    // Keep-view identity must be CONFIDENT (a wrong "same" shows the wrong
    // file): both keys known and equal, or both unknown name-opens.
    const currentSameFile = () => {
      const prev = state.sidebarContent;
      if (prev?.kind !== "code" || prev.fileName !== name) {
        return null;
      }
      const same =
        prev.path && displayPath
          ? samePathConfident(prev.path, displayPath)
          : !prev.path && !displayPath;
      return same ? prev : null;
    };
    // Re-clicking the file already shown under a live overlay: keep the view
    // (the hold resolver refreshes it) and skip the fetch, but still re-open
    // the panel in case the click raced a close. Markdown always fetches (to
    // switch a code view of it to the rendered view).
    const prevEarly = isMarkdownName ? null : currentSameFile();
    if (prevEarly && (prevEarly.pendingEdit || prevEarly.editing)) {
      chatWorkspaceFiles.error = null;
      state.handleOpenSidebar(prevEarly);
      requestHostUpdate?.();
      return;
    }
    void (async () => {
      if (!state.client || !state.connected) {
        return;
      }
      chatWorkspaceFiles.error = null;
      // Freshness stamp is taken at fetch start: the fetched content reflects
      // the server no later than this, so edits completing mid-fetch count as
      // newer than it (they animate and their resolution refetch heals it).
      const openedAt = Date.now();
      try {
        const reqParams: Record<string, string> = { agentId: chatAgentId, name };
        if (filePath) {
          reqParams.path = filePath;
        }
        const res = await state.client.request<AgentsFilesGetResult | null>(
          "agents.files.get",
          reqParams,
        );
        const content = res?.file?.content;
        if (typeof content !== "string") {
          if (isCurrentOpenRequest()) {
            chatWorkspaceFiles.error = `Failed to load ${name}`;
            requestHostUpdate?.();
          }
          return;
        }
        if (!isCurrentOpenRequest()) {
          return;
        }
        if (isMarkdownName) {
          state.handleOpenSidebar({ kind: "markdown", content, rawText: content });
          return;
        }
        const cv = codeViewerState(state);
        const prevSameFile = currentSameFile();
        // Drop this read if a fresher resolver refetch already applied, or if
        // an overlay appeared mid-fetch (its match index is against the shown
        // content; the resolver refreshes it). Still re-open the panel.
        if (
          prevSameFile &&
          (cv.contentTime > openedAt || prevSameFile.pendingEdit || prevSameFile.editing)
        ) {
          state.handleOpenSidebar(prevSameFile);
          return;
        }
        state.handleOpenSidebar({
          kind: "code",
          fileName: name,
          // The server-canonical path (rail file.path comes from the same
          // source) is both the identity key and the refetch recipe: it is
          // absolute, so a refetch path.resolve()s to itself — exact and
          // independent of the gateway cwd, unlike replaying a relative or
          // name-only request that resolves against the workspace root.
          path: res?.file?.path || displayPath,
          agentId: chatAgentId,
          content,
          language: name.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "",
          rawText: content,
          reading: true,
        });
        cv.openTime = openedAt;
        cv.contentTime = openedAt;
        restartReadingWindow(cv);
      } catch (err) {
        if (isCurrentOpenRequest()) {
          chatWorkspaceFiles.error = String(err);
        }
      } finally {
        requestHostUpdate?.();
      }
    })();
  };

  return html`
    ${renderCommandPalette({
      open: state.paletteOpen,
      query: state.paletteQuery,
      activeIndex: state.paletteActiveIndex,
      onToggle: () => {
        state.paletteOpen = !state.paletteOpen;
      },
      onQueryChange: (q) => {
        state.paletteQuery = q;
      },
      onActiveIndexChange: (i) => {
        state.paletteActiveIndex = i;
      },
      onNavigate: (tab) => {
        state.setTab(tab as import("./navigation.ts").Tab);
      },
      onSlashCommand: (cmd) => {
        state.setTab("chat" as import("./navigation.ts").Tab);
        state.handleChatDraftChange(cmd.endsWith(" ") ? cmd : `${cmd} `);
      },
    })}
    <div
      class="shell ${isChat ? "shell--chat" : ""} ${navCollapsed
        ? "shell--nav-collapsed"
        : ""} ${navDrawerOpen ? "shell--nav-drawer-open" : ""} ${state.onboarding
        ? "shell--onboarding"
        : ""}"
      style=${styleMap(
        state.chatMessageMaxWidth ? { "--chat-message-max-width": state.chatMessageMaxWidth } : {},
      )}
    >
      <button
        type="button"
        class="shell-nav-backdrop"
        aria-label="${t("nav.collapse")}"
        @click=${() => {
          state.navDrawerOpen = false;
        }}
      ></button>
      <header
        class="topbar"
        ?inert=${state.onboarding}
        aria-hidden=${state.onboarding ? "true" : nothing}
      >
        <div class="topnav-shell">
          <button
            type="button"
            class="sidebar-menu-trigger topbar-nav-toggle"
            @click=${() => {
              state.navDrawerOpen = !navDrawerOpen;
            }}
            title="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-label="${navDrawerOpen ? t("nav.collapse") : t("nav.expand")}"
            aria-expanded=${navDrawerOpen}
          >
            <span class="nav-collapse-toggle__icon" aria-hidden="true">${icons.menu}</span>
          </button>
          <div class="topnav-shell__content">
            <dashboard-header
              .tab=${state.tab}
              .basePath=${state.basePath}
              .agentLabel=${dashboardHeaderContext.agentLabel}
              .breadcrumbSuffix=${state.tab === "chat"
                ? renderCollapsedChatTab(state, {
                    onNewSession: () => void createChatSession(state),
                  })
                : nothing}
              @navigate=${(event: CustomEvent<Tab>) => {
                state.setTab(event.detail);
              }}
            ></dashboard-header>
          </div>
          <div class="topnav-shell__actions">
            <button
              class="topbar-search"
              @click=${() => {
                state.paletteOpen = !state.paletteOpen;
              }}
              title=${t("chat.commandPaletteTitle")}
              aria-label=${t("chat.openCommandPalette")}
            >
              <span class="topbar-search__label">${t("common.search")}</span>
              <kbd class="topbar-search__kbd">⌘K</kbd>
            </button>
            <div class="topbar-status">${renderTopbarThemeModeToggle(state)}</div>
          </div>
        </div>
      </header>
      <div class="shell-nav">
        <aside class="sidebar ${navCollapsed ? "sidebar--collapsed" : ""}">
          <div class="sidebar-shell">
            <div class="sidebar-shell__header">
              <div class="sidebar-brand">
                ${navCollapsed
                  ? nothing
                  : html`
                      <img
                        class="sidebar-brand__logo"
                        src="${dashboardHeaderContext.agentAvatarUrl}"
                        alt="${dashboardHeaderContext.agentLabel}"
                      />
                      <span class="sidebar-brand__copy">
                        <span class="sidebar-brand__eyebrow">${t("nav.control")}</span>
                        <span class="sidebar-brand__title"
                          >${dashboardHeaderContext.agentLabel}</span
                        >
                      </span>
                    `}
              </div>
              <button
                type="button"
                class="nav-collapse-toggle"
                @click=${() =>
                  state.applySettings({
                    ...state.settings,
                    navCollapsed: !state.settings.navCollapsed,
                  })}
                title="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
                aria-label="${navCollapsed ? t("nav.expand") : t("nav.collapse")}"
              >
                <span class="nav-collapse-toggle__icon" aria-hidden="true"
                  >${navCollapsed ? icons.panelLeftOpen : icons.panelLeftClose}</span
                >
              </button>
            </div>
            <div class="sidebar-shell__body">
              ${renderSidebarSessions(state)}
              <nav class="sidebar-nav">
                ${TAB_GROUPS.map((group) => {
                  const isGroupCollapsed = state.settings.navGroupsCollapsed[group.label] ?? false;
                  const showItems = navCollapsed || !isGroupCollapsed;
                  const isChannelsGroup = group.label === "channels";

                  return html`
                    <section class="nav-section ${!showItems ? "nav-section--collapsed" : ""}">
                      ${!navCollapsed
                        ? html`
                            <button
                              class="nav-section__label"
                              @click=${() => {
                                const next = { ...state.settings.navGroupsCollapsed };
                                next[group.label] = !isGroupCollapsed;
                                state.applySettings({
                                  ...state.settings,
                                  navGroupsCollapsed: next,
                                });
                              }}
                              aria-expanded=${showItems}
                            >
                              <span class="nav-section__label-text"
                                >${t(`nav.${group.label}`)}</span
                              >
                              <span class="nav-section__chevron"> ${icons.chevronDown} </span>
                            </button>
                          `
                        : nothing}
                      <div class="nav-section__items">
                        ${isChannelsGroup
                          ? renderChannelsNavItems(state, navCollapsed)
                          : group.label === "chat"
                            ? // The chat session-switcher below is the single Chat
                              // entry; the plain nav link would duplicate it.
                              nothing
                            : group.tabs.map((tab) =>
                                renderTab(state, tab, { collapsed: navCollapsed }),
                              )}
                        ${group.label === "chat" ? renderSidebarChatNavControls(state) : nothing}
                      </div>
                    </section>
                  `;
                })}
              </nav>
            </div>
            <div class="sidebar-shell__footer">
              <div class="sidebar-utility-group">
                <a
                  class="nav-item nav-item--external sidebar-utility-link"
                  href="https://docs.openclaw.ai"
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                  title=${t("chat.docsOpensInNewTab", { label: t("common.docs") })}
                >
                  <span class="nav-item__icon" aria-hidden="true">${icons.book}</span>
                  ${!navCollapsed
                    ? html`
                        <span class="nav-item__text">${t("common.docs")}</span>
                        <span class="nav-item__external-icon">${icons.externalLink}</span>
                      `
                    : nothing}
                </a>
                <div class="sidebar-mode-switch">${renderTopbarThemeModeToggle(state)}</div>
                ${(() => {
                  const version = state.hello?.server?.version ?? "";
                  return version
                    ? html`
                        <div class="sidebar-version" title=${`v${version}`}>
                          ${!navCollapsed
                            ? html`
                                <span class="sidebar-version__label">${t("common.version")}</span>
                                <span class="sidebar-version__text">v${version}</span>
                                ${renderSidebarConnectionStatus(state)}
                              `
                            : html` ${renderSidebarConnectionStatus(state)} `}
                        </div>
                      `
                    : nothing;
                })()}
              </div>
            </div>
          </div>
        </aside>
      </div>
      <main
        class="content ${isChat ? "content--chat" : ""} ${state.tab === "logs"
          ? "content--logs"
          : ""} ${state.tab === "workboard" ? "content--workboard" : ""} ${state.tab === "rsil"
          ? "content--rsil"
          : ""} ${state.tab === "skillForge" ? `content--skill-forge` : ""}"
      >
        ${state.updateStatusBanner
          ? html`<div class="callout ${state.updateStatusBanner.tone}" role="alert">
              ${state.updateStatusBanner.text}
            </div>`
          : nothing}
        ${state.updateAvailable &&
        state.updateAvailable.latestVersion !== state.updateAvailable.currentVersion &&
        !isUpdateBannerDismissed(state.updateAvailable)
          ? html`<div class="update-banner callout danger" role="alert">
              <strong>${t("chat.updateAvailable")}</strong> v${state.updateAvailable.latestVersion}
              (${t("chat.runningVersion", { version: state.updateAvailable.currentVersion })}).
              <button
                class="btn btn--sm update-banner__btn"
                ?disabled=${state.updateRunning || !state.connected}
                @click=${() => runUpdate(state)}
              >
                ${state.updateRunning ? t("chat.updating") : t("chat.updateNow")}
              </button>
              <button
                class="update-banner__close"
                type="button"
                title=${t("common.dismiss")}
                aria-label=${t("chat.dismissUpdateBanner")}
                @click=${() => {
                  dismissUpdateBanner(state.updateAvailable);
                  state.updateAvailable = null;
                }}
              >
                ${icons.x}
              </button>
            </div>`
          : nothing}
        ${state.tab === "config" || isChat
          ? nothing
          : html`<section
              class=${chatHeaderHidden
                ? "content-header content-header--chat-hidden"
                : "content-header"}
              ?inert=${chatHeaderHidden}
              aria-hidden=${chatHeaderHidden ? "true" : nothing}
            >
              <div>
                <div class="page-title">${titleForTab(state.tab)}</div>
                <div class="page-sub">${subtitleForTab(state.tab)}</div>
              </div>
              ${state.tab === "workboard"
                ? html`<div class="workboard-header-agents">
                    ${renderPixelAgentsStrip(state.sessionsResult?.sessions ?? [], {
                      agentsList: state.agentsList,
                      client: state.client,
                      connected: state.connected,
                      canCreate: hasOperatorWriteAccess(
                        (state.hello as { auth?: { role?: string; scopes?: string[] } } | null)
                          ?.auth ?? null,
                      ),
                      defaultWorkspace: (
                        state.configSnapshot?.config as
                          | { agents?: { defaults?: { workspace?: string } } }
                          | undefined
                      )?.agents?.defaults?.workspace,
                      requestUpdate: () => state.requestUpdate?.(),
                      onAgentsChanged: () => void loadAgents(state),
                      onOpenAgent: (id: string) => {
                        state.selectedAgentId = id;
                        state.setTab("agents");
                      },
                    })}
                  </div>`
                : nothing}
              <div class="page-meta">
                ${state.tab === "dreams"
                  ? html`
                      <div class="dreaming-header-controls">
                        <button
                          class="btn btn--subtle btn--sm"
                          ?disabled=${dreamingLoading || state.dreamDiaryLoading}
                          @click=${refreshDreaming}
                        >
                          ${dreamingRefreshLoading
                            ? t("dreaming.header.refreshing")
                            : t("dreaming.header.refresh")}
                        </button>
                        <button
                          class="dreams__phase-toggle ${dreamingOn
                            ? "dreams__phase-toggle--on"
                            : ""}"
                          ?disabled=${dreamingLoading}
                          @click=${() => applyDreamingEnabled(!dreamingOn)}
                        >
                          <span class="dreams__phase-toggle-dot"></span>
                          <span class="dreams__phase-toggle-label">
                            ${dreamingOn ? t("dreaming.header.on") : t("dreaming.header.off")}
                          </span>
                        </button>
                      </div>
                    `
                  : nothing}
                ${headerError ? html`<div class="pill danger">${headerError}</div>` : nothing}
              </div>
            </section>`}
        ${state.tab === "modelProviders"
          ? renderModelProvidersTab({
              state: (state.modelProviders ??= createModelProvidersState()),
              connected: state.connected,
              canMutate: state.connected,
              onSelectProvider: (provider: string) => {
                const mp = (state.modelProviders ??= createModelProvidersState());
                mp.selectedProvider = provider;
                mp.notice = null;
                state.requestUpdate?.();
              },
              onKeyDraftChange: (value: string) => {
                const mp = (state.modelProviders ??= createModelProvidersState());
                mp.keyDraft = value;
                state.requestUpdate?.();
              },
              onSave: () => {
                const mp = (state.modelProviders ??= createModelProvidersState());
                void saveProviderApiKey(state, mp.selectedProvider, mp.keyDraft, () =>
                  loadConfig(state),
                );
              },
              onTest: (provider: string) => void probeProvider(state, provider),
              onRefresh: () => void loadModelProviders(state),
            })
          : nothing}
        ${state.tab === "overview"
          ? renderOverview({
              connected: state.connected,
              hello: state.hello,
              settings: state.settings,
              password: state.password,
              lastError: state.lastError,
              lastErrorCode: state.lastErrorCode,
              presenceCount,
              sessionsCount,
              cronEnabled: state.cronStatus?.enabled ?? null,
              cronNext,
              lastChannelsRefresh: state.channelsLastSuccess,
              warnQueryToken,
              modelAuthStatus: state.modelAuthStatusResult,
              usageResult: state.usageResult,
              sessionsResult: state.sessionsResult,
              skillsReport: state.skillsReport,
              cronJobs: state.cronJobs,
              cronStatus: state.cronStatus,
              attentionItems: state.attentionItems,
              eventLog: state.eventLog,
              overviewLogLines: state.overviewLogLines,
              showGatewayToken: state.overviewShowGatewayToken,
              showGatewayPassword: state.overviewShowGatewayPassword,
              generatingToken: state.overviewGeneratingToken,
              gatewayToken: state.overviewGatewayToken,
              showGatewayTokenValue: state.overviewShowGatewayTokenValue,
              onSettingsChange: (next) => state.applySettings(next),
              onPasswordChange: (next) => (state.password = next),
              onSessionKeyChange: (next) => {
                switchChatSession(state, next);
              },
              onToggleGatewayTokenVisibility: () => {
                state.overviewShowGatewayToken = !state.overviewShowGatewayToken;
              },
              onToggleGatewayPasswordVisibility: () => {
                state.overviewShowGatewayPassword = !state.overviewShowGatewayPassword;
              },
              onConnect: () => state.connect(),
              onRefresh: () => void state.loadOverview({ refresh: true }),
              onToggleGatewayTokenValue: () => {
                state.overviewShowGatewayTokenValue = !state.overviewShowGatewayTokenValue;
              },
              onCopyGatewayToken: (token) => {
                void globalThis.navigator?.clipboard?.writeText(token);
                state.updateStatusBanner = {
                  tone: "info",
                  text: "Gateway token copied to clipboard.",
                };
              },
              onGenerateGatewayToken: () => {
                void generateAndSaveGatewayToken(state).then((token) => {
                  if (token) {
                    // Reveal the fresh token in the field so the operator can copy it;
                    // the gateway never echoes a token back, so this is the only chance.
                    state.applySettings({ ...state.settings, token });
                    state.overviewShowGatewayToken = true;
                  }
                });
              },
              onNavigate: (tab) => state.setTab(tab as import("./navigation.ts").Tab),
              onRefreshLogs: () => void state.loadOverview({ refresh: true }),
            })
          : nothing}
        ${state.tab === "activity"
          ? renderLazyView(lazyActivity, (m) =>
              m.renderActivity({
                events: state.activityEvents,
                loading: state.activityLoading,
                error: state.activityError,
                hasMore: state.activityHasMore,
                filterText: state.activityFilterText,
                statusFilters: state.activityStatusFilters,
                kindFilter: state.activityKindFilter,
                agentFilter: state.activityAgentFilter,
                expandedIds: state.activityExpandedIds,
                autoFollow: state.activityAutoFollow,
                onFilterTextChange: (next) => (state.activityFilterText = next),
                onKindFilterChange: (next) => (state.activityKindFilter = next),
                onAgentFilterChange: (next) => (state.activityAgentFilter = next),
                onStatusToggle: (status, enabled) => {
                  state.activityStatusFilters = {
                    ...state.activityStatusFilters,
                    [status]: enabled,
                  };
                },
                onToggleAutoFollow: (next) => {
                  state.activityAutoFollow = next;
                  if (next) {
                    state.scheduleActivityScroll(true);
                  }
                },
                onClear: () => {
                  state.activityEvents = [];
                  state.activityExpandedIds = new Set();
                  state.activityAtBottom = true;
                },
                onRefresh: () => {
                  void loadActivity(state as unknown as ActivityControllerHost);
                },
                onLoadMore: () => {
                  void loadMoreActivity(state as unknown as ActivityControllerHost);
                },
                onExpandAll: (ids) => {
                  state.activityExpandedIds = new Set(ids);
                },
                onCollapseAll: () => {
                  state.activityExpandedIds = new Set();
                },
                onEntryToggle: (id, open) => {
                  const next = new Set(state.activityExpandedIds);
                  if (open) {
                    next.add(id);
                  } else {
                    next.delete(id);
                  }
                  state.activityExpandedIds = next;
                },
                onScroll: (event) => state.handleActivityScroll(event),
              }),
            )
          : nothing}
        ${state.tab === "instances"
          ? renderLazyView(lazyInstances, (m) =>
              m.renderInstances({
                loading: state.presenceLoading,
                entries: state.presenceEntries,
                lastError: state.presenceError,
                statusMessage: state.presenceStatus,
                onRefresh: () => void loadPresence(state),
              }),
            )
          : nothing}
        ${state.tab === "conversations"
          ? renderLazyView(lazyConversations, (m) =>
              m.renderConversations({
                loading: state.sessionsLoading,
                result: state.sessionsResult,
                error: state.sessionsError,
                basePath: state.basePath,
                searchQuery: state.conversationsSearchQuery,
                sourceFilter: state.conversationsSourceFilter,
                agentIdentityById: state.agentIdentityById,
                onSearchChange: (query) => {
                  state.conversationsSearchQuery = query;
                },
                onSourceFilterChange: (filter) => {
                  state.conversationsSourceFilter = filter;
                },
                onRefresh: () =>
                  void loadSessions(state, {
                    activeMinutes: 0,
                    includeGlobal: true,
                    includeUnknown: true,
                    configuredAgentsOnly: false,
                    showArchived: false,
                  }),
                onNavigateToChat: (sessionKey) => {
                  switchChatSession(state, sessionKey);
                  state.setTab("chat" as import("./navigation.ts").Tab);
                },
                onDelete: (sessionKey) => void deleteSessionsAndRefresh(state, [sessionKey]),
                mainSessionKey: resolveMainSessionKeyForState(state),
              }),
            )
          : nothing}
        ${state.tab === "sessions"
          ? renderLazyView(lazySessions, (m) => {
              const workboardState = getWorkboardState(state);
              // Workboard is a core module — enabled by default.
              const workboardEnabled = isPluginEnabledInConfigSnapshot(
                state.configSnapshot,
                "workboard",
                {
                  enabledByDefault: true,
                },
              );
              const operatorCanWrite = hasOperatorWriteAccess(
                (state.hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ??
                  null,
              );
              return m.renderSessions({
                loading: state.sessionsLoading,
                result: state.sessionsResult,
                error: state.sessionsError,
                activeMinutes: state.sessionsFilterActive,
                limit: state.sessionsFilterLimit,
                includeGlobal: state.sessionsIncludeGlobal,
                includeUnknown: state.sessionsIncludeUnknown,
                showArchived: state.sessionsShowArchived,
                filtersCollapsed: state.sessionsFiltersCollapsed,
                basePath: state.basePath,
                searchQuery: state.sessionsSearchQuery,
                agentIdentityById: state.agentIdentityById,
                sortColumn: state.sessionsSortColumn,
                sortDir: state.sessionsSortDir,
                page: state.sessionsPage,
                pageSize: state.sessionsPageSize,
                selectedKeys: state.sessionsSelectedKeys,
                workboardSessionKeys: new Set(
                  workboardState.cards
                    .flatMap((card) => [card.sessionKey, card.execution?.sessionKey])
                    .filter((key): key is string => typeof key === "string" && key.length > 0),
                ),
                workboardBusySessionKey: [...workboardState.capturingSessionKeys][0] ?? null,
                expandedCheckpointKey: state.sessionsExpandedCheckpointKey,
                checkpointItemsByKey: state.sessionsCheckpointItemsByKey,
                checkpointLoadingKey: state.sessionsCheckpointLoadingKey,
                checkpointBusyKey: state.sessionsCheckpointBusyKey,
                checkpointErrorByKey: state.sessionsCheckpointErrorByKey,
                onFiltersChange: (next) => {
                  state.sessionsFilterActive = next.activeMinutes;
                  state.sessionsFilterLimit = next.limit;
                  state.sessionsIncludeGlobal = next.includeGlobal;
                  state.sessionsIncludeUnknown = next.includeUnknown;
                  state.sessionsShowArchived = next.showArchived;
                  state.sessionsSelectedKeys = new Set();
                  state.sessionsPage = 0;
                  void loadSessions(state, {
                    activeMinutes: parseSessionsFilterInteger(next.activeMinutes),
                    limit: parseSessionsFilterInteger(next.limit),
                    includeGlobal: next.includeGlobal,
                    includeUnknown: next.includeUnknown,
                    showArchived: next.showArchived,
                  });
                },
                onToggleFiltersCollapsed: () => {
                  state.sessionsFiltersCollapsed = !state.sessionsFiltersCollapsed;
                },
                onClearFilters: () => {
                  state.sessionsFilterActive = "";
                  state.sessionsFilterLimit = "";
                  state.sessionsIncludeGlobal = true;
                  state.sessionsIncludeUnknown = true;
                  state.sessionsShowArchived = true;
                  state.sessionsSearchQuery = "";
                  state.sessionsSelectedKeys = new Set();
                  state.sessionsPage = 0;
                  void loadSessions(state, {
                    activeMinutes: 0,
                    limit: 0,
                    includeGlobal: true,
                    includeUnknown: true,
                    showArchived: true,
                  });
                },
                onSearchChange: (q) => {
                  state.sessionsSearchQuery = q;
                  state.sessionsPage = 0;
                },
                onSortChange: (col, dir) => {
                  state.sessionsSortColumn = col;
                  state.sessionsSortDir = dir;
                  state.sessionsPage = 0;
                },
                onPageChange: (p) => {
                  state.sessionsPage = p;
                },
                onPageSizeChange: (s) => {
                  state.sessionsPageSize = s;
                  state.sessionsPage = 0;
                },
                onRefresh: () => void loadSessions(state),
                onPatch: (key, patch) => void patchSession(state, key, patch),
                onToggleSelect: (key) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  if (next.has(key)) {
                    next.delete(key);
                  } else {
                    next.add(key);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onSelectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const k of keys) {
                    next.add(k);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectPage: (keys) => {
                  const next = new Set(state.sessionsSelectedKeys);
                  for (const k of keys) {
                    next.delete(k);
                  }
                  state.sessionsSelectedKeys = next;
                },
                onDeselectAll: () => {
                  state.sessionsSelectedKeys = new Set();
                },
                onDeleteSelected: runUiTask(async () => {
                  const keys = [...state.sessionsSelectedKeys];
                  const deleted = await deleteSessionsAndRefresh(state, keys);
                  if (deleted.length > 0) {
                    const next = new Set(state.sessionsSelectedKeys);
                    for (const k of deleted) {
                      next.delete(k);
                    }
                    state.sessionsSelectedKeys = next;
                  }
                }),
                onNavigateToChat: (sessionKey) => {
                  switchChatSession(state, sessionKey);
                  state.setTab("chat" as import("./navigation.ts").Tab);
                },
                onAddToWorkboard:
                  workboardEnabled && operatorCanWrite
                    ? runUiTask(async (session) => {
                        await captureSessionToWorkboard({
                          host: state,
                          client: state.client,
                          session,
                          requestUpdate: requestHostUpdate,
                        });
                        state.setTab("workboard" as import("./navigation.ts").Tab);
                      })
                    : undefined,
                onToggleCheckpointDetails: (sessionKey) =>
                  void toggleSessionCompactionCheckpoints(state, sessionKey),
                onBranchFromCheckpoint: runUiTask(async (sessionKey, checkpointId) => {
                  const nextKey = await branchSessionFromCheckpoint(
                    state,
                    sessionKey,
                    checkpointId,
                  );
                  if (nextKey) {
                    switchChatSession(state, nextKey);
                    state.setTab("chat" as import("./navigation.ts").Tab);
                  }
                }),
                onRestoreCheckpoint: (sessionKey, checkpointId) =>
                  void restoreSessionFromCheckpoint(state, sessionKey, checkpointId),
              });
            })
          : nothing}
        ${state.tab === "workboard"
          ? renderLazyView(lazyWorkboard, (m) => {
              const auth =
                (state.hello as { auth?: { role?: string; scopes?: string[] } } | null)?.auth ??
                null;
              return m.renderWorkboard({
                host: state,
                client: state.client,
                connected: state.connected,
                canWrite: hasOperatorWriteAccess(auth),
                canModelOverride: hasOperatorAdminAccess(auth),
                // Workboard is a core module — enabled by default.
                pluginEnabled: isPluginEnabledInConfigSnapshot(state.configSnapshot, "workboard", {
                  enabledByDefault: true,
                }),
                agentsList: state.agentsList,
                sessions: state.sessionsResult?.sessions ?? [],
                onOpenSession: (sessionKey) => {
                  switchChatSession(state, sessionKey);
                  state.setTab("chat" as import("./navigation.ts").Tab);
                },
                onRequestUpdate: requestHostUpdate,
              });
            })
          : nothing}
        ${renderUsageTab(state, lazyUsage)}
        ${state.tab === "vault"
          ? renderSettingsWorkspace(
              state,
              renderLazyView(
                lazyVault,
                () => html`<openclaw-vault-view .client=${state.client}></openclaw-vault-view>`,
              ),
            )
          : nothing}
        ${state.tab === "cron" ? renderCronQuickCreateForTab(state, requestHostUpdate) : nothing}
        ${state.tab === "cron"
          ? renderLazyView(lazyCron, (m) =>
              m.renderCron({
                basePath: state.basePath,
                loading: state.cronLoading,
                status: state.cronStatus,
                jobs: visibleCronJobs,
                jobsLoadingMore: state.cronJobsLoadingMore,
                jobsTotal: state.cronJobsTotal,
                jobsHasMore: state.cronJobsHasMore,
                jobsQuery: state.cronJobsQuery,
                jobsEnabledFilter: state.cronJobsEnabledFilter,
                jobsScheduleKindFilter: state.cronJobsScheduleKindFilter,
                jobsLastStatusFilter: state.cronJobsLastStatusFilter,
                jobsSortBy: state.cronJobsSortBy,
                jobsSortDir: state.cronJobsSortDir,
                editingJobId: state.cronEditingJobId,
                error: state.cronError,
                busy: state.cronBusy,
                form: state.cronForm,
                cronFormCollapsed: state.cronFormCollapsed,
                channels: state.channelsSnapshot?.channelMeta?.length
                  ? state.channelsSnapshot.channelMeta.map((entry) => entry.id)
                  : (state.channelsSnapshot?.channelOrder ?? []),
                channelLabels: state.channelsSnapshot?.channelLabels ?? {},
                channelMeta: state.channelsSnapshot?.channelMeta ?? [],
                runsJobId: state.cronRunsJobId,
                runs: state.cronRuns,
                runsTotal: state.cronRunsTotal,
                runsHasMore: state.cronRunsHasMore,
                runsLoadingMore: state.cronRunsLoadingMore,
                runsScope: state.cronRunsScope,
                runsStatuses: state.cronRunsStatuses,
                runsDeliveryStatuses: state.cronRunsDeliveryStatuses,
                runsStatusFilter: state.cronRunsStatusFilter,
                runsQuery: state.cronRunsQuery,
                runsSortDir: state.cronRunsSortDir,
                fieldErrors: state.cronFieldErrors,
                canSubmit: !hasCronFormErrors(state.cronFieldErrors),
                agentSuggestions: cronAgentSuggestions,
                modelSuggestions: cronModelSuggestions,
                thinkingSuggestions: CRON_THINKING_SUGGESTIONS,
                timezoneSuggestions: CRON_TIMEZONE_SUGGESTIONS,
                deliveryToSuggestions,
                accountSuggestions,
                onFormChange: (patch) => {
                  state.cronForm = normalizeCronFormState({ ...state.cronForm, ...patch });
                  state.cronFieldErrors = validateCronForm(state.cronForm);
                },
                onRefresh: () => void state.loadCron(),
                onAdd: () => {
                  void (async () => {
                    const saved = await addCronJob(state);
                    if (saved) {
                      state.cronFormCollapsed = true;
                    }
                    requestHostUpdate?.();
                  })();
                },
                onEdit: (job: CronJob) => {
                  state.cronFormCollapsed = false;
                  startCronEdit(state, job);
                },
                onClone: (job) => {
                  state.cronFormCollapsed = false;
                  startCronClone(state, job);
                },
                onCancelEdit: () => {
                  cancelCronEdit(state);
                  state.cronFormCollapsed = true;
                  requestHostUpdate?.();
                },
                onToggleFormCollapsed: (collapsed: boolean) => {
                  state.cronFormCollapsed = collapsed;
                  requestHostUpdate?.();
                },
                onToggle: (job, enabled) => void toggleCronJob(state, job, enabled),
                onRun: (job, mode) => void runCronJob(state, job.id, mode ?? "force"),
                onRemove: (job) => void removeCronJob(state, job),
                onQuickCreate: () => {
                  state.cronQuickCreateOpen = true;
                  state.cronQuickCreateStep = "what";
                  state.cronQuickCreateDraft = createDefaultDraft();
                  requestHostUpdate?.();
                },
                onLoadRuns: runUiTask(async (jobId) => {
                  updateCronRunsFilter(state, { cronRunsScope: "job" });
                  await loadCronRuns(state, jobId);
                }),
                onLoadMoreJobs: () =>
                  void loadCronJobsPage(state, { append: true, tableFilters: true }),
                onJobsFiltersChange: runUiTask(async (patch) => {
                  updateCronJobsFilter(state, patch);
                  const shouldReload =
                    typeof patch.cronJobsQuery === "string" ||
                    Boolean(patch.cronJobsEnabledFilter) ||
                    Boolean(patch.cronJobsScheduleKindFilter) ||
                    Boolean(patch.cronJobsLastStatusFilter) ||
                    Boolean(patch.cronJobsSortBy) ||
                    Boolean(patch.cronJobsSortDir);
                  if (shouldReload) {
                    await loadCronJobsPage(state, { append: false, tableFilters: true });
                  }
                }),
                onJobsFiltersReset: runUiTask(async () => {
                  updateCronJobsFilter(state, {
                    cronJobsQuery: "",
                    cronJobsEnabledFilter: "all",
                    cronJobsScheduleKindFilter: "all",
                    cronJobsLastStatusFilter: "all",
                    cronJobsTriggerFilter: "all",
                    cronJobsSortBy: "nextRunAtMs",
                    cronJobsSortDir: "asc",
                  });
                  await loadCronJobsPage(state, { append: false, tableFilters: true });
                }),
                onLoadMoreRuns: () => void loadMoreCronRuns(state),
                onRunsFiltersChange: runUiTask(async (patch) => {
                  updateCronRunsFilter(state, patch);
                  if (state.cronRunsScope === "all") {
                    await loadCronRuns(state, null);
                    return;
                  }
                  await loadCronRuns(state, state.cronRunsJobId);
                }),
                onNavigateToChat: (sessionKey) => {
                  switchChatSession(state, sessionKey);
                  state.setTab("chat" as import("./navigation.ts").Tab);
                },
              }),
            )
          : nothing}
        ${state.tab === "agents"
          ? renderLazyView(lazyAgents, (m) =>
              m.renderAgents({
                basePath: state.basePath ?? "",
                loading: state.agentsLoading,
                error: state.agentsError,
                agentsList: state.agentsList,
                selectedAgentId: resolvedAgentId,
                activePanel: state.agentsPanel,
                config: {
                  form: configValue,
                  loading: state.configLoading,
                  saving: state.configSaving,
                  dirty: state.configFormDirty,
                },
                channels: {
                  snapshot: state.channelsSnapshot,
                  loading: state.channelsLoading,
                  error: state.channelsError,
                  lastSuccess: state.channelsLastSuccess,
                },
                cron: {
                  status: state.cronStatus,
                  jobs: state.cronJobs,
                  loading: state.cronLoading,
                  error: state.cronError,
                },
                agentFiles: {
                  list: state.agentFilesList,
                  loading: state.agentFilesLoading,
                  error: state.agentFilesError,
                  active: state.agentFileActive,
                  contents: state.agentFileContents,
                  drafts: state.agentFileDrafts,
                  saving: state.agentFileSaving,
                },
                agentIdentityLoading: state.agentIdentityLoading,
                agentIdentityError: state.agentIdentityError,
                agentIdentityById: state.agentIdentityById,
                agentSkills: {
                  report: state.agentSkillsReport,
                  loading: state.agentSkillsLoading,
                  error: state.agentSkillsError,
                  agentId: state.agentSkillsAgentId,
                  filter: state.skillsFilter,
                },
                toolsCatalog: {
                  loading: state.toolsCatalogLoading,
                  error: state.toolsCatalogError,
                  result: state.toolsCatalogResult,
                },
                toolsEffective: {
                  loading: state.toolsEffectiveLoading,
                  error: state.toolsEffectiveError,
                  result: state.toolsEffectiveResult,
                },
                runtimeSessionKey: state.sessionKey,
                runtimeSessionMatchesSelectedAgent: toolsPanelUsesActiveSession,
                modelCatalog: state.chatModelCatalog ?? [],
                onRefresh: runUiTask(async () => {
                  await loadAgents(state);
                  const agentIds = state.agentsList?.agents?.map((entry) => entry.id) ?? [];
                  if (agentIds.length > 0) {
                    void loadAgentIdentities(state, agentIds);
                  }
                  loadAgentPanelDataForSelectedAgent(resolveSelectedAgentId());
                  refreshAgentsPanelSupplementalData(state.agentsPanel);
                }),
                onSelectAgent: (agentId) => {
                  if (state.agentsSelectedId === agentId) {
                    return;
                  }
                  state.agentsSelectedId = agentId;
                  resetAgentSelectionPanelState();
                  void loadAgentIdentity(state, agentId);
                  loadAgentPanelDataForSelectedAgent(agentId);
                },
                onSelectPanel: (panel) => {
                  state.agentsPanel = panel;
                  if (
                    panel === "files" &&
                    resolvedAgentId &&
                    state.agentFilesList?.agentId !== resolvedAgentId
                  ) {
                    resetAgentFilesState();
                    void loadAgentFiles(state, resolvedAgentId);
                  }
                  if (panel === "skills" && resolvedAgentId) {
                    void loadAgentSkills(state, resolvedAgentId);
                  }
                  if (panel === "tools" && resolvedAgentId) {
                    if (
                      state.toolsCatalogResult?.agentId !== resolvedAgentId ||
                      state.toolsCatalogError
                    ) {
                      void loadToolsCatalog(state, resolvedAgentId);
                    }
                    if (resolvedAgentId === chatAgentId) {
                      const toolsRequestKey = buildToolsEffectiveRequestKey(state, {
                        agentId: resolvedAgentId,
                        sessionKey: state.sessionKey,
                      });
                      if (
                        state.toolsEffectiveResultKey !== toolsRequestKey ||
                        state.toolsEffectiveError
                      ) {
                        void loadToolsEffective(state, {
                          agentId: resolvedAgentId,
                          sessionKey: state.sessionKey,
                        });
                      }
                    } else {
                      resetToolsEffectiveState(state);
                    }
                  }
                  refreshAgentsPanelSupplementalData(panel);
                },
                onLoadFiles: (agentId) => void loadAgentFiles(state, agentId),
                onSelectFile: (name) => {
                  state.agentFileActive = name;
                  if (!resolvedAgentId) {
                    return;
                  }
                  void loadAgentFileContent(state, resolvedAgentId, name);
                },
                onFileDraftChange: (name, content) => {
                  state.agentFileDrafts = { ...state.agentFileDrafts, [name]: content };
                },
                onFileReset: (name) => {
                  const base = state.agentFileContents[name] ?? "";
                  state.agentFileDrafts = { ...state.agentFileDrafts, [name]: base };
                },
                onFileSave: (name) => {
                  if (!resolvedAgentId) {
                    return;
                  }
                  const content =
                    state.agentFileDrafts[name] ?? state.agentFileContents[name] ?? "";
                  void saveAgentFile(state, resolvedAgentId, name, content);
                },
                onToolsProfileChange: (agentId, profile, clearAllow) => {
                  const basePathItem = resolveAgentToolsPath(
                    agentId,
                    Boolean(profile || clearAllow),
                  );
                  if (!basePathItem) {
                    return;
                  }
                  if (profile) {
                    updateConfigFormValue(state, [...basePathItem, "profile"], profile);
                  } else {
                    removeConfigFormValue(state, [...basePathItem, "profile"]);
                  }
                  if (clearAllow) {
                    removeConfigFormValue(state, [...basePathItem, "allow"]);
                  }
                },
                onToolsOverridesChange: (agentId, alsoAllow, deny) => {
                  const basePathCandidate = resolveAgentToolsPath(
                    agentId,
                    alsoAllow.length > 0 || deny.length > 0,
                  );
                  if (!basePathCandidate) {
                    return;
                  }
                  if (alsoAllow.length > 0) {
                    updateConfigFormValue(state, [...basePathCandidate, "alsoAllow"], alsoAllow);
                  } else {
                    removeConfigFormValue(state, [...basePathCandidate, "alsoAllow"]);
                  }
                  if (deny.length > 0) {
                    updateConfigFormValue(state, [...basePathCandidate, "deny"], deny);
                  } else {
                    removeConfigFormValue(state, [...basePathCandidate, "deny"]);
                  }
                },
                onConfigReload: () => void loadConfig(state, { discardPendingChanges: true }),
                onConfigSave: () => void saveAgentsConfig(state),
                onChannelsRefresh: () => void loadChannels(state, false),
                onCronRefresh: () => void state.loadCron(),
                onCronRunNow: (jobId) => {
                  const job = state.cronJobs.find((entry) => entry.id === jobId);
                  if (!job) {
                    return;
                  }
                  void runCronJob(state, job.id, "force");
                },
                onSkillsFilterChange: (next) => (state.skillsFilter = next),
                onSkillsRefresh: () => {
                  if (resolvedAgentId) {
                    void loadAgentSkills(state, resolvedAgentId);
                  }
                },
                onAgentSkillToggle: (agentId, skillName, enabled) => {
                  const index = ensureAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  const list = (getCurrentConfigValue() as { agents?: { list?: unknown[] } } | null)
                    ?.agents?.list;
                  const entry = Array.isArray(list)
                    ? (list[index] as { skills?: unknown })
                    : undefined;
                  const normalizedSkill = skillName.trim();
                  if (!normalizedSkill) {
                    return;
                  }
                  const allSkills =
                    state.agentSkillsReport?.skills?.map((skill) => skill.name).filter(Boolean) ??
                    [];
                  const existing = Array.isArray(entry?.skills)
                    ? normalizeStringEntries(entry.skills)
                    : undefined;
                  const base = existing ?? allSkills;
                  const next = new Set(base);
                  if (enabled) {
                    next.add(normalizedSkill);
                  } else {
                    next.delete(normalizedSkill);
                  }
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], [...next]);
                },
                onAgentSkillsClear: (agentId) => {
                  const index = findAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  removeConfigFormValue(state, ["agents", "list", index, "skills"]);
                },
                onAgentSkillsDisableAll: (agentId) => {
                  const index = ensureAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  updateConfigFormValue(state, ["agents", "list", index, "skills"], []);
                },
                onModelChange: (agentId, modelId) => {
                  const index = modelId ? ensureAgentIndex(agentId) : findAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  const modelEntry = resolveAgentModelFormEntry(index);
                  const { basePath: basePathEntry, existing } = modelEntry;
                  if (!modelId) {
                    removeConfigFormValue(state, basePathEntry);
                  } else if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                    const fallbacks = (existing as { fallbacks?: unknown }).fallbacks;
                    const next = {
                      primary: modelId,
                      ...(Array.isArray(fallbacks) ? { fallbacks } : {}),
                    };
                    updateConfigFormValue(state, basePathEntry, next);
                  } else {
                    updateConfigFormValue(state, basePathEntry, modelId);
                  }
                  void refreshVisibleToolsEffectiveForCurrentSession(state);
                },
                onThinkingDefaultChange: (agentId, level) => {
                  const index = level ? ensureAgentIndex(agentId) : findAgentIndex(agentId);
                  if (index < 0) {
                    return;
                  }
                  const path = ["agents", "list", index, "thinkingDefault"] as Array<
                    string | number
                  >;
                  if (!level) {
                    removeConfigFormValue(state, path);
                  } else {
                    updateConfigFormValue(state, path, level);
                  }
                },
                onModelFallbacksChange: (agentId, fallbacks) => {
                  const normalized = normalizeStringEntries(fallbacks);
                  const currentConfig = getCurrentConfigValue();
                  const resolvedConfig = resolveAgentConfig(currentConfig, agentId);
                  const effectivePrimary =
                    resolveModelPrimary(resolvedConfig.entry?.model) ??
                    resolveModelPrimary(resolvedConfig.defaults?.model);
                  const effectiveFallbacks = resolveEffectiveModelFallbacks(
                    resolvedConfig.entry?.model,
                    resolvedConfig.defaults?.model,
                  );
                  const index =
                    normalized.length > 0
                      ? effectivePrimary
                        ? ensureAgentIndex(agentId)
                        : -1
                      : (effectiveFallbacks?.length ?? 0) > 0 || findAgentIndex(agentId) >= 0
                        ? ensureAgentIndex(agentId)
                        : -1;
                  if (index < 0) {
                    return;
                  }
                  const { basePath: basePathResult, existing } = resolveAgentModelFormEntry(index);
                  const resolvePrimary = () => {
                    if (typeof existing === "string") {
                      return existing.trim() || null;
                    }
                    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
                      const primary = (existing as { primary?: unknown }).primary;
                      if (typeof primary === "string") {
                        const trimmed = primary.trim();
                        return trimmed || null;
                      }
                    }
                    return null;
                  };
                  const primary = resolvePrimary() ?? effectivePrimary;
                  if (normalized.length === 0) {
                    if (primary) {
                      updateConfigFormValue(state, basePathResult, primary);
                    } else {
                      removeConfigFormValue(state, basePathResult);
                    }
                    return;
                  }
                  if (!primary) {
                    return;
                  }
                  updateConfigFormValue(state, basePathResult, { primary, fallbacks: normalized });
                },
                onSetDefault: (agentId) => {
                  stageDefaultAgentConfigEntry(state, agentId);
                },
              }),
            )
          : nothing}
        ${state.tab === "skills"
          ? renderLazyView(lazySkills, (m) =>
              m.renderSkills({
                connected: state.connected,
                loading: state.skillsLoading,
                report: state.skillsReport,
                agentsList: state.agentsList,
                selectedAgentId: state.skillsAgentId ?? state.agentsList?.defaultId ?? null,
                error: state.skillsError,
                filter: state.skillsFilter,
                statusFilter: state.skillsStatusFilter,
                edits: state.skillEdits,
                messages: state.skillMessages,
                operation: state.skillOperation,
                detailKey: state.skillsDetailKey,
                detailTab: state.skillsDetailTab,
                clawhubVerdicts: state.clawhubVerdicts,
                clawhubVerdictsLoading: state.clawhubVerdictsLoading,
                clawhubVerdictsError: state.clawhubVerdictsError,
                skillCardContents: state.skillCardContents,
                skillCardLoadingKey: state.skillCardLoadingKey,
                skillCardErrors: state.skillCardErrors,
                clawhubQuery: state.clawhubSearchQuery,
                clawhubResults: state.clawhubSearchResults,
                clawhubSearchLoading: state.clawhubSearchLoading,
                clawhubSearchError: state.clawhubSearchError,
                clawhubDetail: state.clawhubDetail,
                clawhubDetailSlug: state.clawhubDetailSlug,
                clawhubDetailLoading: state.clawhubDetailLoading,
                clawhubDetailError: state.clawhubDetailError,
                clawhubInstallMessage: state.clawhubInstallMessage,
                onAgentChange: (agentId) => {
                  setSkillsAgentId(state, agentId);
                  void loadSkills(state, { clearMessages: true });
                },
                onFilterChange: (next) => (state.skillsFilter = next),
                onStatusFilterChange: (next) => (state.skillsStatusFilter = next),
                onRefresh: () => {
                  void (async () => {
                    await loadAgents(state);
                    reconcileSkillsAgentId(state, state.agentsList);
                    await loadSkills(state, { clearMessages: true });
                  })();
                },
                onToggle: (key, enabled) => void updateSkillEnabled(state, key, enabled),
                onEdit: (key, value) => updateSkillEdit(state, key, value),
                onSaveKey: (key) => void saveSkillApiKey(state, key),
                onInstall: (skillKey, name, installId) =>
                  void installSkill(state, skillKey, name, installId),
                onDetailOpen: (key) => {
                  state.skillsDetailKey = key;
                  state.skillsDetailTab = "overview";
                },
                onDetailClose: () => (state.skillsDetailKey = null),
                onDetailTabChange: (tab) => {
                  state.skillsDetailTab = tab;
                  if (tab === "card" && state.skillsDetailKey) {
                    void loadSkillCard(state, state.skillsDetailKey);
                  }
                },
                onClawHubQueryChange: (query) => {
                  setClawHubSearchQuery(state, query);
                  if (clawhubSearchTimer) {
                    clearTimeout(clawhubSearchTimer);
                  }
                  clawhubSearchTimer = setTimeout(() => {
                    void searchClawHub(state, query);
                  }, 300);
                },
                onClawHubDetailOpen: (slug) => void loadClawHubDetail(state, slug),
                onClawHubDetailClose: () => closeClawHubDetail(state),
                onClawHubInstall: (slug, acknowledgeClawHubRisk, version) =>
                  void installFromClawHub(state, slug, acknowledgeClawHubRisk, version),
              }),
            )
          : nothing}
        ${state.tab === "skillForge"
          ? renderLazyView(lazySkillForge, (m) => {
              return m.renderSkillForge({
                skillForgeLoading: state.skillForgeLoading,
                skillForgeLoaded: state.skillForgeLoaded,
                skillForgeError: state.skillForgeError,
                skillForgeStatus: state.skillForgeStatus,
                skillForgeSelectedName: state.skillForgeSelectedName,
                skillForgeRunBusy: state.skillForgeRunBusy,
                skillForgeActionBusy: state.skillForgeActionBusy,
                skillForgeActionNotice: state.skillForgeActionNotice,
                skillForgeFilter: state.skillForgeFilter,
                skillForgeQuery: state.skillForgeQuery,
                skillForgeMode: state.skillForgeMode,
                skillForgeQueueWidth: state.skillForgeQueueWidth,
                onRunPipeline: () => void runForgePipeline(state),
                onPromote: (name: string) => void promoteSkill(state, name),
                onRetire: (name: string) => void retireSkill(state, name),
                onDecaySweep: () => void runDecaySweep(state),
                onSelect: (name: string) => selectSkillForge(state, name),
                onFilterChange: (filter) => {
                  state.skillForgeFilter = filter;
                },
                onQueryChange: (query) => {
                  state.skillForgeQuery = query;
                },
                onModeChange: (mode) => setSkillForgeModeLocal(state, mode),
                onQueueWidthChange: (width) => (state.skillForgeQueueWidth = width),
              });
            })
          : nothing}
        ${state.tab === "nodes"
          ? renderLazyView(lazyNodes, (m) =>
              m.renderNodes({
                loading: state.nodesLoading,
                nodes: state.nodes,
                devicesLoading: state.devicesLoading,
                devicesError: state.devicesError,
                devicesList: state.devicesList,
                configForm:
                  state.configForm ??
                  (state.configSnapshot?.config as Record<string, unknown> | null),
                configLoading: state.configLoading,
                configSaving: state.configSaving,
                configDirty: state.configFormDirty,
                configFormMode: state.configFormMode,
                execApprovalsLoading: state.execApprovalsLoading,
                execApprovalsSaving: state.execApprovalsSaving,
                execApprovalsDirty: state.execApprovalsDirty,
                execApprovalsSnapshot: state.execApprovalsSnapshot,
                execApprovalsForm: state.execApprovalsForm,
                execApprovalsSelectedAgent: state.execApprovalsSelectedAgent,
                execApprovalsTarget: state.execApprovalsTarget,
                execApprovalsTargetNodeId: state.execApprovalsTargetNodeId,
                onRefresh: () => void loadNodes(state),
                onDevicesRefresh: () => void loadDevices(state),
                onDeviceApprove: (requestId) => void approveDevicePairing(state, requestId),
                onDeviceReject: (requestId) => void rejectDevicePairing(state, requestId),
                onDeviceRotate: (deviceId: string, role: string, scopes?: string[]) =>
                  void rotateDeviceToken(state, { deviceId, role, scopes }),
                onDeviceRevoke: (deviceId, role) =>
                  void revokeDeviceToken(state, { deviceId, role }),
                onDeviceRemove: (deviceId) => void removePairedDeviceEntry(state, deviceId),
                onRemoveOtherDevices: () => void removeOtherPairedDevices(state),
                onLoadConfig: () => void loadConfig(state, { discardPendingChanges: true }),
                onLoadExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  void loadExecApprovals(state, target);
                },
                onBindDefault: (nodeId) => {
                  if (nodeId) {
                    updateConfigFormValue(state, ["tools", "exec", "node"], nodeId);
                  } else {
                    removeConfigFormValue(state, ["tools", "exec", "node"]);
                  }
                },
                onBindAgent: (agentIndex, nodeId) => {
                  const basePathLocal = ["agents", "list", agentIndex, "tools", "exec", "node"];
                  if (nodeId) {
                    updateConfigFormValue(state, basePathLocal, nodeId);
                  } else {
                    removeConfigFormValue(state, basePathLocal);
                  }
                },
                onSaveBindings: () => void saveConfig(state),
                onExecApprovalsTargetChange: (kind, nodeId) => {
                  state.execApprovalsTarget = kind;
                  state.execApprovalsTargetNodeId = nodeId;
                  state.execApprovalsSnapshot = null;
                  state.execApprovalsForm = null;
                  state.execApprovalsDirty = false;
                  state.execApprovalsSelectedAgent = null;
                },
                onExecApprovalsSelectAgent: (agentId) => {
                  state.execApprovalsSelectedAgent = agentId;
                },
                onExecApprovalsPatch: (path, value) =>
                  updateExecApprovalsFormValue(state, path, value),
                onExecApprovalsRemove: (path) => removeExecApprovalsFormValue(state, path),
                onSaveExecApprovals: () => {
                  const target =
                    state.execApprovalsTarget === "node" && state.execApprovalsTargetNodeId
                      ? { kind: "node" as const, nodeId: state.execApprovalsTargetNodeId }
                      : { kind: "gateway" as const };
                  void saveExecApprovals(state, target);
                },
              }),
            )
          : nothing}
        ${(() => {
          // Scan both history messages AND live tool-stream messages
          // so active-file detection works during a running agent turn.
          const allMessages = chatWorkspaceFiles.list?.workspace
            ? [...state.chatMessages, ...state.chatToolMessages]
            : [];
          const workspace = chatWorkspaceFiles.list?.workspace;
          // The agent's tool cwd is its workspace root, so relative tool-arg
          // paths resolve against it. Prefer the loaded files-list workspace;
          // fall back to the agents.list row so the edit scan can resolve paths
          // even before the files list has loaded.
          const workspaceRoot =
            workspace ?? state.agentsList?.agents.find((a) => a.id === chatAgentId)?.workspace;

          // When the active directory changes, fetch its file listing
          const activeFile = workspace
            ? resolveActiveFileFromMessages(allMessages, workspace)
            : null;
          const dir = activeFile?.dir ?? null;
          if (dir && dir !== chatWorkspaceFiles.activeDir && state.client && state.connected) {
            chatWorkspaceFiles.activeDir = dir;
            void (async () => {
              try {
                const res = await state.client?.request<AgentsFilesListResult | null>(
                  "agents.files.list",
                  { agentId: chatAgentId, path: dir },
                );
                if (chatWorkspaceFiles.activeDir === dir) {
                  chatWorkspaceFiles.activeDirFiles = res?.activeDirFiles ?? res?.files ?? null;
                  requestHostUpdate?.();
                }
              } catch {
                // ignore — active dir listing is best-effort
              }
            })();
          }

          // Auto-preview: when agent reads a file, open it in the sidebar
          if (
            activeFile?.fileName &&
            activeFile.toolName === "read" &&
            state.client &&
            state.connected
          ) {
            const rawKey = activeFile.path;
            const lastAutoPreviewed = autoPreviewedFile.get(state);
            if (lastAutoPreviewed !== rawKey) {
              autoPreviewedFile.set(state, rawKey);
              // Resolve a relative arg against the workspace root before fetching
              // so agents.files.get receives an absolute path — the PATH branch
              // resolves it to itself, independent of the gateway process cwd
              // (a bare relative key would resolve against the wrong directory).
              const fetchPath = resolveAgentArgPath(rawKey, workspaceRoot) ?? rawKey;
              // Defer to avoid mutating state during render.
              queueMicrotask(() => openChatWorkspaceFile(activeFile.fileName, fetchPath));
            }
          }

          // Auto-open: when agent writes a file not currently shown in sidebar,
          // open it directly from the write tool args (no fetch needed).
          // Suppress only on a CONFIDENT same-path match: guessing "same" here
          // hides a genuinely different same-named file, while guessing
          // "different" merely re-opens the shown file with its write content.
          if (activeFile?.fileName && activeFile.toolName === "write") {
            const rawKey = activeFile.path;
            // Resolve against the workspace root so the stored path is absolute
            // and the edit-hold resolver can refetch it exactly.
            const resolvedPath = resolveAgentArgPath(rawKey, workspaceRoot);
            const shown = state.sidebarContent;
            // Same-file suppression: confident absolute-path match when both
            // sides resolve (a relative write to the shown file now suppresses);
            // bare fileName equality only when no root is known to resolve.
            const shownSameFile =
              shown?.kind === "code" &&
              (resolvedPath && shown.path
                ? samePathConfident(resolvedPath, shown.path)
                : shown.fileName === activeFile.fileName);
            const lastAutoPreviewed = autoPreviewedFile.get(state);
            if (!shownSameFile && lastAutoPreviewed !== rawKey) {
              // The write's full content is in its call args (only the result
              // streams later), so match on args alone — no output wait, so no
              // unbounded "pending" rescan every render tick.
              let writeContent: string | undefined;
              let writeCompletedAt = 0;
              for (const entry of state.toolStreamById.values()) {
                if (entry.name !== "write") {
                  continue;
                }
                const a = entry.args as Record<string, unknown> | undefined;
                const fp = String(a?.path ?? a?.file_path ?? a?.filePath ?? "");
                if (fp !== rawKey || typeof a?.content !== "string") {
                  continue;
                }
                writeContent = a.content;
                writeCompletedAt = entry.updatedAt;
                break;
              }
              // Burn the key either way: found → open once; not found (entry
              // evicted or history-only) → stop rescanning the whole stream.
              autoPreviewedFile.set(state, rawKey);
              if (writeContent != null) {
                const ext =
                  activeFile.fileName.match(/\.([a-z0-9_-]+)$/i)?.[1]?.toLowerCase() ?? "";
                state.handleOpenSidebar({
                  kind: "code",
                  fileName: activeFile.fileName,
                  // Absolute path resolved from the workspace root — a reliable
                  // server refetch recipe (path.resolve of an absolute path is
                  // itself), so the edit-hold resolver refetches fresh content
                  // instead of stranding the written snapshot.
                  path: resolvedPath ?? undefined,
                  agentId: chatAgentId,
                  content: writeContent,
                  language: ext,
                  rawText: writeContent,
                  reading: true,
                });
                // The args snapshot reflects the file as of the write's
                // completion, not display time — an edit landing between the
                // two must still count as newer so it animates and refreshes.
                const cv = codeViewerState(state);
                cv.openTime = writeCompletedAt;
                cv.contentTime = writeCompletedAt;
                restartReadingWindow(cv);
                requestHostUpdate?.();
              }
            }
          }

          // Update reading state on code sidebar content
          // The read tool completes almost instantly, so we use a minimum
          // display duration for the reading animation (1.5s).
          if (state.sidebarContent?.kind === "code") {
            const sc = state.sidebarContent;
            if (sc.reading) {
              const cv = codeViewerState(state);
              const elapsed = Date.now() - cv.readingStart;
              if (elapsed > 2500) {
                state.sidebarContent = { ...sc, reading: false };
              } else if (!cv.readingTimer) {
                // Schedule the flip to non-reading state
                cv.readingTimer = setTimeout(() => {
                  cv.readingTimer = null;
                  if (state.sidebarContent?.kind === "code" && state.sidebarContent.reading) {
                    state.sidebarContent = { ...state.sidebarContent, reading: false };
                    requestHostUpdate?.();
                  }
                }, 2500 - elapsed);
              }
            }
          }

          // Detect edits on the open file — catch recently-completed edits
          // (they complete too fast to catch in-progress)
          if (state.sidebarContent?.kind === "code") {
            const sc = state.sidebarContent;
            const cv = codeViewerState(state);
            const now = Date.now();
            // If we're already showing a pending edit, check if it's time to resolve
            if (sc.pendingEdit || sc.editing) {
              if (now - cv.editTime > 3000 && !cv.editResolving) {
                // Hold period over — refetch fresh content and clear the
                // overlay. The latch keeps this to one fetch per hold even
                // though the check re-runs every render tick.
                cv.editResolving = true;
                if (cv.editTimer) {
                  clearTimeout(cv.editTimer);
                  cv.editTimer = null;
                }
                const resolvingCallId = sc.pendingEdit?.callId ?? null;
                const fileName = sc.fileName;
                const filePathAtSchedule = sc.path;
                // Refetch by the canonical absolute path against the owning
                // agent (sc.agentId — the current chat may have moved on by
                // resolve time). No absolute path means the view came from a
                // relative-path write's args with no server-resolvable path:
                // refetching by name would read the wrong workspace-root file,
                // so keep the written content (correct for the write; a later
                // edit to this rare path-less view will not reflect on hold).
                const refetchPath = sc.path && sc.path.startsWith("/") ? sc.path : undefined;
                const fetchStart = now;
                // Apply only while this edit still owns the overlay: a newer
                // edit restarts the hold and its own resolution refreshes.
                // Same view = our own constructors wrote it: strict equality.
                const currentIfStillOwned = () => {
                  const cur = state.sidebarContent;
                  if (
                    cur?.kind !== "code" ||
                    cur.fileName !== fileName ||
                    cur.path !== filePathAtSchedule
                  ) {
                    return null;
                  }
                  return (cur.pendingEdit?.callId ?? null) === resolvingCallId ? cur : null;
                };
                const resolvingAgentId = sc.agentId;
                queueMicrotask(async () => {
                  try {
                    if (!refetchPath) {
                      const cur = currentIfStillOwned();
                      if (cur) {
                        state.sidebarContent = { ...cur, ...overlayCleared };
                      }
                      return;
                    }
                    let fresh: string | undefined;
                    try {
                      const result = await state.client?.request<{
                        file?: { content?: string };
                      } | null>("agents.files.get", {
                        agentId: resolvingAgentId,
                        name: fileName,
                        path: refetchPath,
                      });
                      fresh = result?.file?.content;
                    } catch {
                      // Treated as unreadable: same retry budget below.
                    }
                    const cur = currentIfStillOwned();
                    if (!cur) {
                      return;
                    }
                    if (fresh == null && cv.editRetries < 2) {
                      // Unreadable/RPC blip: retry a few paced holds. The hold
                      // re-arm keeps finally()'s tick from re-entering at once.
                      cv.editRetries += 1;
                      armEditHold(cv, requestHostUpdate);
                      return;
                    }
                    // Retries exhausted (a >500KB file the path branch caps, a
                    // transient blip): keep the last-known content and just end
                    // the hold. No error banner — every error surface here
                    // replaces the whole viewer, and a slightly-stale file
                    // beats hiding it; a manual reopen re-reads uncapped.
                    if (fresh != null) {
                      cv.contentTime = fetchStart;
                      state.sidebarContent = { ...cur, ...overlayCleared, content: fresh };
                    } else {
                      state.sidebarContent = { ...cur, ...overlayCleared };
                    }
                  } finally {
                    // Always release + re-render: another overlay's hold may
                    // have been skipped while this latch was held.
                    cv.editResolving = false;
                    requestHostUpdate?.();
                  }
                });
              }
            } else {
              // No active edit — clear any orphaned edit timer
              if (cv.editTimer) {
                clearTimeout(cv.editTimer);
                cv.editTimer = null;
              }
              // One committer for the edit/write overlay so the content shape
              // and the reading-timer kill stay paired.
              const showEditOverlay = (pendingEdit: PendingEdit) => {
                state.sidebarContent = { ...sc, editing: true, reading: false, pendingEdit };
                if (cv.readingTimer) {
                  clearTimeout(cv.readingTimer);
                  cv.readingTimer = null;
                }
              };
              // Scan for recently-completed edits/writes on this file
              for (const entry of state.toolStreamById.values()) {
                if (
                  entry.name !== "edit" &&
                  entry.name !== "apply_patch" &&
                  entry.name !== "write"
                ) {
                  continue;
                }
                if (!entry.output) {
                  continue;
                }
                if (entry.codeViewerAnimated) {
                  continue;
                }
                const args = entry.args as Record<string, unknown> | undefined;
                const entryPath = String(args?.path ?? args?.file_path ?? args?.filePath ?? "");
                // Prefer exact absolute-path identity so an edit to a same-named
                // file in another directory does not paint a phantom diff on the
                // shown sibling; fall back to the generous basename match only
                // when the arg can't be resolved (no root yet) or the open file
                // has no known path.
                const resolvedEntryPath = resolveAgentArgPath(entryPath, workspaceRoot);
                const matches =
                  resolvedEntryPath && sc.path
                    ? samePathConfident(resolvedEntryPath, sc.path)
                    : entryPathMatchesOpenFile(entryPath, sc.fileName);
                if (!matches) {
                  continue;
                }
                // Each call animates at most once, even though this scan re-runs
                // every render tick and revisits completed entries.
                entry.codeViewerAnimated = true;
                // Edits that finished before this file was opened are already in
                // the displayed content; animating them would replay stale
                // diffs. Equal stamps animate (same-ms tool batches) — a
                // redundant animation heals itself; a skipped one is lost.
                if (entry.updatedAt < cv.openTime) {
                  continue;
                }
                let overlaid = false;
                if (entry.name === "edit") {
                  const edits = Array.isArray(args?.edits) ? args.edits : [];
                  const removed: string[] = [];
                  const added: string[] = [];
                  for (const e of edits) {
                    if (typeof e?.oldText === "string") {
                      removed.push(...e.oldText.split("\n"));
                    }
                    if (typeof e?.newText === "string") {
                      added.push(...e.newText.split("\n"));
                    }
                  }
                  if (removed.length || added.length) {
                    // Find where the edit landed in the current file content.
                    // Content may already be refreshed (post-edit), so search for added lines first,
                    // then fall back to removed lines if content is still old.
                    let matchLineIndex: number | undefined;
                    const fileLines = sc.content.split("\n");
                    if (fileLines.length > 1 && fileLines[fileLines.length - 1]?.trim() === "") {
                      fileLines.pop();
                    }
                    // Try added lines first (content is post-edit)
                    const firstAdded = added[0]?.trim();
                    if (firstAdded) {
                      for (let li = 0; li < fileLines.length; li++) {
                        if (fileLines[li]?.trim() === firstAdded) {
                          let fullMatch = true;
                          for (let ai = 0; ai < added.length && li + ai < fileLines.length; ai++) {
                            if (fileLines[li + ai]?.trim() !== added[ai]?.trim()) {
                              fullMatch = false;
                              break;
                            }
                          }
                          if (fullMatch) {
                            matchLineIndex = li;
                            break;
                          }
                        }
                      }
                    }
                    // Fallback: try removed lines (content is still pre-edit)
                    if (matchLineIndex === undefined) {
                      const firstRemoved = removed[0]?.trim();
                      if (firstRemoved) {
                        for (let li = 0; li < fileLines.length; li++) {
                          if (fileLines[li]?.trim() === firstRemoved) {
                            let fullMatch = true;
                            for (
                              let ri = 0;
                              ri < removed.length && li + ri < fileLines.length;
                              ri++
                            ) {
                              if (fileLines[li + ri]?.trim() !== removed[ri]?.trim()) {
                                fullMatch = false;
                                break;
                              }
                            }
                            if (fullMatch) {
                              matchLineIndex = li;
                              break;
                            }
                          }
                        }
                      }
                    }
                    showEditOverlay({
                      type: "edit",
                      removed,
                      added,
                      matchLineIndex,
                      callId: entry.toolCallId,
                    });
                    overlaid = true;
                  }
                } else if (entry.name === "write") {
                  // Write: diff old sidebar content against new write content
                  const newContent = typeof args?.content === "string" ? args.content : "";
                  const oldLines = sc.content.split("\n");
                  const newLines = newContent.split("\n");
                  // Simple line diff: find first and last differing lines
                  let firstDiff = 0;
                  while (
                    firstDiff < oldLines.length &&
                    firstDiff < newLines.length &&
                    oldLines[firstDiff] === newLines[firstDiff]
                  ) {
                    firstDiff++;
                  }
                  let oldEnd = oldLines.length - 1;
                  let newEnd = newLines.length - 1;
                  while (
                    oldEnd > firstDiff &&
                    newEnd > firstDiff &&
                    oldLines[oldEnd] === newLines[newEnd]
                  ) {
                    oldEnd--;
                    newEnd--;
                  }
                  const removed = oldLines.slice(firstDiff, oldEnd + 1);
                  const added = newLines.slice(firstDiff, newEnd + 1);
                  if (removed.length || added.length) {
                    showEditOverlay({
                      type: "edit",
                      removed,
                      added,
                      matchLineIndex: firstDiff,
                      callId: entry.toolCallId,
                    });
                    overlaid = true;
                  }
                } else {
                  showEditOverlay({
                    type: "apply_patch",
                    removed: [],
                    added: [],
                    callId: entry.toolCallId,
                  });
                  overlaid = true;
                }
                if (!overlaid) {
                  // Empty diff (e.g. rewrite with identical content) — nothing
                  // to show; keep scanning so it can't burn a real edit's hold.
                  continue;
                }
                // Overlay shown — the resolver branch above refreshes after
                // the hold; a fresh overlay gets a fresh retry budget.
                cv.editRetries = 0;
                armEditHold(cv, requestHostUpdate);
                break;
              }
            }
          }

          return nothing;
        })()}
        ${state.tab === "chat"
          ? html`
              ${renderChatTabBar(state, {
                onSwitchSession: (next) => {
                  switchChatSession(state, next);
                  savePersistedTabs(state.chatOpenSessionTabs, next);
                },
                onNewSession: () => void createChatSession(state),
                onCloseTab: (key) => {
                  state.chatOpenSessionTabs = state.chatOpenSessionTabs.filter((k) => k !== key);
                  if (key === state.sessionKey) {
                    const remaining = state.chatOpenSessionTabs;
                    const lastRemaining = remaining[remaining.length - 1];
                    if (lastRemaining !== undefined) {
                      switchChatSession(state, lastRemaining);
                    }
                  }
                  // Drop the closed session's saved runtime (after any switch, which
                  // would otherwise re-save it) so reopening it later loads fresh
                  // instead of restoring a stale/finished run's phantom state.
                  if (state.chatRuntimeBySession) {
                    delete state.chatRuntimeBySession[key];
                  }
                  savePersistedTabs(state.chatOpenSessionTabs, state.sessionKey);
                },
                onReorderTabs: (reordered) => {
                  state.chatOpenSessionTabs = reordered;
                  savePersistedTabs(reordered, state.sessionKey);
                },
              })}
              ${renderMeasured(
                state,
                "chat",
                {
                  messageCount: state.chatMessages.length,
                  toolMessageCount: state.chatToolMessages.length,
                  streamSegmentCount: state.chatStreamSegments.length,
                  queueCount: state.chatQueue.length,
                },
                () =>
                  renderChat({
                    sessionKey: state.sessionKey,
                    onSessionKeyChange: (next) => {
                      switchChatSession(state, next);
                    },
                    thinkingLevel: state.chatThinkingLevel,
                    showThinking,
                    showToolCalls,
                    loading: state.chatLoading,
                    sending: state.chatSending,
                    runId: state.chatRunId,
                    compactionStatus: state.compactionStatus,
                    fallbackStatus: state.fallbackStatus,
                    liveUsage: state.chatLiveUsage,
                    assistantAvatarUrl: chatAgentAvatar,
                    messages: state.chatMessages,
                    sideResult: state.chatSideResult,
                    toolMessages: state.chatToolMessages,
                    streamSegments: state.chatStreamSegments,
                    stream: state.chatStream,
                    streamStartedAt: state.chatStreamStartedAt,
                    sendStartedAt: state.chatSendStartedAt ?? null,
                    thinkingStream: state.chatThinkingStream,
                    thinkingStreamStartedAt: state.chatThinkingStreamStartedAt,
                    draft: state.chatMessage,
                    queue: state.chatQueue,
                    realtimeTalkActive: state.realtimeTalkActive,
                    realtimeTalkStatus: state.realtimeTalkStatus,
                    realtimeTalkDetail: state.realtimeTalkDetail,
                    realtimeTalkTranscript: state.realtimeTalkTranscript,
                    realtimeTalkConversation: state.realtimeTalkConversation,
                    realtimeTalkOptionsOpen: state.realtimeTalkOptionsOpen,
                    realtimeTalkOptions: state.realtimeTalkOptions,
                    connected: state.connected,
                    canSend: state.connected,
                    disabledReason: chatDisabledReason,
                    error: chatViewError,
                    runStatus: state.chatRunStatus,
                    onDismissError: () => dismissChatError(state),
                    sessions: state.sessionsResult,
                    composerControls: renderGuardedChatControls(state),
                    workspaceFiles: {
                      agentId: chatAgentId,
                      list:
                        chatWorkspaceFiles.list?.agentId === chatAgentId
                          ? chatWorkspaceFiles.list
                          : null,
                      loading: chatWorkspaceFiles.loading,
                      error: chatWorkspaceFiles.error,
                      activeName: chatWorkspaceFiles.activeName,
                      activeFile: chatWorkspaceFiles.list?.workspace
                        ? resolveActiveFileFromMessages(
                            [...state.chatMessages, ...state.chatToolMessages],
                            chatWorkspaceFiles.list.workspace,
                          )
                        : null,
                      activeDirFiles: chatWorkspaceFiles.activeDirFiles,
                      onRefresh: refreshChatWorkspaceFiles,
                      onOpenFile: openChatWorkspaceFile,
                    },
                    autoExpandToolCalls: false,
                    onRefresh: () => {
                      state.chatSideResult = null;
                      state.resetToolStream();
                      void refreshChat(state, { awaitHistory: true, scheduleScroll: false });
                    },
                    onChatScroll: (event) => state.handleChatScroll(event),
                    getDraft: () => state.chatMessage,
                    onDraftChange: (next) => state.handleChatDraftChange(next),
                    onRequestUpdate: requestHostUpdate,
                    onHistoryKeydown: (input) => state.handleChatInputHistoryKey(input),
                    attachments: state.chatAttachments,
                    onAttachmentsChange: (next) => (state.chatAttachments = next),
                    onSend: () => void state.handleSendChat(),
                    onCompact: () => void state.handleSendChat("/compact", { restoreDraft: true }),
                    onOpenSessionCheckpoints: () => {
                      state.sessionsExpandedCheckpointKey = state.sessionKey;
                      state.setTab("sessions" as import("./navigation.ts").Tab);
                      void loadSessions(state, {
                        ...createChatSessionsLoadOverrides(state),
                        ...scopedAgentListParamsForSession(state, state.sessionKey),
                      });
                    },
                    onToggleRealtimeTalk: () => void state.toggleRealtimeTalk(),
                    onToggleRealtimeTalkOptions: () => {
                      state.realtimeTalkOptionsOpen = !state.realtimeTalkOptionsOpen;
                    },
                    onRealtimeTalkOptionsChange: (next) => state.updateRealtimeTalkOptions(next),
                    canAbort: hasAbortableSessionRun(state),
                    onAbort: () => void state.handleAbortChat({ preserveDraft: true }),
                    onQueueRemove: (id) => state.removeQueuedMessage(id),
                    onQueueRetry: (id) => void state.retryQueuedChatMessage(id),
                    onQueueSteer: (id) => void state.steerQueuedChatMessage(id),
                    onDismissSideResult: () => {
                      state.chatSideResult = null;
                    },
                    onNewSession: () => void createChatSession(state),
                    onClearHistory: runUiTask(async () => {
                      if (!state.client || !state.connected) {
                        return;
                      }
                      if (!confirmDestructiveSessionReset(state)) {
                        return;
                      }
                      const hadActiveRun = hasAbortableSessionRun(state);
                      try {
                        await state.client.request("sessions.reset", {
                          key: state.sessionKey,
                          ...scopedAgentParamsForSession(state, state.sessionKey),
                        });
                        state.chatMessages = [];
                        state.chatSideResult = null;
                        reconcileChatRunLifecycle(
                          state as unknown as Parameters<typeof reconcileChatRunLifecycle>[0],
                          {
                            outcome: hadActiveRun ? "interrupted" : undefined,
                            sessionStatus: "killed",
                            runId: state.chatRunId,
                            sessionKey: state.sessionKey,
                            clearLocalRun: true,
                            clearChatStream: true,
                            clearToolStream: true,
                            clearSideResultTerminalRuns: true,
                            clearRunStatus: !hadActiveRun,
                          },
                        );
                        await loadChatHistory(state);
                      } catch (err) {
                        state.lastError = String(err);
                        state.chatError = state.lastError;
                      }
                    }),
                    historyHasMore: state.chatHistoryHasMore,
                    loadingEarlier: state.chatLoadingEarlier,
                    onLoadEarlier: () => void loadEarlierMessages(state),
                    historyRenderLimit: state.chatHistoryRenderLimit,
                    agentsList: state.agentsList,
                    currentAgentId: chatAgentId,
                    fullMessageAgentId: scopedAgentParamsForSession(state, state.sessionKey)
                      .agentId,
                    onAgentChange: (agentId: string) => {
                      switchChatSession(state, buildAgentMainSessionKey({ agentId }));
                    },
                    onNavigateToAgent: () => {
                      state.agentsSelectedId = resolvedAgentId;
                      state.setTab("agents" as import("./navigation.ts").Tab);
                    },
                    onSessionSelect: (key: string) => {
                      switchChatSession(state, key);
                    },
                    showNewMessages: state.chatNewMessagesBelow && !state.chatManualRefreshInFlight,
                    onScrollToBottom: () => state.scrollToBottom(),
                    // Sidebar props for tool output viewing
                    sidebarOpen: state.sidebarOpen,
                    sidebarContent: state.sidebarContent,
                    sidebarError: state.sidebarError,
                    splitRatio: state.splitRatio,
                    canvasPluginSurfaceUrl: state.hello?.pluginSurfaceUrls?.canvas ?? null,
                    onOpenSidebar: (content) => state.handleOpenSidebar(content),
                    onCloseSidebar: () => state.handleCloseSidebar(),
                    onSplitRatioChange: (ratio: number) => state.handleSplitRatioChange(ratio),
                    assistantName: state.assistantName,
                    assistantAvatar: chatAgentAvatar,
                    userName: state.userName ?? null,
                    userAvatar: state.userAvatar ?? null,
                    localMediaPreviewRoots: state.localMediaPreviewRoots,
                    embedSandboxMode: state.embedSandboxMode,
                    allowExternalEmbedUrls: state.allowExternalEmbedUrls,
                    assistantAttachmentAuthToken: resolveAssistantAttachmentAuthToken(state),
                    branchPoints: state.branchPoints,
                    branchActivePath: state.branchActivePath,
                    onBranchNavigate: (entryId, direction) => {
                      void handleBranchNavigate(state, entryId, direction);
                    },
                    onBranchFromMessage: (messageId) => {
                      void (async () => {
                        if (!state.client || !state.connected) {
                          return;
                        }
                        try {
                          await state.client.request("chat.branch", {
                            sessionKey: state.sessionKey,
                            messageId,
                          });
                        } catch {
                          // Graceful — branch not supported
                        }
                        await Promise.all([
                          loadChatHistory(state, { startup: false }),
                          loadBranches(state),
                        ]);
                      })();
                    },
                    onEditMessage: (text, entryId, restoreFiles) => {
                      if (!state.client || !state.connected) {
                        return;
                      }
                      // Block a re-entrant Save while this edit's branch+resend is
                      // still running so chat.branch is not applied twice.
                      if (editResendInFlight.has(state)) {
                        return;
                      }
                      editResendInFlight.add(state);
                      // The rollback choice is now made inline in the edit bubble
                      // (see enterEditMode) and arrives as restoreFiles.
                      state.chatMessage = "";
                      // Show the reading indicator immediately: branching plus the
                      // history reload below can take a few seconds and would
                      // otherwise leave the thread blank with no feedback.
                      state.chatSending = true;
                      state.requestUpdate?.();
                      void (async () => {
                        try {
                          // Rewind to just before the edited message so the old
                          // version moves to the abandoned branch and the edited
                          // text replaces it.
                          await state.client?.request("chat.branch", {
                            sessionKey: state.sessionKey,
                            entryId,
                            mode: "before",
                            restoreFiles,
                          });
                        } catch (err) {
                          // Without the branch point a resend would duplicate the
                          // message, so surface the failure and stop.
                          state.chatSending = false;
                          state.chatError = String(err);
                          state.requestUpdate?.();
                          return;
                        }
                        // Reload history — this shows only messages up to the branch point
                        state.chatMessages = [];
                        state.chatToolMessages = [];
                        await Promise.all([
                          loadChatHistory(state, { startup: false }),
                          loadBranches(state),
                        ]);
                        // Hand off to the normal send path so the run id, stream,
                        // and optimistic user message drive the sending/receiving
                        // indicators. It re-arms chatSending itself (and early-
                        // returns if it's already set), so clear ours first.
                        state.chatSending = false;
                        await sendChatMessage(state, text, undefined, {
                          runId: editResendRunId(entryId, text),
                        });
                      })().finally(() => {
                        editResendInFlight.delete(state);
                      });
                    },
                    basePath: state.basePath ?? "",
                  }),
              )}
            `
          : nothing}
        ${isSettingsTab(state.tab) &&
        state.tab !== "debug" &&
        state.tab !== "logs" &&
        state.tab !== "vault"
          ? renderSettingsWorkspace(state, renderConfigTabForActiveTab())
          : renderConfigTabForActiveTab()}
        ${state.tab === "debug"
          ? renderSettingsWorkspace(
              state,
              renderLazyView(lazyDebug, (m) =>
                m.renderDebug({
                  loading: state.debugLoading,
                  status: state.debugStatus,
                  health: state.debugHealth,
                  models: state.debugModels,
                  heartbeat: state.debugHeartbeat,
                  eventLog: state.eventLog,
                  methods: (state.hello?.features?.methods ?? []).toSorted(),
                  callMethod: state.debugCallMethod,
                  callParams: state.debugCallParams,
                  callResult: state.debugCallResult,
                  callError: state.debugCallError,
                  onCallMethodChange: (next) => (state.debugCallMethod = next),
                  onCallParamsChange: (next) => (state.debugCallParams = next),
                  onRefresh: () => void loadDebug(state),
                  onCall: () => void callDebugMethod(state),
                }),
              ),
            )
          : nothing}
        ${state.tab === "logs"
          ? renderSettingsWorkspace(
              state,
              renderLazyView(lazyLogs, (m) =>
                m.renderLogs({
                  loading: state.logsLoading,
                  // Upstream logs view consumes a PanelRefreshStatus; map the fork's
                  // string logsError into a failed status so the error banner still renders.
                  status: state.logsError
                    ? failPanelRefresh(createPanelRefreshStatus(), state.logsError)
                    : createPanelRefreshStatus(),
                  file: state.logsFile,
                  entries: state.logsEntries,
                  filterText: state.logsFilterText,
                  levelFilters: state.logsLevelFilters,
                  autoFollow: state.logsAutoFollow,
                  truncated: state.logsTruncated,
                  onFilterTextChange: (next) => (state.logsFilterText = next),
                  onLevelToggle: (level, enabled) => {
                    state.logsLevelFilters = { ...state.logsLevelFilters, [level]: enabled };
                  },
                  onToggleAutoFollow: (next) => (state.logsAutoFollow = next),
                  onRefresh: () => void loadLogs(state, { reset: true }),
                  onExport: (lines, label) => state.exportLogs(lines, label),
                  onScroll: (event) => state.handleLogsScroll(event),
                }),
              ),
            )
          : nothing}
        ${state.tab === "rsil" ? renderRsil(state) : nothing}
        ${state.tab === "dreams"
          ? renderDreaming({
              active: dreamingOn,
              selectedAgentId: dreamingSelectedAgentId,
              agentOptions: dreamingAgentOptions,
              shortTermCount: state.dreamingStatus?.shortTermCount ?? 0,
              groundedSignalCount: state.dreamingStatus?.groundedSignalCount ?? 0,
              totalSignalCount: state.dreamingStatus?.totalSignalCount ?? 0,
              promotedCount: state.dreamingStatus?.promotedToday ?? 0,
              promotedTotal: state.dreamingStatus?.promotedTotal ?? 0,
              lastPromotedCount: state.dreamingStatus?.lastPromotedCount ?? 0,
              lastPromotedAt: state.dreamingStatus?.lastPromotedAt ?? null,
              phases: state.dreamingStatus?.phases ?? undefined,
              shortTermEntries: state.dreamingStatus?.shortTermEntries ?? [],
              promotedEntries: state.dreamingStatus?.promotedEntries ?? [],
              dreamingOf: null,
              nextCycle: dreamingNextCycle,
              timezone: state.dreamingStatus?.timezone ?? null,
              statusLoading: state.dreamingStatusLoading,
              statusError: state.dreamingStatusError,
              modeSaving: state.dreamingModeSaving,
              dreamDiaryLoading: state.dreamDiaryLoading,
              dreamDiaryActionLoading: state.dreamDiaryActionLoading,
              dreamDiaryActionMessage: state.dreamDiaryActionMessage,
              dreamDiaryActionArchivePath: state.dreamDiaryActionArchivePath,
              dreamDiaryError: state.dreamDiaryError,
              dreamDiaryPath: state.dreamDiaryPath,
              dreamDiaryContent: state.dreamDiaryContent,
              memoryWikiEnabled: isPluginEnabledInConfigSnapshot(
                state.configSnapshot,
                "memory-wiki",
                { enabledByDefault: false },
              ),
              wikiImportInsightsLoading: state.wikiImportInsightsLoading,
              wikiImportInsightsError: state.wikiImportInsightsError,
              wikiImportInsights: state.wikiImportInsights,
              wikiMemoryPalaceLoading: state.wikiMemoryPalaceLoading,
              wikiMemoryPalaceError: state.wikiMemoryPalaceError,
              wikiMemoryPalace: state.wikiMemoryPalace,
              onRefresh: refreshDreaming,
              onSelectAgent: (agentId: string) => {
                state.selectedAgentId = agentId;
                // "All agents" is an aggregate view, not a real chat agent — keep
                // the active chat session unchanged when it is selected.
                if (agentId !== ALL_AGENTS_ID) {
                  switchChatSession(state, resolvePreferredSessionForAgent(state, agentId));
                }
                void loadDreamingStatus(state);
                void loadDreamDiary(state);
              },
              onRefreshDiary: () => {
                syncDreamingSelectedAgent();
                void loadDreamDiary(state);
              },
              onRefreshImports: () => {
                void (async () => {
                  await loadConfig(state);
                  await loadWikiImportInsights(state);
                })();
              },
              onRefreshMemoryPalace: () => {
                void (async () => {
                  await loadConfig(state);
                  await loadWikiMemoryPalace(state);
                })();
              },
              onOpenConfig: () => void openConfigFile(state),
              onOpenWikiPage: (lookup: string) => openWikiPage(lookup),
              onLoadL3LayerList: () => loadL3LayerList(state),
              onLoadL3LayerContent: (layerId: string) => loadL3LayerContent(state, layerId),
              onBackfillDiary: () => {
                syncDreamingSelectedAgent();
                void backfillDreamDiary(state);
              },
              onCopyDreamingArchivePath: () => {
                void copyDreamingArchivePath(state);
              },
              onDedupeDreamDiary: () => {
                syncDreamingSelectedAgent();
                void dedupeDreamDiary(state);
              },
              onResetDiary: () => {
                syncDreamingSelectedAgent();
                void resetDreamDiary(state);
              },
              onResetGroundedShortTerm: () => {
                syncDreamingSelectedAgent();
                void resetGroundedShortTerm(state);
              },
              onRepairDreamingArtifacts: () => {
                syncDreamingSelectedAgent();
                void repairDreamingArtifacts(state);
              },
              onRequestUpdate: requestHostUpdate,
            })
          : nothing}
      </main>
      ${state.execApprovalQueue.length > 0
        ? html`<openclaw-exec-approval
            .props=${{
              queue: state.execApprovalQueue,
              busy: state.execApprovalBusy,
              errors: new Map<string, string>(),
              nowMs: Date.now(),
              inlineApprovalId: null,
              // Fork handler decides the queue head only; ignore stale ids from
              // queue-list clicks so a race can't approve the wrong request.
              onDecision: (
                approvalId: string,
                decision: "allow-once" | "allow-always" | "deny",
              ) => {
                if (approvalId === state.execApprovalQueue[0]?.id) {
                  void state.handleExecApprovalDecision(decision);
                }
              },
            }}
          ></openclaw-exec-approval>`
        : nothing}
      ${renderGatewayUrlConfirmation(state)}
      ${state.vaultComposerModalOpen
        ? renderLazyView(
            lazyVaultAddModal,
            () => html`<openclaw-vault-add-modal
              .client=${state.client}
              @vault-close=${() => {
                state.vaultComposerModalOpen = false;
              }}
            ></openclaw-vault-add-modal>`,
          )
        : nothing}
      ${renderDreamingRestartConfirmation({
        open: state.dreamingRestartConfirmOpen,
        loading: state.dreamingRestartConfirmLoading,
        onConfirm: confirmDreamingRestart,
        onCancel: cancelDreamingRestart,
        hasError: Boolean(state.dreamingStatusError),
      })}
      ${nothing}
    </div>
  `;
}
