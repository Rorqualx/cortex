// Control UI module implements app lifecycle behavior.
import { connectGateway, type GatewayHost } from "./app-gateway.ts";
import {
  startLogsPolling,
  startNodesPolling,
  stopLogsPolling,
  stopNodesPolling,
  startDebugPolling,
  stopDebugPolling,
  type PollingHost,
} from "./app-polling.ts";
import {
  observeTopbar,
  scheduleActivityScroll,
  scheduleChatScroll,
  scheduleLogsScroll,
  type ScrollHost,
} from "./app-scroll.ts";
import {
  applySettingsFromUrl,
  detachThemeListener,
  inferBasePath,
  syncTabWithLocation,
  syncThemeWithSettings,
  type SettingsHost,
} from "./app-settings.ts";
import { persistChatComposerState, restoreChatComposerState } from "./chat/composer-persistence.ts";
import {
  startControlUiResponsivenessObserver,
  type ControlUiPerformanceHost,
} from "./control-ui-performance.ts";
import { loadControlUiBootstrapConfig } from "./controllers/control-ui-bootstrap.ts";
import type { ChatQueueItem } from "./ui-types.ts";

const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;

type PendingChatComposerPersistSnapshot = {
  sessionKey: string;
  chatMessage: string;
  chatQueue: ChatQueueItem[];
};

// LifecycleHost is the intersection of every subsystem host the connect/disconnect/update
// lifecycle dispatches into, so dispatch calls pass the host straight through. The literal
// block below carries only lifecycle-owned wiring (connect generation, composer persistence
// debounce, realtime-talk teardown) that no subsystem host type owns.
type LifecycleHost = ControlUiPerformanceHost &
  GatewayHost &
  PollingHost &
  ScrollHost &
  SettingsHost & {
    connectGeneration: number;
    chatManualRefreshInFlight: boolean;
    chatComposerPersistTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
    chatComposerPersistSnapshot?: PendingChatComposerPersistSnapshot | null;
    realtimeTalkSession?: { stop: () => void } | null;
    realtimeTalkActive?: boolean;
    realtimeTalkStatus?: string;
    realtimeTalkDetail?: string | null;
    realtimeTalkTranscript?: string | null;
    realtimeTalkConversation?: unknown[];
    resetRealtimeTalkConversation?: () => void;
    logsAutoFollow: boolean;
    logsEntries: unknown[];
    activityEvents: unknown[];
    controlUiResponsivenessObserver?: { disconnect: () => void } | null;
    popStateHandler: () => void;
  };

export function handleConnected(host: LifecycleHost) {
  const connectGeneration = ++host.connectGeneration;
  host.basePath = inferBasePath();
  applySettingsFromUrl(host);
  host.controlUiBootstrapReady = loadControlUiBootstrapConfig(host, { applyIdentity: false });
  syncTabWithLocation(host, true);
  const hasPendingGatewaySwitch =
    typeof host.pendingGatewayUrl === "string" && host.pendingGatewayUrl.trim();
  if (!hasPendingGatewaySwitch && restoreChatComposerState(host, { preserveCurrent: true })) {
    host.chatComposerProvisionalRestore = {
      sessionKey: host.sessionKey,
      chatMessage: host.chatMessage,
      chatQueue: [...host.chatQueue],
    };
  } else {
    host.chatComposerProvisionalRestore = null;
  }
  syncThemeWithSettings(host);
  window.addEventListener("popstate", host.popStateHandler);
  if (host.connectGeneration === connectGeneration) {
    connectGateway(host);
  }
  if (host.tab === "nodes") {
    startNodesPolling(host);
  }
  if (host.tab === "logs") {
    startLogsPolling(host);
  }
  if (host.tab === "debug") {
    startDebugPolling(host);
  }
  host.controlUiResponsivenessObserver ??= startControlUiResponsivenessObserver(host);
}

export function handleFirstUpdated(host: LifecycleHost) {
  observeTopbar(host);
}

function cancelHostAnimationFrame(frame: number | null | undefined) {
  if (frame != null && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frame);
  }
}

function clearHostTimeout(timeout: number | null | undefined) {
  if (timeout != null && typeof window.clearTimeout === "function") {
    window.clearTimeout(timeout);
  }
}

function clearHostGlobalTimeout(
  timeout: number | ReturnType<typeof globalThis.setTimeout> | null | undefined,
) {
  if (timeout != null) {
    globalThis.clearTimeout(timeout);
  }
}

function clearPendingChatComposerPersistence(host: LifecycleHost) {
  clearHostGlobalTimeout(host.chatComposerPersistTimer);
  host.chatComposerPersistTimer = null;
  host.chatComposerPersistSnapshot = null;
}

function flushPendingChatComposerPersistence(host: LifecycleHost) {
  const snapshot = host.chatComposerPersistSnapshot;
  if (host.chatComposerPersistTimer == null || !snapshot) {
    clearPendingChatComposerPersistence(host);
    return;
  }
  clearPendingChatComposerPersistence(host);
  persistChatComposerState(
    {
      ...host,
      sessionKey: snapshot.sessionKey,
      chatMessage: snapshot.chatMessage,
      chatQueue: snapshot.chatQueue,
    },
    snapshot.sessionKey,
  );
}

function scheduleChatComposerDraftPersistence(host: LifecycleHost) {
  clearPendingChatComposerPersistence(host);
  host.chatComposerPersistSnapshot = {
    sessionKey: host.sessionKey,
    chatMessage: host.chatMessage,
    chatQueue: [...host.chatQueue],
  };
  host.chatComposerPersistTimer = globalThis.setTimeout(() => {
    flushPendingChatComposerPersistence(host);
  }, CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS);
}

export function handleDisconnected(host: LifecycleHost) {
  host.connectGeneration += 1;
  host.controlUiTabPaintSeq = (host.controlUiTabPaintSeq ?? 0) + 1;
  flushPendingChatComposerPersistence(host);
  window.removeEventListener("popstate", host.popStateHandler);
  stopNodesPolling(host);
  stopLogsPolling(host);
  stopDebugPolling(host);
  cancelHostAnimationFrame(host.chatScrollFrame);
  host.chatScrollFrame = null;
  cancelHostAnimationFrame(host.logsScrollFrame);
  host.logsScrollFrame = null;
  cancelHostAnimationFrame(host.activityScrollFrame);
  host.activityScrollFrame = null;
  clearHostTimeout(host.chatScrollTimeout);
  host.chatScrollTimeout = null;
  clearHostGlobalTimeout(host.sessionsChangedReloadTimer);
  host.sessionsChangedReloadTimer = null;
  host.realtimeTalkSession?.stop();
  host.realtimeTalkSession = null;
  host.realtimeTalkActive = false;
  host.realtimeTalkStatus = "idle";
  host.realtimeTalkDetail = null;
  host.realtimeTalkTranscript = null;
  host.resetRealtimeTalkConversation?.();
  host.client?.stop();
  host.client = null;
  host.connected = false;
  detachThemeListener(host);
  host.topbarObserver?.disconnect();
  host.topbarObserver = null;
  host.controlUiResponsivenessObserver?.disconnect();
  host.controlUiResponsivenessObserver = null;
}

export function handleUpdated(host: LifecycleHost, changed: Map<PropertyKey, unknown>) {
  if (changed.has("chatQueue")) {
    clearPendingChatComposerPersistence(host);
    persistChatComposerState(host);
  } else if (changed.has("sessionKey")) {
    flushPendingChatComposerPersistence(host);
    if (changed.has("chatMessage")) {
      persistChatComposerState(host);
    }
  } else if (changed.has("chatMessage")) {
    scheduleChatComposerDraftPersistence(host);
  }
  if (host.tab === "chat" && host.chatManualRefreshInFlight) {
    return;
  }
  if (
    host.tab === "chat" &&
    (changed.has("chatMessages") ||
      changed.has("chatToolMessages") ||
      changed.has("chatStream") ||
      changed.has("chatLoading") ||
      changed.has("realtimeTalkConversation") ||
      changed.has("tab"))
  ) {
    const forcedByTab = changed.has("tab");
    const forcedByLoad =
      changed.has("chatLoading") && changed.get("chatLoading") === true && !host.chatLoading;
    // Detect streaming start: chatStream changed from null/undefined to a string value
    const previousStream = changed.get("chatStream") as string | null | undefined;
    const streamJustStarted =
      changed.has("chatStream") &&
      (previousStream === null || previousStream === undefined) &&
      typeof host.chatStream === "string";
    scheduleChatScroll(
      host,
      forcedByTab || forcedByLoad || streamJustStarted || !host.chatHasAutoScrolled,
    );
  }
  if (
    host.tab === "logs" &&
    (changed.has("logsEntries") || changed.has("logsAutoFollow") || changed.has("tab"))
  ) {
    if (host.logsAutoFollow && host.logsAtBottom) {
      scheduleLogsScroll(host, changed.has("tab") || changed.has("logsAutoFollow"));
    }
  }
  if (
    host.tab === "activity" &&
    (changed.has("activityEvents") || changed.has("activityAutoFollow") || changed.has("tab"))
  ) {
    if (host.activityAutoFollow && host.activityAtBottom) {
      scheduleActivityScroll(host, changed.has("tab") || changed.has("activityAutoFollow"));
    }
  }
}
