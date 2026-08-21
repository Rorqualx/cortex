import { LitElement } from "lit";
import { state } from "lit/decorators.js";
import { i18n, I18nController, isSupportedLocale, t } from "../i18n/index.ts";
import type { ActivityEvent, ActivityStatusKey } from "./activity-model.ts";
import {
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
} from "./app-channels.ts";
import {
  handleAbortChat as handleAbortChatInternal,
  handleChatDraftChange as handleChatDraftChangeInternal,
  handleChatInputHistoryKey as handleChatInputHistoryKeyInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
  resetChatInputHistoryNavigation as resetChatInputHistoryNavigationInternal,
  retryQueuedChatMessage as retryQueuedChatMessageInternal,
  steerQueuedChatMessage as steerQueuedChatMessageInternal,
  type ChatInputHistoryKeyInput,
  type ChatInputHistoryKeyResult,
} from "./app-chat.ts";
import {
  DEFAULT_CRON_FORM,
  DEFAULT_LOG_LEVEL_FILTERS,
  DEFAULT_SESSIONS_FILTERS,
} from "./app-defaults.ts";
import type { EventLogEntry } from "./app-events.ts";
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle.ts";
import { initNativeBridge } from "./app-native-bridge.ts";
import { createChatSession as createChatSessionInternal } from "./app-render.helpers.ts";
import { loadSkillForgeMode, renderApp } from "./app-render.ts";
import {
  exportLogs as exportLogsInternal,
  handleActivityScroll as handleActivityScrollInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleActivityScroll as scheduleActivityScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
import {
  applySettings as applySettingsInternal,
  applyLocalUserIdentity as applyLocalUserIdentityInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  setThemeMode as setThemeModeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings.ts";
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
  type ChatLiveUsage,
  type CompactionStatus,
  type FallbackStatus,
} from "./app-tool-stream.ts";
import { normalizeAssistantIdentity } from "./assistant-identity.ts";
import { AvatarChangeEvent } from "./avatar-lightbox.ts";
import { restorePersistedTabs } from "./chat/chat-tab-bar.ts";
import { restoreChatComposerState } from "./chat/composer-persistence.ts";
import { exportChatMarkdown } from "./chat/export.ts";
import {
  reconcileRealtimeTalkCatalogSelection,
  type RealtimeTalkCatalogProvider,
} from "./chat/realtime-talk-catalog.ts";
import {
  createRealtimeTalkConversationState,
  updateRealtimeTalkConversation,
  type RealtimeTalkConversationEntry,
  type RealtimeTalkConversationState,
} from "./chat/realtime-talk-conversation.ts";
import {
  RealtimeTalkSession,
  type RealtimeTalkLaunchOptions,
  type RealtimeTalkStatus,
} from "./chat/realtime-talk.ts";
import type { ChatRunUiStatus } from "./chat/run-lifecycle.ts";
import type { SessionChatRuntime } from "./chat/session-runtime.ts";
import type { ChatSideResult } from "./chat/side-result.ts";
import {
  loadToolsEffective as loadToolsEffectiveInternal,
  refreshVisibleToolsEffectiveForCurrentSession as refreshVisibleToolsEffectiveForCurrentSessionInternal,
} from "./controllers/agents.ts";
import {
  loadAssistantIdentity as loadAssistantIdentityInternal,
  setAssistantAvatarOverride,
} from "./controllers/assistant-identity.ts";
import {
  loadEarlierMessages as loadEarlierMessagesInternal,
  expandHistoryRenderLimit as expandHistoryRenderLimitInternal,
} from "./controllers/chat.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type {
  DreamingStatus,
  WikiImportInsights,
  WikiMemoryPalace,
} from "./controllers/dreaming.ts";
import {
  dismissExecApprovalPrompt,
  isStaleApprovalResolutionError,
  refreshPendingApprovalQueue,
  type ExecApprovalRequest,
} from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type { SkillForgeState } from "./controllers/skill-forge.ts";
import type {
  ClawHubSearchResult,
  ClawHubSkillSecurityVerdict,
  ClawHubSkillDetail,
  SkillMessage,
  SkillOperation,
} from "./controllers/skills.ts";
import { importCustomThemeFromUrl } from "./custom-theme.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import { resolveAgentIdFromSessionKey } from "./session-key.ts";
import type {
  CanvasSidebarContent,
  MarkdownSidebarContent,
  SidebarContent,
} from "./sidebar-content.ts";
import { loadLocalUserIdentity, loadSettings, type UiSettings } from "./storage.ts";
import { VALID_THEME_NAMES, type ResolvedTheme, type ThemeMode, type ThemeName } from "./theme.ts";
import type { ActivityCursor } from "./types.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ConfigSnapshot,
  ConfigUiHints,
  ChatModelOverride,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSummary,
  LogEntry,
  LogLevel,
  ModelAuthStatusResult,
  ModelCatalogEntry,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionCompactionCheckpoint,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
  NostrProfile,
  ToolsCatalogResult,
  ToolsEffectiveResult,
} from "./types.ts";
import type { ChatAttachment, ChatQueueItem, CronFormState } from "./ui-types.ts";
import { generateUUID } from "./uuid.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";

declare global {
  interface Window {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  }
}

const bootAssistantIdentity = normalizeAssistantIdentity({});
const bootLocalUserIdentity = loadLocalUserIdentity();
const FULL_MESSAGE_SIDEBAR_MAX_CHARS = 500_000;

// Only markdown/canvas sidebar variants carry fullMessageRequest/unavailableReason;
// the guard must narrow to them so the full-message upgrade path typechecks.
type UpgradableSidebarContent = MarkdownSidebarContent | CanvasSidebarContent;

function isSidebarMarkdownLike(
  content: SidebarContent | null,
): content is UpgradableSidebarContent {
  return Boolean(content && (content.kind === "markdown" || content.kind === "canvas"));
}

function resolveSidebarUnavailableReason(
  reason: "not_found" | "oversized" | "not_visible" | null | undefined,
): string {
  switch (reason) {
    case "oversized":
      return "Full content is unavailable because the stored transcript entry is too large to return safely.";
    case "not_visible":
      return "Full content is unavailable because this transcript entry does not have a visible WebChat projection.";
    default:
      return "Full content is no longer available for this transcript entry.";
  }
}

function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export class OpenClawApp extends LitElement {
  readonly i18nController = new I18nController(this);
  clientInstanceId = generateUUID();
  connectGeneration = 0;
  @state() settings: UiSettings = loadSettings();
  constructor() {
    super();
    if (isSupportedLocale(this.settings.locale)) {
      void i18n.setLocale(this.settings.locale);
    }
  }
  @state() password = "";
  @state() loginShowGatewayToken = false;
  @state() loginShowGatewayPassword = false;
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeName = this.settings.theme ?? "claw";
  @state() themeMode: ThemeMode = this.settings.themeMode ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() themeOrder: ThemeName[] = this.buildThemeOrder(this.theme);
  @state() customThemeImportUrl = "";
  @state() customThemeImportBusy = false;
  @state() customThemeImportMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() customThemeImportExpanded = false;
  @state() customThemeImportFocusToken = 0;
  private customThemeImportSelectOnSuccess = false;
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() lastErrorCode: string | null = null;
  @state() chatError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  eventLogBuffer: EventLogEntry[] = [];
  toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() assistantName = bootAssistantIdentity.name;
  @state() assistantAvatar = bootAssistantIdentity.avatar;
  @state() assistantAvatarSource = bootAssistantIdentity.avatarSource ?? null;
  @state() assistantAvatarStatus = bootAssistantIdentity.avatarStatus ?? null;
  @state() assistantAvatarReason = bootAssistantIdentity.avatarReason ?? null;
  @state() assistantAvatarUploadBusy = false;
  @state() assistantAvatarUploadError: string | null = null;
  @state() assistantAgentId = bootAssistantIdentity.agentId ?? null;
  @state() userName = bootLocalUserIdentity.name;
  @state() userAvatar = bootLocalUserIdentity.avatar;
  @state() localMediaPreviewRoots: string[] = [];
  @state() embedSandboxMode: "strict" | "scripts" | "trusted" = "scripts";
  @state() allowExternalEmbedUrls = false;
  @state() chatMessageMaxWidth: string | null = null;
  @state() serverVersion: string | null = null;

  @state() sessionKey = this.settings.sessionKey;
  chatSessionMessageSubscriptionKey: string | null = null;
  chatSessionMessageSubscriptionRequestedKey: string | null = null;
  currentSessionId: string | null = null;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() vaultComposerModalOpen = false;
  // Written by app-chat send flow; read by render for elapsed-time display. Intentionally
  // non-reactive: it piggybacks on the re-renders chat events already trigger.
  chatSendStartedAt: number | null = null;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: Record<string, unknown>[] = [];
  @state() activityEvents: ActivityEvent[] = [];
  @state() activityFilterText = "";
  @state() activityStatusFilters: Record<ActivityStatusKey, boolean> = {
    running: true,
    ok: true,
    error: true,
    blocked: true,
    info: true,
  };
  @state() activityKindFilter = "";
  @state() activityAgentFilter = "";
  @state() activityExpandedIds = new Set<string>();
  @state() activityAutoFollow = true;
  @state() activityAtBottom = true;
  @state() activityLoading = false;
  @state() activityError: string | null = null;
  @state() activityHasMore = false;
  @state() activityCursor: ActivityCursor | null = null;
  @state() activitySubscribed = false;
  @state() chatStreamSegments: Array<{ text: string; ts: number }> = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatThinkingStream: string | null = null;
  @state() chatThinkingStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() chatSideResult: ChatSideResult | null = null;
  @state() compactionStatus: CompactionStatus | null = null;
  @state() fallbackStatus: FallbackStatus | null = null;
  @state() chatLiveUsage: ChatLiveUsage | null = null;
  @state() chatRunStatus: ChatRunUiStatus | null = null;
  chatRunStatusClearTimer: ReturnType<typeof globalThis.setTimeout> | number | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatAvatarSource: string | null = null;
  @state() chatAvatarStatus: "none" | "local" | "remote" | "data" | null = null;
  @state() chatAvatarReason: string | null = null;
  @state() agentAvatarUrls: Record<string, string> = {};
  @state() chatThinkingLevel: string | null = null;
  @state() chatHistoryHasMore = false;
  @state() chatHistoryNextOffset: number | null = null;
  @state() chatLoadingEarlier = false;
  @state() chatHistoryRenderLimit: number = Number.POSITIVE_INFINITY;
  @state() chatHistoryRenderExpanded = false;
  @state() chatModelOverrides: Record<string, ChatModelOverride | null> = {};
  @state() chatModelSwitchPromises: Record<string, Promise<boolean>> = {};
  @state() sidebarNewSessionAgentId: string | null = null;
  @state() sidebarNewSessionModel: { agentId: string; value: string } | null = null;
  @state() chatModelsLoading = false;
  @state() chatModelCatalog: ModelCatalogEntry[] = [];
  @state() sessionSwitchNotice: { id: number; text: string } | null = null;
  @state() sessionSwitchFlashKey: string | null = null;
  @state() chatSessionPickerOpen = false;
  @state() chatSessionPickerSurface: "desktop" | "mobile" | "sidebar" | null = null;
  @state() chatSessionPickerQuery = "";
  @state() chatSessionPickerAppliedQuery = "";
  @state() chatSessionPickerLoading = false;
  @state() chatSessionPickerError: string | null = null;
  @state() chatSessionPickerResult: SessionsListResult | null = null;
  // Default to the cross-agent "All" view so the sidebar opens listing every
  // agent's chats; switching to a specific agent in the dropdown clears it.
  @state() chatAgentFilterAll = true;
  private sessionSwitchNoticeSeq = 0;
  private sessionSwitchNoticeTimer: number | null = null;
  private sessionSwitchFlashTimer: number | null = null;
  chatComposerPersistTimer: ReturnType<typeof globalThis.setTimeout> | number | null = null;
  chatComposerPersistSnapshot: {
    sessionKey: string;
    chatMessage: string;
    chatQueue: ChatQueueItem[];
  } | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatQueueBySession: Record<string, ChatQueueItem[]> = {};
  chatRuntimeBySession: Record<string, SessionChatRuntime> = {};
  @state() chatAttachments: ChatAttachment[] = [];
  @state() realtimeTalkActive = false;
  @state() realtimeTalkStatus: RealtimeTalkStatus = "idle";
  @state() realtimeTalkDetail: string | null = null;
  @state() realtimeTalkTranscript: string | null = null;
  @state() realtimeTalkConversation: RealtimeTalkConversationEntry[] = [];
  @state() realtimeTalkOptionsOpen = false;
  @state() realtimeTalkCatalogProviders: RealtimeTalkCatalogProvider[] | null = null;
  @state() realtimeTalkOptions = {
    provider: "",
    model: "",
    voice: "",
    transport: "",
    vadThreshold: "",
    silenceDurationMs: "",
    prefixPaddingMs: "",
    reasoningEffort: "",
  };
  // Not private: app-lifecycle teardown stops and clears the live session via LifecycleHost.
  realtimeTalkSession: RealtimeTalkSession | null = null;
  private realtimeTalkConversationState: RealtimeTalkConversationState =
    createRealtimeTalkConversationState();
  private nativeBridgeCleanup: (() => void) | null = null;
  @state() chatManualRefreshInFlight = false;
  @state() chatHeaderControlsHidden = false;
  @state() chatMobileControlsOpen = false;
  @state() chatOpenSessionTabs: string[] = [];
  @state() chatTabCloseRequested: string | null = null;
  private chatMobileControlsTrigger: HTMLElement | null = null;
  @state() navDrawerOpen = false;

  onSlashAction?: (action: string) => void | Promise<void>;
  chatLocalInputHistoryBySession: Record<string, Array<{ text: string; ts: number }>> = {};
  chatInputHistorySessionKey: string | null = null;
  chatInputHistoryItems: string[] | null = null;
  @state() chatInputHistoryIndex = -1;
  chatDraftBeforeHistory: string | null = null;

  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: SidebarContent | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;
  @state() pendingGatewayUrl: string | null = null;
  pendingGatewayToken: string | null = null;

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  // Submit-time bookkeeping for the config controller; not render-driving.
  configRawOriginalParsed: Record<string, unknown> | null = null;
  configRawOriginalParsePending: Promise<void> | null = null;
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() configAutoSaveStatus: import("./controllers/config.ts").ConfigAutoSaveStatus = "idle";
  @state() configNeedsApply = false;
  @state() updateRunning = false;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() selectedAgentId: string | null = null;
  @state() dreamingStatusLoading = false;
  @state() dreamingStatusError: string | null = null;
  @state() dreamingStatus: DreamingStatus | null = null;
  @state() dreamingModeSaving = false;
  @state() dreamingRestartConfirmOpen = false;
  @state() dreamingRestartConfirmLoading = false;
  @state() dreamingPendingEnabled: boolean | null = null;
  @state() dreamDiaryLoading = false;
  @state() dreamDiaryActionLoading = false;
  @state() dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null = null;
  @state() dreamDiaryActionArchivePath: string | null = null;
  @state() dreamDiaryError: string | null = null;
  @state() dreamDiaryPath: string | null = null;
  @state() dreamDiaryContent: string | null = null;
  @state() wikiImportInsightsLoading = false;
  @state() wikiImportInsightsError: string | null = null;
  @state() wikiImportInsights: WikiImportInsights | null = null;
  @state() wikiMemoryPalaceLoading = false;
  @state() wikiMemoryPalaceError: string | null = null;
  @state() wikiMemoryPalace: WikiMemoryPalace | null = null;
  @state() configFormDirty = false;
  @state() configSettingsMode: "quick" | "advanced" = "quick";
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;
  /** Channels section: key of the channel whose focused config modal is open. */
  @state() configChannelModalKey: string | null = null;
  @state() pendingUpdateExpectedVersion: string | null = null;
  @state() pendingUpdateHandoff = false;
  @state() updateStatusBanner: { tone: "danger" | "warn" | "info"; text: string } | null = null;
  @state() communicationsFormMode: "form" | "raw" = "form";
  @state() communicationsSearchQuery = "";
  @state() communicationsActiveSection: string | null = null;
  @state() communicationsActiveSubsection: string | null = null;
  @state() appearanceFormMode: "form" | "raw" = "form";
  @state() appearanceSearchQuery = "";
  @state() appearanceActiveSection: string | null = null;
  @state() appearanceActiveSubsection: string | null = null;
  @state() automationFormMode: "form" | "raw" = "form";
  @state() automationSearchQuery = "";
  @state() automationActiveSection: string | null = null;
  @state() automationActiveSubsection: string | null = null;
  @state() infrastructureFormMode: "form" | "raw" = "form";
  @state() infrastructureSearchQuery = "";
  @state() infrastructureActiveSection: string | null = null;
  @state() infrastructureActiveSubsection: string | null = null;
  @state() aiAgentsFormMode: "form" | "raw" = "form";
  @state() aiAgentsSearchQuery = "";
  @state() aiAgentsActiveSection: string | null = null;
  @state() aiAgentsActiveSubsection: string | null = null;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsSelectedId: string | null = null;
  @state() toolsCatalogLoading = false;
  @state() toolsCatalogError: string | null = null;
  @state() toolsCatalogResult: ToolsCatalogResult | null = null;
  @state() toolsEffectiveLoading = false;
  @state() toolsEffectiveLoadingKey: string | null = null;
  @state() toolsEffectiveResultKey: string | null = null;
  @state() toolsEffectiveError: string | null = null;
  @state() toolsEffectiveResult: ToolsEffectiveResult | null = null;
  @state() agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron" =
    "overview";
  // Shared generation counter for agent files/skills loads; controllers bump it to
  // invalidate in-flight requests when the selected agent or panel changes.
  requestGeneration = 0;
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() agentIdentityById: Record<string, AgentIdentityResult> = {};
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = DEFAULT_SESSIONS_FILTERS.activeMinutes;
  @state() sessionsFilterLimit = DEFAULT_SESSIONS_FILTERS.limit;
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;
  @state() sessionsShowArchived = false;
  @state() sessionsFiltersCollapsed = false;
  @state() sessionsHideCron = true;
  @state() sessionsSearchQuery = "";
  @state() sessionsSortColumn: "key" | "kind" | "updated" | "tokens" = "updated";
  @state() sessionsSortDir: "asc" | "desc" = "desc";
  @state() sessionsPage = 0;
  @state() sessionsPageSize = 25;
  @state() sessionsSelectedKeys: Set<string> = new Set();
  @state() sessionsExpandedCheckpointKey: string | null = null;
  @state() sessionsCheckpointItemsByKey: Record<string, SessionCompactionCheckpoint[]> = {};
  @state() sessionsCheckpointLoadingKey: string | null = null;
  @state() sessionsCheckpointBusyKey: string | null = null;
  @state() sessionsCheckpointErrorByKey: Record<string, string> = {};

  @state() conversationsSearchQuery = "";
  @state() conversationsSourceFilter: import("./views/conversations.ts").ConversationFilter = "all";

  @state() usageLoading = false;
  @state() usageResult: import("./types.js").SessionsUsageResult | null = null;
  @state() usageCostSummary: import("./types.js").CostUsageSummary | null = null;
  @state() usageError: string | null = null;
  @state() usageStartDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageEndDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageScope: "instance" | "family" = "family";
  @state() usageAgentId: string | null = null;
  @state() usageSelectedSessions: string[] = [];
  @state() usageSelectedDays: string[] = [];
  @state() usageSelectedHours: number[] = [];
  @state() usageChartMode: "tokens" | "cost" = "tokens";
  @state() usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeries: import("./types.js").SessionUsageTimeSeries | null = null;
  @state() usageTimeSeriesLoading = false;
  @state() usageTimeSeriesCursorStart: number | null = null;
  @state() usageTimeSeriesCursorEnd: number | null = null;
  @state() usageSessionLogs: import("./views/usageTypes.js").SessionLogEntry[] | null = null;
  @state() usageSessionLogsLoading = false;
  @state() usageSessionLogsExpanded = false;
  // Applied query (used to filter the already-loaded sessions list client-side).
  @state() usageQuery = "";
  // Draft query text (updates immediately as the user types; applied via debounce or "Search").
  @state() usageQueryDraft = "";
  @state() usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" = "recent";
  @state() usageSessionSortDir: "desc" | "asc" = "desc";
  @state() usageRecentSessions: string[] = [];
  @state() usageTimeZone: "local" | "utc" = "local";
  @state() usageContextExpanded = false;
  @state() usageHeaderPinned = false;
  @state() usageSessionsTab: "all" | "recent" = "all";
  @state() usageVisibleColumns: string[] = [
    "channel",
    "agent",
    "provider",
    "model",
    "messages",
    "tools",
    "errors",
    "duration",
  ];
  @state() usageLogFilterRoles: import("./views/usageTypes.js").SessionLogRole[] = [];
  @state() usageLogFilterTools: string[] = [];
  @state() usageLogFilterHasTools = false;
  @state() usageLogFilterQuery = "";

  // Non-reactive (don’t trigger renders just for timer bookkeeping).
  usageQueryDebounceTimer: number | null = null;

  @state() cronLoading = false;
  @state() cronQuickCreateOpen = false;
  @state() cronQuickCreateStep: import("./views/cron-quick-create.ts").CronQuickCreateStep = "what";
  @state() cronQuickCreateDraft:
    | import("./views/cron-quick-create.ts").CronQuickCreateDraft
    | null = null;
  @state() cronJobsLoadingMore = false;
  cronJobsReloadPending = false;
  cronJobsReloadPendingTableFilters = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronJobsTotal = 0;
  @state() cronJobsHasMore = false;
  @state() cronJobsNextOffset: number | null = null;
  @state() cronJobsLimit = 50;
  @state() cronJobsQuery = "";
  @state() cronJobsEnabledFilter: import("./types.js").CronJobsEnabledFilter = "all";
  @state() cronJobsScheduleKindFilter: import("./controllers/cron.js").CronJobsScheduleKindFilter =
    "all";
  @state() cronJobsLastStatusFilter: import("./controllers/cron.js").CronJobsLastStatusFilter =
    "all";
  @state() cronJobsTriggerFilter: import("./controllers/cron.js").CronJobsTriggerFilter = "all";
  @state() cronJobsSortBy: import("./types.js").CronJobsSortBy = "nextRunAtMs";
  @state() cronJobsSortDir: import("./types.js").CronSortDir = "asc";
  @state() cronStatus: CronStatus | null = null;
  @state() cronAgentId: string | null = null;
  @state() cronScopedTotal: number | null = null;
  @state() cronScopedNextWakeAtMs: number | null = null;
  // Global enabled+error job count for the stats card; null until loaded.
  @state() cronFailingCount: number | null = null;
  // True while the create panel owns the detail pane (job selection wins over it).
  @state() cronCreateOpen = false;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronFormCollapsed = true;
  @state() cronFieldErrors: import("./controllers/cron.js").CronFieldErrors = {};
  @state() cronEditingJobId: string | null = null;
  @state() cronRunsJobId: string | null = null;
  @state() cronRunsLoadingMore = false;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronRunsTotal = 0;
  @state() cronRunsHasMore = false;
  @state() cronRunsNextOffset: number | null = null;
  @state() cronRunsLimit = 50;
  @state() cronRunsScope: import("./types.js").CronRunScope = "all";
  @state() cronRunsStatuses: import("./types.js").CronRunsStatusValue[] = [];
  @state() cronRunsDeliveryStatuses: import("./types.js").CronDeliveryStatus[] = [];
  @state() cronRunsStatusFilter: import("./types.js").CronRunsStatusFilter = "all";
  @state() cronRunsQuery = "";
  @state() cronRunsSortDir: import("./types.js").CronSortDir = "desc";
  @state() cronModelSuggestions: string[] = [];
  @state() cronBusy = false;

  @state() updateAvailable: import("./types.js").UpdateAvailable | null = null;

  // Overview dashboard state
  @state() attentionItems: import("./types.js").AttentionItem[] = [];
  @state() paletteOpen = false;
  @state() paletteQuery = "";
  @state() paletteActiveIndex = 0;
  @state() overviewShowGatewayToken = false;
  @state() overviewShowGatewayPassword = false;
  // In-flight guard for the "Generate token" action: persisting gateway.auth.token
  // can bounce the gateway, so the button stays disabled until the write settles.
  @state() overviewGeneratingToken = false;
  // Configured gateway token surfaced in the overview Gateway Token section
  // (auto-loaded for admin sessions); masked until the operator reveals it.
  @state() overviewGatewayToken: import("./controllers/config.ts").GatewayTokenView | null = null;
  @state() overviewShowGatewayTokenValue = false;
  @state() overviewLogLines: string[] = [];
  @state() overviewLogCursor = 0;

  @state() skillsLoading = false;
  @state() skillsAgentId: string | null = null;
  // Non-reactive revision counter bumped by setSkillsAgentId to invalidate in-flight loads.
  skillsAgentRevision = 0;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled" = "all";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  // In-flight skills operation tracked by the skills controller (refresh/skill/clawhub).
  @state() skillOperation: SkillOperation = null;
  @state() skillMessages: Record<string, SkillMessage> = {};
  @state() skillsDetailKey: string | null = null;
  @state() skillsDetailTab: "overview" | "card" = "overview";
  @state() clawhubSearchQuery = "";
  @state() clawhubSearchResults: ClawHubSearchResult[] | null = null;
  @state() clawhubSearchLoading = false;
  @state() clawhubSearchError: string | null = null;
  @state() clawhubDetail: ClawHubSkillDetail | null = null;
  @state() clawhubDetailSlug: string | null = null;
  @state() clawhubDetailLoading = false;
  @state() clawhubDetailError: string | null = null;
  @state() clawhubInstallSlug: string | null = null;
  @state() clawhubInstallMessage: {
    kind: "success" | "error";
    text: string;
    acknowledgeSlug?: string;
    acknowledgeVersion?: string;
    acknowledgeLabel?: string;
  } | null = null;
  @state() clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict> = {};
  @state() clawhubVerdictsLoading = false;
  @state() clawhubVerdictsError: string | null = null;
  @state() skillCardContents: Record<string, string> = {};
  @state() skillCardContentKeys: Record<string, string> = {};
  @state() skillCardLoadingKey: string | null = null;
  @state() skillCardErrors: Record<string, string> = {};
  @state() skillForgeLoading = false;
  @state() skillForgeLoaded = false;
  @state() skillForgeError: string | null = null;
  @state() skillForgeStatus: SkillForgeState["skillForgeStatus"] = null;
  @state() skillForgeSelectedName: string | null = null;
  @state() skillForgeRunBusy = false;
  @state() skillForgeActionBusy: string | null = null;
  @state() skillForgeActionNotice: SkillForgeState["skillForgeActionNotice"] = null;
  skillForgeActionNoticeTimer: ReturnType<typeof globalThis.setTimeout> | number | null = null;
  @state() skillForgeFilter: SkillForgeState["skillForgeFilter"] = "all";
  @state() skillForgeQuery = "";
  @state() skillForgeMode: SkillForgeState["skillForgeMode"] = loadSkillForgeMode();
  @state() skillForgeQueueWidth = 360;

  @state() healthLoading = false;
  @state() healthResult: HealthSummary | null = null;
  @state() healthError: string | null = null;

  @state() modelAuthStatusLoading = false;
  @state() modelAuthStatusResult: ModelAuthStatusResult | null = null;
  @state() modelAuthStatusError: string | null = null;

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSummary | null = null;
  @state() debugModels: ModelCatalogEntry[] = [];
  @state() debugHeartbeat: unknown = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  @state() webPushSupported = false;
  @state() webPushPermission: NotificationPermission | "unsupported" = "unsupported";
  @state() webPushSubscribed = false;
  @state() webPushLoading = false;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  chatScrollFrame: number | null = null;
  chatScrollTimeout: number | null = null;
  chatLastScrollTop = 0;
  chatHasAutoScrolled = false;
  chatUserNearBottom = true;
  chatIsProgrammaticScroll = false;
  chatProgrammaticScrollTarget = 0;
  @state() chatNewMessagesBelow = false;
  nodesPollInterval: number | null = null;
  logsPollInterval: number | null = null;
  debugPollInterval: number | null = null;
  sessionsChangedReloadTimer: number | ReturnType<typeof globalThis.setTimeout> | null = null;
  logsScrollFrame: number | null = null;
  activityScrollFrame: number | null = null;
  controlUiResponsivenessObserver: { disconnect: () => void } | null = null;
  toolStreamById = new Map<string, ToolStreamEntry>();
  toolStreamOrder: string[] = [];
  refreshSessionsAfterChat = new Map<string, import("./ui-types.js").ChatSessionRefreshTarget>();
  chatSideResultTerminalRuns = new Set<string>();
  basePath = "";
  popStateHandler = () => onPopStateInternal(this);
  topbarObserver: ResizeObserver | null = null;
  private globalKeydownHandler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "k") {
      e.preventDefault();
      this.paletteOpen = !this.paletteOpen;
      if (this.paletteOpen) {
        this.paletteQuery = "";
        this.paletteActiveIndex = 0;
      }
    }
  };
  private chatMobileControlsKeydownHandler = (e: KeyboardEvent) => {
    if (e.key !== "Escape") {
      return;
    }
    if (this.chatSessionPickerOpen) {
      e.preventDefault();
      this.chatSessionPickerOpen = false;
      this.chatSessionPickerSurface = null;
      return;
    }
    const openComposerDetails = this.querySelectorAll<HTMLDetailsElement>(
      ".chat-controls__inline-select[open], .agent-chat__talk-select[open], .agent-chat__talk-options-advanced[open]",
    );
    if (openComposerDetails.length > 0) {
      e.preventDefault();
      openComposerDetails.forEach((details) => {
        details.open = false;
      });
      return;
    }
    if (this.realtimeTalkOptionsOpen) {
      e.preventDefault();
      this.realtimeTalkOptionsOpen = false;
      return;
    }
    if (!this.chatMobileControlsOpen) {
      return;
    }
    e.preventDefault();
    this.setChatMobileControlsOpen(false, { restoreFocus: true });
  };
  private chatMobileControlsPointerdownHandler = (e: Event) => {
    const path = e.composedPath();
    this.querySelectorAll<HTMLDetailsElement>(
      ".chat-controls__inline-select[open], .agent-chat__talk-select[open], .agent-chat__talk-options-advanced[open]",
    ).forEach((details) => {
      if (!path.includes(details)) {
        details.open = false;
      }
    });
    if (this.realtimeTalkOptionsOpen) {
      const insideTalkOptions = Array.from(
        this.querySelectorAll(".agent-chat__talk-options, [aria-label='Talk settings']"),
      ).some((node) => path.includes(node));
      if (!insideTalkOptions) {
        this.realtimeTalkOptionsOpen = false;
      }
    }
    if (this.chatSessionPickerOpen) {
      const insidePicker = Array.from(this.querySelectorAll(".chat-controls__session-picker")).some(
        (node) => path.includes(node),
      );
      if (!insidePicker) {
        this.chatSessionPickerOpen = false;
        this.chatSessionPickerSurface = null;
      }
    }
    if (!this.chatMobileControlsOpen) {
      return;
    }
    const wrapper =
      this.querySelector(".chat-settings-popover-wrapper") ??
      this.querySelector(".chat-mobile-controls-wrapper");
    if (wrapper && path.includes(wrapper)) {
      return;
    }
    this.setChatMobileControlsOpen(false);
  };

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.onSlashAction = async (action: string) => {
      switch (action) {
        case "new-session":
          await createChatSessionInternal(this);
          break;
        case "export":
          exportChatMarkdown(this.chatMessages, this.assistantName);
          break;
        case "refresh-tools-effective": {
          await refreshVisibleToolsEffectiveForCurrentSessionInternal(this);
          break;
        }
      }
    };
    document.addEventListener("keydown", this.globalKeydownHandler);
    document.addEventListener("keydown", this.chatMobileControlsKeydownHandler);
    document.addEventListener("pointerdown", this.chatMobileControlsPointerdownHandler);
    handleConnected(this);
    // Restore persisted tabs or initialize with current session
    const persisted = restorePersistedTabs();
    if (persisted && persisted.openTabs.length > 0) {
      // Merge persisted tabs with current session (ensure current session is present)
      const current = this.sessionKey;
      const tabsWithCurrent = persisted.openTabs.includes(current)
        ? persisted.openTabs
        : [current, ...persisted.openTabs.filter((k) => k !== current)];
      this.chatOpenSessionTabs = tabsWithCurrent;
    } else if (!this.chatOpenSessionTabs.includes(this.sessionKey)) {
      this.chatOpenSessionTabs = [this.sessionKey];
    }
    this.nativeBridgeCleanup = initNativeBridge(this);
    void this.initWebPushState();
    // Listen for avatar changes from the lightbox cropper
    this.addEventListener(AvatarChangeEvent.eventName, this.handleAvatarChange);
    document.addEventListener(
      AvatarChangeEvent.eventName,
      this.handleAvatarChange as EventListener,
    );
  }

  protected override firstUpdated() {
    handleFirstUpdated(this);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.globalKeydownHandler);
    this.nativeBridgeCleanup?.();
    this.nativeBridgeCleanup = null;
    document.removeEventListener("keydown", this.chatMobileControlsKeydownHandler);
    document.removeEventListener("pointerdown", this.chatMobileControlsPointerdownHandler);
    if (this.sessionSwitchNoticeTimer !== null) {
      window.clearTimeout(this.sessionSwitchNoticeTimer);
      this.sessionSwitchNoticeTimer = null;
    }
    if (this.sessionSwitchFlashTimer !== null) {
      window.clearTimeout(this.sessionSwitchFlashTimer);
      this.sessionSwitchFlashTimer = null;
    }
    this.chatMobileControlsTrigger = null;
    this.removeEventListener(AvatarChangeEvent.eventName, this.handleAvatarChange);
    document.removeEventListener(
      AvatarChangeEvent.eventName,
      this.handleAvatarChange as EventListener,
    );
    handleDisconnected(this);
    super.disconnectedCallback();
  }

  protected override updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(this, changed);
    // Some render callbacks assign tab directly while preparing nested panel state.
    if (changed.has("tab") && this.tab !== "chat" && this.chatMobileControlsOpen) {
      this.setChatMobileControlsOpen(false);
    }
    if (!changed.has("sessionKey") || this.agentsPanel !== "tools") {
      return;
    }
    const activeSessionAgentId = resolveAgentIdFromSessionKey(this.sessionKey);
    if (this.agentsSelectedId && this.agentsSelectedId === activeSessionAgentId) {
      void loadToolsEffectiveInternal(this, {
        agentId: this.agentsSelectedId,
        sessionKey: this.sessionKey,
      });
      return;
    }
    this.toolsEffectiveResult = null;
    this.toolsEffectiveResultKey = null;
    this.toolsEffectiveError = null;
    this.toolsEffectiveLoading = false;
    this.toolsEffectiveLoadingKey = null;
  }

  connect() {
    connectGatewayInternal(this);
  }

  // ScrollHost callbacks: scroll-near-top first expands the local render window,
  // then falls back to fetching earlier history from the server.
  onHistoryExpand = () => expandHistoryRenderLimitInternal(this);
  onLoadEarlier = () => loadEarlierMessagesInternal(this);

  handleChatScroll(event: Event) {
    handleChatScrollInternal(this, event);
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(this, event);
  }

  handleActivityScroll(event: Event) {
    handleActivityScrollInternal(this, event);
  }

  scheduleActivityScroll(force = false) {
    scheduleActivityScrollInternal(this, force);
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    resetToolStreamInternal(this);
  }

  resetChatScroll() {
    resetChatScrollInternal(this);
  }

  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(this);
    scheduleChatScrollInternal(this, true, Boolean(opts?.smooth), { source: "manual" });
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(this, next);
  }

  applyLocalUserIdentity(next: { name?: string | null; avatar?: string | null }) {
    applyLocalUserIdentityInternal(this, next);
  }

  // Apply an assistant avatar crop/upload: persist the override and sync the
  // chat-header avatar so the agent's picture updates immediately. Shared by the
  // lightbox event and the quick-settings override handler.
  applyAssistantAvatarOverride(dataUrl: string) {
    setAssistantAvatarOverride(this, dataUrl);
    this.chatAvatarUrl = dataUrl;
    this.chatAvatarSource = dataUrl;
    this.chatAvatarStatus = "data";
    this.chatAvatarReason = null;
    this.assistantAvatarUploadError = null;
    this.requestUpdate();
  }

  private handleAvatarChange = (e: Event) => {
    const { avatar, target } = (e as AvatarChangeEvent).detail;
    // Route by target so an agent crop updates the assistant identity, not the
    // user's. Assistant removal isn't offered, so only the set path applies.
    if (target === "assistant" && avatar) {
      this.applyAssistantAvatarOverride(avatar);
      return;
    }
    this.applyLocalUserIdentity({ avatar: avatar || null });
  };

  setTab(next: Tab) {
    setTabInternal(this, next);
    if (next !== "chat") {
      this.setChatMobileControlsOpen(false);
    }
    this.navDrawerOpen = false;
  }

  /** Seed the chat composer and jump to the chat tab (used by the Lab "Discuss" button). */
  openChatWithContext(text: string) {
    // Preserve any in-progress draft — append rather than clobber what was typed.
    this.chatMessage = this.chatMessage.trim() ? `${this.chatMessage}\n\n${text}` : text;
    this.setTab("chat");
  }

  setChatMobileControlsOpen(
    open: boolean,
    options?: { trigger?: HTMLElement | null; restoreFocus?: boolean },
  ) {
    if (open) {
      this.chatMobileControlsTrigger = options?.trigger ?? this.chatMobileControlsTrigger;
      this.chatMobileControlsOpen = true;
      return;
    }

    const focusTarget = options?.restoreFocus ? this.chatMobileControlsTrigger : null;
    this.chatMobileControlsOpen = false;
    if (this.chatSessionPickerSurface === "mobile") {
      this.chatSessionPickerOpen = false;
      this.chatSessionPickerSurface = null;
    }
    this.chatMobileControlsTrigger = null;
    if (!(focusTarget instanceof HTMLElement) || !focusTarget.isConnected) {
      return;
    }
    requestAnimationFrame(() => {
      if (focusTarget.isConnected) {
        focusTarget.focus();
      }
    });
  }

  setTheme(next: ThemeName, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this, next, context);
    this.themeOrder = this.buildThemeOrder(next);
  }

  setThemeMode(next: ThemeMode, context?: Parameters<typeof setThemeModeInternal>[2]) {
    setThemeModeInternal(this, next, context);
  }

  setCustomThemeImportUrl(next: string) {
    this.customThemeImportUrl = next;
    if (this.customThemeImportMessage?.kind === "error") {
      this.customThemeImportMessage = null;
    }
  }

  openCustomThemeImport() {
    this.customThemeImportExpanded = true;
    this.customThemeImportFocusToken += 1;
    if (!this.settings.customTheme) {
      this.customThemeImportSelectOnSuccess = true;
    }
  }

  async importCustomTheme() {
    if (this.customThemeImportBusy) {
      return;
    }
    this.customThemeImportExpanded = true;
    this.customThemeImportBusy = true;
    this.customThemeImportMessage = null;
    try {
      const customTheme = await importCustomThemeFromUrl(this.customThemeImportUrl);
      const shouldSelectImportedTheme =
        this.theme === "custom" ||
        !this.settings.customTheme ||
        this.customThemeImportSelectOnSuccess;
      applySettingsInternal(this, {
        ...this.settings,
        theme: shouldSelectImportedTheme ? "custom" : this.settings.theme,
        customTheme,
      });
      this.themeOrder = this.buildThemeOrder(shouldSelectImportedTheme ? "custom" : this.theme);
      this.customThemeImportUrl = "";
      this.customThemeImportSelectOnSuccess = false;
      this.customThemeImportMessage = {
        kind: "success",
        text: `Imported ${customTheme.label}.`,
      };
    } catch (error) {
      this.customThemeImportMessage = {
        kind: "error",
        text: error instanceof Error ? error.message : "Failed to import tweakcn theme.",
      };
    } finally {
      this.customThemeImportBusy = false;
    }
  }

  clearCustomTheme() {
    const nextTheme = this.theme === "custom" ? "claw" : this.theme;
    this.customThemeImportExpanded = true;
    this.customThemeImportSelectOnSuccess = false;
    applySettingsInternal(this, {
      ...this.settings,
      theme: nextTheme,
      customTheme: undefined,
    });
    this.themeOrder = this.buildThemeOrder(nextTheme);
    this.customThemeImportMessage = {
      kind: "success",
      text: "Cleared custom theme.",
    };
  }

  setBorderRadius(value: number) {
    applySettingsInternal(this, {
      ...this.settings,
      borderRadius: value,
    });
    this.requestUpdate();
  }

  setTextScale(value: number) {
    applySettingsInternal(this, {
      ...this.settings,
      textScale: value as typeof this.settings.textScale,
    });
    this.requestUpdate();
  }

  announceSessionSwitch(sessionKey: string, label: string) {
    const id = ++this.sessionSwitchNoticeSeq;
    if (this.sessionSwitchNoticeTimer !== null) {
      window.clearTimeout(this.sessionSwitchNoticeTimer);
    }
    if (this.sessionSwitchFlashTimer !== null) {
      window.clearTimeout(this.sessionSwitchFlashTimer);
    }
    this.sessionSwitchNotice = {
      id,
      text: t("chat.switchedSession", { session: label }),
    };
    this.sessionSwitchFlashKey = sessionKey;
    this.sessionSwitchFlashTimer = window.setTimeout(() => {
      if (this.sessionSwitchNotice?.id === id) {
        this.sessionSwitchFlashKey = null;
      }
      this.sessionSwitchFlashTimer = null;
    }, 200);
    this.sessionSwitchNoticeTimer = window.setTimeout(() => {
      if (this.sessionSwitchNotice?.id === id) {
        this.sessionSwitchNotice = null;
      }
      this.sessionSwitchNoticeTimer = null;
    }, 2800);
  }

  buildThemeOrder(active: ThemeName): ThemeName[] {
    const all = [...VALID_THEME_NAMES];
    const rest = all.filter((id) => id !== active);
    return [active, ...rest];
  }

  async loadOverview(opts?: { refresh?: boolean }) {
    await loadOverviewInternal(this, opts);
  }

  async loadCron() {
    await loadCronInternal(this);
  }

  async handleAbortChat(opts?: Parameters<typeof handleAbortChatInternal>[1]) {
    await handleAbortChatInternal(this, opts);
  }

  handleChatDraftChange(next: string) {
    handleChatDraftChangeInternal(this, next);
  }

  handleChatInputHistoryKey(input: ChatInputHistoryKeyInput): ChatInputHistoryKeyResult {
    return handleChatInputHistoryKeyInternal(this, input);
  }

  resetChatInputHistoryNavigation() {
    resetChatInputHistoryNavigationInternal(this);
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(this, id);
  }

  async retryQueuedChatMessage(id: string) {
    await retryQueuedChatMessageInternal(this, id);
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    await handleSendChatInternal(this, messageOverride, opts);
  }

  updateRealtimeTalkOptions(next: Partial<typeof this.realtimeTalkOptions>) {
    this.realtimeTalkOptions = { ...this.realtimeTalkOptions, ...next };
  }

  async fetchRealtimeTalkCatalog() {
    if (!this.client || !this.connected) {
      return;
    }
    this.realtimeTalkCatalogProviders = null;
    try {
      const result = await this.client.request<{
        realtime?: { providers?: RealtimeTalkCatalogProvider[] };
      }>("talk.catalog", {});
      const providers = result?.realtime?.providers ?? [];
      this.realtimeTalkCatalogProviders = providers;
      const update = reconcileRealtimeTalkCatalogSelection({
        providers,
        selection: this.realtimeTalkOptions,
      });
      if (update) {
        this.updateRealtimeTalkOptions(update);
      }
    } catch {
      this.realtimeTalkCatalogProviders = null;
    }
  }

  private buildRealtimeTalkLaunchOptions(): RealtimeTalkLaunchOptions {
    const options = this.realtimeTalkOptions ?? {
      provider: "",
      model: "",
      voice: "",
      transport: "",
      vadThreshold: "",
      silenceDurationMs: "",
      prefixPaddingMs: "",
      reasoningEffort: "",
    };
    const text = (value: string) => value.trim() || undefined;
    const number = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return undefined;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const transport = text(options.transport) as RealtimeTalkLaunchOptions["transport"] | undefined;
    return {
      provider: text(options.provider),
      model: text(options.model),
      voice: text(options.voice),
      transport,
      vadThreshold: number(options.vadThreshold),
      silenceDurationMs: number(options.silenceDurationMs),
      prefixPaddingMs: number(options.prefixPaddingMs),
      reasoningEffort: text(options.reasoningEffort),
    };
  }

  async toggleRealtimeTalk() {
    if (this.realtimeTalkSession) {
      if (this.realtimeTalkStatus === "error") {
        this.realtimeTalkSession.stop();
        this.realtimeTalkSession = null;
      } else {
        this.realtimeTalkSession.stop();
        this.realtimeTalkSession = null;
        this.realtimeTalkActive = false;
        this.realtimeTalkStatus = "idle";
        this.realtimeTalkDetail = null;
        this.realtimeTalkTranscript = null;
        this.resetRealtimeTalkConversation();
        return;
      }
    }
    if (!this.client || !this.connected) {
      this.lastError = "Gateway not connected";
      this.chatError = this.lastError;
      return;
    }
    this.realtimeTalkActive = true;
    this.realtimeTalkStatus = "connecting";
    this.realtimeTalkDetail = null;
    this.realtimeTalkTranscript = null;
    this.resetRealtimeTalkConversation();
    const session = new RealtimeTalkSession(
      this.client,
      this.sessionKey,
      {
        onStatus: (status, detail) => {
          this.realtimeTalkStatus = status;
          this.realtimeTalkDetail = detail ?? null;
          if (status === "idle" || status === "error") {
            this.realtimeTalkActive = status !== "idle";
          }
          if (status === "error" && this.realtimeTalkDetail) {
            this.lastError = this.realtimeTalkDetail;
            this.chatError = this.realtimeTalkDetail;
          }
        },
        onTranscript: (entry) => {
          this.realtimeTalkTranscript = `${entry.role === "user" ? "You" : "OpenClaw"}: ${entry.text}`;
          this.realtimeTalkConversationState = updateRealtimeTalkConversation(
            this.realtimeTalkConversationState,
            entry,
          );
          this.realtimeTalkConversation = this.realtimeTalkConversationState.entries;
        },
      },
      this.buildRealtimeTalkLaunchOptions(),
    );
    this.realtimeTalkSession = session;
    try {
      await session.start();
    } catch (error) {
      session.stop();
      if (this.realtimeTalkSession === session) {
        this.realtimeTalkSession = null;
      }
      this.realtimeTalkActive = false;
      this.realtimeTalkStatus = "error";
      this.realtimeTalkDetail = error instanceof Error ? error.message : String(error);
      this.lastError = this.realtimeTalkDetail;
      this.chatError = this.realtimeTalkDetail;
    }
  }

  resetRealtimeTalkConversation() {
    this.realtimeTalkConversationState = createRealtimeTalkConversationState();
    this.realtimeTalkConversation = [];
  }

  async steerQueuedChatMessage(id: string) {
    await steerQueuedChatMessageInternal(this, id);
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      const method = active.kind === "plugin" ? "plugin.approval.resolve" : "exec.approval.resolve";
      await this.client.request(method, {
        id: active.id,
        decision,
      });
      dismissExecApprovalPrompt(this, active.id);
    } catch (err) {
      if (isStaleApprovalResolutionError(err)) {
        dismissExecApprovalPrompt(this, active.id);
        await refreshPendingApprovalQueue(this);
        return;
      }
      if (!this.execApprovalQueue.some((entry) => entry.id === active.id)) {
        return;
      }
      this.execApprovalError = `Approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    const nextToken = this.pendingGatewayToken?.trim() || "";
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
    applySettingsInternal(this, {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
      token: nextToken,
    });
    restoreChatComposerState(this, { preserveCurrent: true });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
    this.pendingGatewayToken = null;
    restoreChatComposerState(this, { preserveCurrent: true });
  }

  private async maybeUpgradeSidebarToFullMessage(content: UpgradableSidebarContent) {
    const request = content.fullMessageRequest;
    if (!request || !this.client) {
      return;
    }
    try {
      const result = (await this.client.request("chat.message.get", {
        sessionKey: request.sessionKey,
        ...(request.agentId ? { agentId: request.agentId } : {}),
        messageId: request.messageId,
        maxChars: FULL_MESSAGE_SIDEBAR_MAX_CHARS,
      })) as
        | {
            ok?: boolean;
            message?: unknown;
            unavailableReason?: "not_found" | "oversized" | "not_visible";
          }
        | undefined;

      if (this.sidebarContent !== content) {
        return;
      }

      if (!result?.ok || !result.message || typeof result.message !== "object") {
        this.sidebarContent = {
          ...content,
          unavailableReason: result?.unavailableReason ?? "not_found",
        };
        this.sidebarError = resolveSidebarUnavailableReason(
          result?.unavailableReason ?? "not_found",
        );
        return;
      }

      const message = result.message as Record<string, unknown>;
      const fetchedMessageText =
        typeof message.text === "string"
          ? message.text
          : typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content
                  .map((block) =>
                    block &&
                    typeof block === "object" &&
                    typeof (block as { text?: unknown }).text === "string"
                      ? (block as { text: string }).text
                      : null,
                  )
                  .filter((value): value is string => typeof value === "string")
                  .join("\n")
              : null;
      const nextRawText =
        fetchedMessageText ??
        (typeof content.rawText === "string"
          ? content.rawText
          : content.kind === "markdown"
            ? content.content
            : null);

      if (content.kind === "markdown") {
        this.sidebarContent = {
          ...content,
          content: nextRawText || content.content,
          rawText: nextRawText || content.rawText || content.content,
          unavailableReason: null,
        };
      } else {
        this.sidebarContent = {
          ...content,
          rawText: nextRawText || content.rawText || null,
          unavailableReason: null,
        };
      }
      this.sidebarError = null;
    } catch (err) {
      if (this.sidebarContent !== content) {
        return;
      }
      this.sidebarError = `Failed to load full content: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: SidebarContent) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
    if (isSidebarMarkdownLike(content) && content.fullMessageRequest) {
      void this.maybeUpgradeSidebarToFullMessage(content);
    }
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  private async initWebPushState() {
    const supported =
      "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    this.webPushSupported = supported;
    this.webPushPermission = supported ? Notification.permission : "unsupported";
    if (supported) {
      try {
        const { getExistingSubscription } = await import("./push-subscription.ts");
        const existing = await getExistingSubscription();
        this.webPushSubscribed = existing !== null;
      } catch {
        // ignore — just means we can't check
      }
    }
  }

  /** Re-register local push subscription with the gateway after connect. */
  async reconcileWebPushState() {
    if (!this.client) {
      return;
    }
    try {
      // Always check PushManager directly — initWebPushState may not have finished
      // yet if gateway connected quickly.
      const { getExistingSubscription } = await import("./push-subscription.ts");
      const existing = await getExistingSubscription();
      if (!existing) {
        return;
      }
      this.webPushSubscribed = true;
      const subJson = existing.toJSON();
      if (subJson.endpoint && subJson.keys?.p256dh && subJson.keys?.auth) {
        await this.client.request("push.web.subscribe", {
          endpoint: subJson.endpoint,
          keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth },
        });
      }
    } catch {
      // Best-effort — don't block if gateway is unreachable.
    }
  }

  async handleWebPushSubscribe() {
    if (!this.client || this.webPushLoading) {
      return;
    }
    this.webPushLoading = true;
    try {
      const { subscribeToWebPush } = await import("./push-subscription.ts");
      await subscribeToWebPush(this.client);
      this.webPushSubscribed = true;
      this.webPushPermission = Notification.permission;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.webPushLoading = false;
      // Always refresh permission state — catches denied prompts too.
      if ("Notification" in window) {
        this.webPushPermission = Notification.permission;
      }
    }
  }

  async handleWebPushUnsubscribe() {
    if (!this.client || this.webPushLoading) {
      return;
    }
    this.webPushLoading = true;
    try {
      const { unsubscribeFromWebPush } = await import("./push-subscription.ts");
      await unsubscribeFromWebPush(this.client);
      this.webPushSubscribed = false;
    } catch (err) {
      this.lastError = String(err);
    } finally {
      this.webPushLoading = false;
    }
  }

  async handleWebPushTest() {
    if (!this.client) {
      return;
    }
    try {
      const { sendTestWebPush } = await import("./push-subscription.ts");
      await sendTestWebPush(this.client);
    } catch (err) {
      this.lastError = String(err);
    }
  }

  override render() {
    return renderApp(this);
  }
}

if (!customElements.get("openclaw-app")) {
  customElements.define("openclaw-app", OpenClawApp);
}
