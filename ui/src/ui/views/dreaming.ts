// Control UI view renders dreaming screen content.
import { html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../../i18n/index.ts";
import { agentAvatarUrl } from "../avatar/agent-avatar.ts";
import { ALL_AGENTS_ID } from "../controllers/dreaming.ts";
import type {
  DreamingEntry,
  WikiImportInsights,
  WikiMemoryPalace,
} from "../controllers/dreaming.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import {
  type DreamingL3Layer,
  ensureDreamingLayers,
  renderDreamingLayersSection,
  resetDreamingLayers,
} from "./dreaming-layers.ts";

// ── Diary entry parser ─────────────────────────────────────────────────

type DiaryEntry = {
  date: string;
  body: string;
};

type DiaryEntryNav = {
  date: string;
  body: string;
  page: number;
};

const DIARY_START_RE = /<!--\s*openclaw:dreaming:diary:start\s*-->/;
const DIARY_END_RE = /<!--\s*openclaw:dreaming:diary:end\s*-->/;

function parseDiaryEntries(raw: string): DiaryEntry[] {
  // Extract content between diary markers, or use full content.
  let content = raw;
  const startMatch = DIARY_START_RE.exec(raw);
  const endMatch = DIARY_END_RE.exec(raw);
  if (startMatch && endMatch && endMatch.index > startMatch.index) {
    content = raw.slice(startMatch.index + startMatch[0].length, endMatch.index);
  }

  const entries: DiaryEntry[] = [];
  // Split on --- separators.
  const blocks = content.split(/\n---\n/).filter((b) => b.trim().length > 0);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let date = "";
    const bodyLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      // Date lines are wrapped in *asterisks* like: *April 5, 2026, 3:00 AM*
      if (!date && trimmed.startsWith("*") && trimmed.endsWith("*") && trimmed.length > 2) {
        date = trimmed.slice(1, -1);
        continue;
      }
      // Skip heading lines and HTML comments.
      if (trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
        continue;
      }
      if (trimmed.length > 0) {
        bodyLines.push(trimmed);
      }
    }

    if (bodyLines.length > 0) {
      entries.push({ date, body: bodyLines.join("\n") });
    }
  }

  return entries;
}

function parseDiaryTimestamp(date: string): number | null {
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDiaryChipLabel(date: string): string {
  // Diary dates like "June 24, 2026 at 3:00 AM MDT" fail Date.parse, so fall back
  // to the leading date portion before the time; keeps chips compact (6/24)
  // instead of dumping the whole raw string into a pill.
  const parsed = parseDiaryTimestamp(date) ?? parseDiaryTimestamp(date.split(/\s+at\s+/i)[0] ?? "");
  if (parsed === null) {
    return date;
  }
  const value = new Date(parsed);
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

function buildDiaryNavigation(entries: DiaryEntry[]): DiaryEntryNav[] {
  const reversed = [...entries].toReversed();
  return reversed.map((entry, page) => Object.assign({}, entry, { page }));
}

type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
};

type DreamingAgentOption = {
  id: string;
  label: string;
  avatar?: string | null;
  avatarUrl?: string | null;
};

// Stacked-circle glyph standing in for the aggregate "all agents" option, which
// has no single agent identity to draw an avatar from.
const allAgentsGlyph = html`
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="9" cy="10" r="5" fill="currentColor" opacity="0.45" />
    <circle cx="15" cy="10" r="5" fill="currentColor" opacity="0.45" />
    <circle cx="12" cy="14" r="5" fill="currentColor" opacity="0.75" />
  </svg>
`;

function renderDreamingAgentAvatar(entry: DreamingAgentOption) {
  if (entry.id === ALL_AGENTS_ID) {
    return html`<span class="dreams__agent-avatar dreams__agent-avatar--all" aria-hidden="true">
      ${allAgentsGlyph}
    </span>`;
  }
  return html`<img
    class="dreams__agent-avatar"
    src=${agentAvatarUrl(entry.id, { avatar: entry.avatar, avatarUrl: entry.avatarUrl })}
    alt=""
    aria-hidden="true"
    loading="lazy"
  />`;
}

export type DreamingProps = {
  active: boolean;
  selectedAgentId: string;
  agentOptions: DreamingAgentOption[];
  shortTermCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  promotedCount: number;
  promotedTotal: number;
  lastPromotedCount: number;
  lastPromotedAt: string | null;
  phases?: {
    light: DreamingPhaseInfo;
    deep: DreamingPhaseInfo;
    rem: DreamingPhaseInfo;
  };
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  dreamingOf: string | null;
  nextCycle: string | null;
  timezone: string | null;
  statusLoading: boolean;
  statusError: string | null;
  modeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  memoryWikiEnabled: boolean;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: WikiImportInsights | null;
  wikiMemoryPalaceLoading: boolean;
  wikiMemoryPalaceError: string | null;
  wikiMemoryPalace: WikiMemoryPalace | null;
  onRefresh: () => void;
  onSelectAgent: (agentId: string) => void;
  onRefreshDiary: () => void;
  onRefreshImports: () => void;
  onRefreshMemoryPalace: () => void;
  onOpenConfig: () => void;
  onOpenWikiPage: (lookup: string) => Promise<{
    title: string;
    path: string;
    content: string;
    totalLines?: number;
    truncated?: boolean;
    updatedAt?: string;
  } | null>;
  onLoadL3LayerList: () => Promise<DreamingL3Layer[]>;
  onLoadL3LayerContent: (layerId: string) => Promise<string | null>;
  onBackfillDiary: () => void;
  onCopyDreamingArchivePath: () => void;
  onDedupeDreamDiary: () => void;
  onResetDiary: () => void;
  onResetGroundedShortTerm: () => void;
  onRepairDreamingArtifacts: () => void;
  onRequestUpdate?: () => void;
};

const DREAM_PHRASE_KEYS = [
  "dreaming.phrases.consolidatingMemories",
  "dreaming.phrases.tidyingKnowledgeGraph",
  "dreaming.phrases.replayingConversations",
  "dreaming.phrases.weavingShortTerm",
  "dreaming.phrases.defragmentingMindPalace",
  "dreaming.phrases.filingLooseThoughts",
  "dreaming.phrases.connectingDots",
  "dreaming.phrases.compostingContext",
  "dreaming.phrases.alphabetizingSubconscious",
  "dreaming.phrases.promotingHunches",
  "dreaming.phrases.forgettingNoise",
  "dreaming.phrases.dreamingEmbeddings",
  "dreaming.phrases.reorganizingAttic",
  "dreaming.phrases.indexingDay",
  "dreaming.phrases.nurturingInsights",
  "dreaming.phrases.simmeringIdeas",
  "dreaming.phrases.whisperingVectorStore",
] as const;

const DREAM_PHASE_LABEL_KEYS = {
  light: "dreaming.phase.light",
  deep: "dreaming.phase.deep",
  rem: "dreaming.phase.rem",
} as const;

let dreamIndex = Math.floor(Math.random() * DREAM_PHRASE_KEYS.length);
let dreamLastSwap = 0;
const DREAM_SWAP_MS = 6_000;

// ── Sub-tab state ─────────────────────────────────────────────────────

type DreamSubTab = "scene" | "diary" | "advanced" | "layers";
let activeSubTab: DreamSubTab = "scene";
type DreamDiarySubTab = "dreams" | "insights" | "palace";
let activeDiarySubTab: DreamDiarySubTab = "dreams";
type DiaryDateView = "badges" | "timeline" | "dropdown";
let diaryDateView: DiaryDateView = "badges";
type AdvancedWaitingSort = "recent" | "signals";
let advancedWaitingSort: AdvancedWaitingSort = "recent";
const expandedInsightCards = new Set<string>();
const expandedPalaceCards = new Set<string>();
let wikiPreviewOpen = false;
let wikiPreviewLoading = false;
let wikiPreviewTitle = "";
let wikiPreviewPath = "";
let wikiPreviewUpdatedAt: string | null = null;
let wikiPreviewContent = "";
let wikiPreviewTotalLines: number | null = null;
let wikiPreviewTruncated = false;
let wikiPreviewError: string | null = null;

export function setDreamSubTab(tab: DreamSubTab): void {
  activeSubTab = tab;
}

export function setDreamAdvancedWaitingSort(sort: AdvancedWaitingSort): void {
  advancedWaitingSort = sort;
}

export function setDreamDiarySubTab(tab: DreamDiarySubTab): void {
  activeDiarySubTab = tab;
}

export function setDiaryDateView(view: DiaryDateView): void {
  diaryDateView = view;
}

// ── Diary pagination state ─────────────────────────────────────────────

let diaryPage = 0;
let diaryEntryCount = 0;

/** Navigate to a specific diary page. Triggers a re-render via Lit's reactive cycle. */
export function setDiaryPage(page: number): void {
  diaryPage = Math.max(0, Math.min(page, Math.max(0, diaryEntryCount - 1)));
}

function currentDreamPhrase(): string {
  const now = Date.now();
  if (now - dreamLastSwap > DREAM_SWAP_MS) {
    dreamLastSwap = now;
    dreamIndex = (dreamIndex + 1) % DREAM_PHRASE_KEYS.length;
  }
  return t(DREAM_PHRASE_KEYS[dreamIndex] ?? DREAM_PHRASE_KEYS[0]);
}

const STARS: {
  top: number;
  left: number;
  size: number;
  delay: number;
  hue: "neutral" | "accent";
}[] = [
  { top: 8, left: 15, size: 3, delay: 0, hue: "neutral" },
  { top: 12, left: 72, size: 2, delay: 1.4, hue: "neutral" },
  { top: 22, left: 35, size: 3, delay: 0.6, hue: "accent" },
  { top: 18, left: 88, size: 2, delay: 2.1, hue: "neutral" },
  { top: 35, left: 8, size: 2, delay: 0.9, hue: "neutral" },
  { top: 45, left: 92, size: 2, delay: 1.7, hue: "neutral" },
  { top: 55, left: 25, size: 3, delay: 2.5, hue: "accent" },
  { top: 65, left: 78, size: 2, delay: 0.3, hue: "neutral" },
  { top: 75, left: 45, size: 2, delay: 1.1, hue: "neutral" },
  { top: 82, left: 60, size: 3, delay: 1.8, hue: "accent" },
  { top: 30, left: 55, size: 2, delay: 0.4, hue: "neutral" },
  { top: 88, left: 18, size: 2, delay: 2.3, hue: "neutral" },
];

const sleepingLobster = html`
  <svg viewBox="0 0 120 120" fill="none">
    <defs>
      <linearGradient id="dream-lob-g" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#ff4d4d" />
        <stop offset="100%" stop-color="#991b1b" />
      </linearGradient>
    </defs>
    <path
      d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110L55 110L55 100C55 100 60 102 65 100L65 110L75 110L75 100C90 95 105 75 105 55C105 35 90 10 60 10Z"
      fill="url(#dream-lob-g)"
    />
    <path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="url(#dream-lob-g)" />
    <path
      d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z"
      fill="url(#dream-lob-g)"
    />
    <path d="M45 15Q38 8 35 14" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" />
    <path d="M75 15Q82 8 85 14" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round" />
    <path
      d="M39 36Q45 32 51 36"
      stroke="#050810"
      stroke-width="2.5"
      stroke-linecap="round"
      fill="none"
    />
    <path
      d="M69 36Q75 32 81 36"
      stroke="#050810"
      stroke-width="2.5"
      stroke-linecap="round"
      fill="none"
    />
  </svg>
`;

export function renderDreaming(props: DreamingProps) {
  const idle = !props.active;
  const dreamText = props.dreamingOf ?? currentDreamPhrase();

  return html`
    <div class="dreams-page">
      <!-- ── Sub-tab bar ── -->
      <div class="dreams__topbar">
        <nav class="dreams__tabs">
          <button
            class="dreams__tab ${activeSubTab === "scene" ? "dreams__tab--active" : ""}"
            @click=${() => {
              activeSubTab = "scene";
              props.onRequestUpdate?.();
            }}
          >
            ${t("dreaming.tabs.scene")}
          </button>
          <button
            class="dreams__tab ${activeSubTab === "diary" ? "dreams__tab--active" : ""}"
            @click=${() => {
              activeSubTab = "diary";
              props.onRequestUpdate?.();
            }}
          >
            ${t("dreaming.tabs.diary")}
          </button>
          <button
            class="dreams__tab ${activeSubTab === "advanced" ? "dreams__tab--active" : ""}"
            @click=${() => {
              activeSubTab = "advanced";
              props.onRequestUpdate?.();
            }}
          >
            ${t("dreaming.tabs.advanced")}
          </button>
          <button
            class="dreams__tab ${activeSubTab === "layers" ? "dreams__tab--active" : ""}"
            @click=${() => {
              activeSubTab = "layers";
              void ensureDreamingLayers(props);
              props.onRequestUpdate?.();
            }}
          >
            ${t("dreaming.tabs.layers")}
          </button>
        </nav>
        ${props.agentOptions.length > 1
          ? html`<div
              class="dreams__agent-select"
              role="group"
              data-dreaming-agent-select="true"
              aria-label=${t("dreaming.agentSelect.ariaLabel")}
            >
              <span class="dreams__agent-label">${t("dreaming.agentSelect.label")}</span>
              <div class="dreams__agent-buttons">
                ${repeat(
                  props.agentOptions,
                  (entry) => entry.id,
                  (entry) => {
                    const selected = entry.id === props.selectedAgentId;
                    return html`<button
                      type="button"
                      class=${`dreams__agent-button${selected ? " dreams__agent-button--active" : ""}`}
                      data-dreaming-agent-button=${entry.id}
                      aria-pressed=${selected ? "true" : "false"}
                      @click=${() => {
                        if (entry.id === props.selectedAgentId) {
                          return;
                        }
                        resetDreamingLayers();
                        props.onSelectAgent(entry.id);
                        if (activeSubTab === "layers") {
                          void ensureDreamingLayers(props);
                        }
                      }}
                    >
                      ${renderDreamingAgentAvatar(entry)}
                      <span class="dreams__agent-name">${entry.label}</span>
                    </button>`;
                  },
                )}
              </div>
            </div>`
          : nothing}
      </div>

      ${activeSubTab === "scene"
        ? renderScene(props, idle, dreamText)
        : activeSubTab === "diary"
          ? renderDiarySection(props)
          : activeSubTab === "advanced"
            ? renderAdvancedSection(props)
            : renderDreamingLayersSection(props)}
    </div>
  `;
}

// ── Scene renderer ────────────────────────────────────────────────────

// Strip source citations like [memory/2026-04-09.md:9] and section headings,
// flatten structured diary entries into plain paragraphs.
function flattenDiaryBody(body: string): string[] {
  return (
    body
      .split("\n")
      .map((line) => line.trim())
      // Remove section headings that leak implementation
      .filter(
        (line) =>
          line.length > 0 &&
          line !== "What Happened" &&
          line !== "Reflections" &&
          line !== "Candidates" &&
          line !== "Possible Lasting Updates",
      )
      // Strip source citations [memory/...]
      .map((line) => line.replace(/\s*\[memory\/[^\]]+\]/g, ""))
      // Strip leading list markers and labels
      .map((line) =>
        line
          .replace(/^(?:\d+\.\s+|-\s+(?:\[[^\]]+\]\s+)?(?:[a-z_]+:\s+)?)/i, "")
          .replace(/^(?:likely_durable|likely_situational|unclear):\s+/i, "")
          .trim(),
      )
      .filter((line) => line.length > 0)
  );
}

function formatPhaseNextRun(nextRunAtMs?: number): string {
  if (!nextRunAtMs) {
    return "—";
  }
  const d = new Date(nextRunAtMs);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function resolveDreamerAvatar(props: DreamingProps): string | null {
  const selected = props.agentOptions.find((option) => option.id === props.selectedAgentId);
  if (!selected || selected.id === ALL_AGENTS_ID) {
    return null;
  }
  return agentAvatarUrl(selected.id, { avatar: selected.avatar, avatarUrl: selected.avatarUrl });
}

// Breathing avatar shown beside the diary so it reads as the agent whose dreams
// are on screen; the generic crab stands in for the aggregate "all agents" view.
function renderDiaryCompanion(props: DreamingProps) {
  const dreamer = resolveDreamerAvatar(props);
  const selected = props.agentOptions.find((option) => option.id === props.selectedAgentId);
  const figure = dreamer
    ? html`<img class="dreams-diary__avatar" src=${dreamer} alt="" aria-hidden="true" />`
    : html`<div class="dreams-diary__avatar dreams-diary__avatar--crab" aria-hidden="true">
        ${sleepingLobster}
      </div>`;
  return html`
    <aside class="dreams-diary__companion" aria-hidden="true">
      <div class="dreams-diary__companion-figure">${figure}</div>
      ${selected?.label
        ? html`<div class="dreams-diary__companion-name">${selected.label}</div>`
        : nothing}
    </aside>
  `;
}

function renderScene(props: DreamingProps, idle: boolean, dreamText: string) {
  // When a single agent is selected, that agent dreams in the scene; the generic
  // OpenClaw crab stands in for the aggregate "all agents" view.
  const dreamerAvatar = resolveDreamerAvatar(props);
  return html`
    <section class="dreams ${idle ? "dreams--idle" : ""}">
      ${STARS.map(
        (s) => html`
          <div
            class="dreams__star"
            style="
              top: ${s.top}%;
              left: ${s.left}%;
              width: ${s.size}px;
              height: ${s.size}px;
              background: ${s.hue === "accent" ? "var(--accent-muted)" : "var(--text)"};
              animation-delay: ${s.delay}s;
            "
          ></div>
        `,
      )}

      <div class="dreams__moon"></div>

      ${props.active
        ? html`
            <div class="dreams__bubble">
              <span class="dreams__bubble-text">${dreamText}</span>
            </div>
            <div
              class="dreams__bubble-dot"
              style="top: calc(50% - 160px); left: calc(50% - 120px); width: 12px; height: 12px; animation-delay: 0.2s;"
            ></div>
            <div
              class="dreams__bubble-dot"
              style="top: calc(50% - 120px); left: calc(50% - 90px); width: 8px; height: 8px; animation-delay: 0.4s;"
            ></div>
          `
        : nothing}

      <div class="dreams__glow"></div>
      <div class="dreams__lobster">
        ${dreamerAvatar
          ? html`<img
              class="dreams__dreamer-avatar"
              src=${dreamerAvatar}
              alt=""
              aria-hidden="true"
            />`
          : sleepingLobster}
      </div>
      <span class="dreams__z">z</span>
      <span class="dreams__z">z</span>
      <span class="dreams__z">Z</span>

      <div class="dreams__status">
        <span class="dreams__status-label"
          >${props.active ? t("dreaming.status.active") : t("dreaming.status.idle")}</span
        >
        <div class="dreams__status-detail">
          <div class="dreams__status-dot"></div>
          <span>
            ${props.promotedTotal} ${t("dreaming.status.promotedTotalSuffix")}
            ${props.lastPromotedAt
              ? html`· ${t("dreaming.status.lastPromotedPrefix")} ${props.lastPromotedCount}
                (${formatCompactDateTime(props.lastPromotedAt)})`
              : html`· ${t("dreaming.status.lastPromotedNever")}`}
            ${props.nextCycle
              ? html`· ${t("dreaming.status.nextSweepPrefix")} ${props.nextCycle}`
              : nothing}
            ${props.timezone ? html`· ${props.timezone}` : nothing}
          </span>
        </div>
      </div>

      <!-- Sleep phases -->
      <div class="dreams__phases">
        ${(Object.keys(DREAM_PHASE_LABEL_KEYS) as (keyof typeof DREAM_PHASE_LABEL_KEYS)[]).map(
          (phaseId) => {
            const phase = props.phases?.[phaseId];
            const hasPhaseStatus = phase !== undefined;
            const enabled = phase?.enabled === true;
            const nextRun = formatPhaseNextRun(phase?.nextRunAtMs);
            const label = t(DREAM_PHASE_LABEL_KEYS[phaseId]);
            const status = !hasPhaseStatus ? "—" : enabled ? nextRun : t("dreaming.phase.off");
            return html`
              <div class="dreams__phase ${hasPhaseStatus && !enabled ? "dreams__phase--off" : ""}">
                <div class="dreams__phase-dot ${enabled ? "dreams__phase-dot--on" : ""}"></div>
                <span class="dreams__phase-name">${label}</span>
                <span class="dreams__phase-next">${status}</span>
              </div>
            `;
          },
        )}
      </div>

      ${props.statusError
        ? html`<div class="dreams__controls-error">${props.statusError}</div>`
        : nothing}
    </section>
  `;
}

function formatRange(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

function formatCompactDateTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").findLast(Boolean) ?? value;
}

function formatKindLabel(kind: "entity" | "concept" | "source" | "synthesis" | "report"): string {
  switch (kind) {
    case "entity":
      return "entity";
    case "concept":
      return "concept";
    case "source":
      return "source";
    case "synthesis":
      return "synthesis";
    case "report":
      return "report";
  }
  return kind;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

const MEMORY_PALACE_PAGE_COUNT_ORDER: Array<keyof WikiMemoryPalace["pageCounts"]> = [
  "source",
  "synthesis",
  "report",
  "entity",
  "concept",
];

function formatMemoryPalacePageCountLabel(kind: keyof WikiMemoryPalace["pageCounts"]): string {
  switch (kind) {
    case "source":
      return "Sources";
    case "synthesis":
      return "Syntheses";
    case "report":
      return "Reports";
    case "entity":
      return "Entities";
    case "concept":
      return "Concepts";
  }
  return kind;
}

function formatMemoryPalacePageBreakdown(pageCounts: WikiMemoryPalace["pageCounts"]): string {
  const parts = MEMORY_PALACE_PAGE_COUNT_ORDER.map((kind) => {
    const count = pageCounts[kind];
    return count > 0
      ? `${formatMemoryPalacePageCountLabel(kind)} · ${formatCount(count, "page")}`
      : null;
  }).filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join("; ") : "No pages yet";
}

function formatMemoryPalaceClusterSummary(cluster: WikiMemoryPalace["clusters"][number]): string {
  const parts = [`${cluster.label}: ${formatCount(cluster.itemCount, "page")}`];
  if (cluster.claimCount > 0) {
    parts.push(formatCount(cluster.claimCount, "claim row"));
  }
  if (cluster.questionCount > 0) {
    const questionPageCount = cluster.items.filter((item) => item.questionCount > 0).length;
    const questionPageSuffix =
      questionPageCount > 0 ? ` on ${formatCount(questionPageCount, "page")}` : "";
    parts.push(`${formatCount(cluster.questionCount, "open question")}${questionPageSuffix}`);
  }
  if (cluster.contradictionCount > 0) {
    parts.push(formatCount(cluster.contradictionCount, "contradiction"));
  }
  return parts.join(" · ");
}

function formatImportBadge(item: {
  digestStatus: "available" | "withheld";
  riskLevel: "low" | "medium" | "high" | "unknown";
}): string {
  if (item.digestStatus === "withheld") {
    return "needs review";
  }
  switch (item.riskLevel) {
    case "low":
      return "low risk";
    case "medium":
      return "medium risk";
    case "high":
      return "high risk";
    case "unknown":
      return "unknown risk";
  }
  return "unknown risk";
}

function toggleExpandedCard(bucket: Set<string>, key: string, requestUpdate?: () => void): void {
  if (bucket.has(key)) {
    bucket.delete(key);
  } else {
    bucket.add(key);
  }
  requestUpdate?.();
}

async function openWikiPreview(lookup: string, props: DreamingProps): Promise<void> {
  wikiPreviewOpen = true;
  wikiPreviewLoading = true;
  wikiPreviewTitle = basename(lookup);
  wikiPreviewPath = lookup;
  wikiPreviewUpdatedAt = null;
  wikiPreviewContent = "";
  wikiPreviewTotalLines = null;
  wikiPreviewTruncated = false;
  wikiPreviewError = null;
  props.onRequestUpdate?.();
  try {
    const preview = await props.onOpenWikiPage(lookup);
    if (!preview) {
      wikiPreviewError = `No wiki page found for ${lookup}.`;
      return;
    }
    wikiPreviewTitle = preview.title;
    wikiPreviewPath = preview.path;
    wikiPreviewUpdatedAt = preview.updatedAt ?? null;
    wikiPreviewContent = preview.content;
    wikiPreviewTotalLines = typeof preview.totalLines === "number" ? preview.totalLines : null;
    wikiPreviewTruncated = preview.truncated === true;
  } catch (error) {
    wikiPreviewError = String(error);
  } finally {
    wikiPreviewLoading = false;
    props.onRequestUpdate?.();
  }
}

function closeWikiPreview(requestUpdate?: () => void): void {
  wikiPreviewOpen = false;
  wikiPreviewLoading = false;
  wikiPreviewTitle = "";
  wikiPreviewPath = "";
  wikiPreviewUpdatedAt = null;
  wikiPreviewContent = "";
  wikiPreviewTotalLines = null;
  wikiPreviewTruncated = false;
  wikiPreviewError = null;
  requestUpdate?.();
}

function renderWikiPreviewOverlay(props: DreamingProps) {
  if (!wikiPreviewOpen) {
    return nothing;
  }
  return html`
    <div
      class="dreams-diary__preview-backdrop"
      @click=${() => closeWikiPreview(props.onRequestUpdate)}
    >
      <div class="dreams-diary__preview-panel" @click=${(event: Event) => event.stopPropagation()}>
        <div class="dreams-diary__preview-header">
          <div>
            <div class="dreams-diary__preview-title">${wikiPreviewTitle || "Wiki page"}</div>
            <div class="dreams-diary__preview-meta">
              ${wikiPreviewPath} ${wikiPreviewUpdatedAt ? ` · ${wikiPreviewUpdatedAt}` : ""}
            </div>
          </div>
          <button
            class="btn btn--subtle btn--sm"
            @click=${() => closeWikiPreview(props.onRequestUpdate)}
          >
            Close
          </button>
        </div>
        <div class="dreams-diary__preview-body">
          ${wikiPreviewLoading
            ? html`<div class="dreams-diary__empty-text">Loading wiki page…</div>`
            : wikiPreviewError
              ? html`<div class="dreams-diary__error">${wikiPreviewError}</div>`
              : html`
                  ${wikiPreviewTruncated
                    ? html`
                        <div class="dreams-diary__preview-hint">
                          Showing the first chunk of this
                          page${wikiPreviewTotalLines !== null
                            ? ` (${wikiPreviewTotalLines} total lines)`
                            : ""}.
                        </div>
                      `
                    : nothing}
                  <pre class="dreams-diary__preview-pre">${wikiPreviewContent}</pre>
                `}
        </div>
      </div>
    </div>
  `;
}

function renderDiarySubtabExplainer() {
  switch (activeDiarySubTab) {
    case "dreams":
      return html`
        <p class="dreams-diary__explainer">
          This is the raw dream diary the system writes while replaying and consolidating memory;
          use it to inspect what the memory system is noticing, and where it still looks noisy or
          thin.
        </p>
      `;
    case "insights":
      return html`
        <p class="dreams-diary__explainer">
          These are imported insights clustered from external history; use them to review what
          imports surfaced before any of it graduates into durable memory.
        </p>
      `;
    case "palace":
      return html`
        <p class="dreams-diary__explainer">
          This is the compiled memory wiki surface the system can search and reason over; use it to
          inspect actual memory pages, claims, open questions, and contradictions rather than raw
          imported source chats.
        </p>
      `;
  }
  return nothing;
}

function parseSortableTimestamp(value?: string): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareWaitingEntryByRecency(a: DreamingEntry, b: DreamingEntry): number {
  const aMs = parseSortableTimestamp(a.lastRecalledAt);
  const bMs = parseSortableTimestamp(b.lastRecalledAt);
  if (bMs !== aMs) {
    return bMs - aMs;
  }
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  return a.path.localeCompare(b.path);
}

function compareWaitingEntryBySignals(a: DreamingEntry, b: DreamingEntry): number {
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  if (b.phaseHitCount !== a.phaseHitCount) {
    return b.phaseHitCount - a.phaseHitCount;
  }
  return compareWaitingEntryByRecency(a, b);
}

function sortWaitingEntries(entries: DreamingEntry[], sort: AdvancedWaitingSort): DreamingEntry[] {
  return sort === "signals"
    ? entries.toSorted(compareWaitingEntryBySignals)
    : entries.toSorted(compareWaitingEntryByRecency);
}

function describeWaitingEntryOrigin(entry: DreamingEntry): string {
  const hasGroundedReplay = entry.groundedCount > 0;
  const hasLiveSupport = entry.recallCount > 0 || entry.dailyCount > 0;
  if (hasGroundedReplay && hasLiveSupport) {
    return t("dreaming.advanced.originMixed");
  }
  if (hasGroundedReplay) {
    return t("dreaming.advanced.originDailyLog");
  }
  return t("dreaming.advanced.originLive");
}

function renderAdvancedEntryList(params: {
  titleKey: string;
  descriptionKey: string;
  emptyKey: string;
  entries: DreamingEntry[];
  meta: (entry: DreamingEntry) => string[];
  badge?: (entry: DreamingEntry) => string | null;
  controls?: ReturnType<typeof html>;
}) {
  return html`
    <details class="dreams-advanced__section" open>
      <summary class="dreams-advanced__section-header">
        <span class="dreams-advanced__section-title">${t(params.titleKey)}</span>
        <span class="dreams-advanced__section-count">${params.entries.length}</span>
        <span class="dreams-advanced__section-chevron" aria-hidden="true"></span>
      </summary>
      <div class="dreams-advanced__section-body">
        <div class="dreams-advanced__section-bar">
          <p class="dreams-advanced__section-description">${t(params.descriptionKey)}</p>
          ${params.controls
            ? html`<div class="dreams-advanced__section-toolbar">${params.controls}</div>`
            : nothing}
        </div>
        ${params.entries.length === 0
          ? html`<div class="dreams-advanced__empty">${t(params.emptyKey)}</div>`
          : html`
              <div class="dreams-advanced__list">
                ${params.entries.map(
                  (entry) => html`
                    <article class="dreams-advanced__item" data-entry-key=${entry.key}>
                      <div class="dreams-advanced__snippet">${entry.snippet}</div>
                      <div class="dreams-advanced__chips">
                        ${params.badge
                          ? (() => {
                              const label = params.badge?.(entry);
                              return label
                                ? html`<span class="dreams-advanced__badge">${label}</span>`
                                : nothing;
                            })()
                          : nothing}
                        <span class="dreams-advanced__source">
                          ${formatRange(entry.path, entry.startLine, entry.endLine)}
                        </span>
                        ${params
                          .meta(entry)
                          .filter((part) => part.length > 0)
                          .map(
                            (part) => html`<span class="dreams-advanced__meta-chip">${part}</span>`,
                          )}
                      </div>
                    </article>
                  `,
                )}
              </div>
            `}
      </div>
    </details>
  `;
}

function renderAdvancedSection(props: DreamingProps) {
  const groundedEntries = props.shortTermEntries.filter((entry) => entry.groundedCount > 0);
  const waitingEntries = sortWaitingEntries(props.shortTermEntries, advancedWaitingSort);
  const description = t("dreaming.advanced.description");
  const stats = [
    { value: groundedEntries.length, label: t("dreaming.advanced.summaryFromDailyLog") },
    { value: props.shortTermCount, label: t("dreaming.advanced.summaryWaiting") },
    { value: props.promotedCount, label: t("dreaming.advanced.summaryPromotedToday") },
  ];

  return html`
    <section class="dreams-advanced">
      <div class="dreams-advanced__header">
        <div class="dreams-advanced__intro">
          <span class="dreams-advanced__eyebrow">${t("dreaming.advanced.eyebrow")}</span>
          <h2 class="dreams-advanced__title">${t("dreaming.advanced.title")}</h2>
          ${description
            ? html`<p class="dreams-advanced__description">${description}</p>`
            : nothing}
        </div>
        <div class="dreams-advanced__actions">
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onDedupeDreamDiary()}
          >
            ${t("dreaming.scene.dedupeDiary")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onRepairDreamingArtifacts()}
          >
            ${t("dreaming.scene.repairCache")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onBackfillDiary()}
          >
            ${props.dreamDiaryActionLoading
              ? t("dreaming.scene.working")
              : t("dreaming.scene.backfill")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onResetDiary()}
          >
            ${t("dreaming.scene.reset")}
          </button>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
            @click=${() => props.onResetGroundedShortTerm()}
          >
            ${t("dreaming.scene.clearGrounded")}
          </button>
        </div>
      </div>
      <div class="dreams-advanced__stats">
        ${stats.map(
          (stat) => html`
            <div class="dreams-advanced__stat">
              <span class="dreams-advanced__stat-value">${stat.value}</span>
              <span class="dreams-advanced__stat-label">${stat.label}</span>
            </div>
          `,
        )}
      </div>
      ${props.dreamDiaryActionMessage
        ? html`
            <div
              class="callout ${props.dreamDiaryActionMessage.kind === "success"
                ? "success"
                : "danger"}"
              role="status"
            >
              <div class="row wrap items-center gap-2">
                <span>${props.dreamDiaryActionMessage.text}</span>
                ${props.dreamDiaryActionArchivePath
                  ? html`
                      <button
                        class="btn btn--subtle btn--sm"
                        ?disabled=${props.dreamDiaryActionLoading}
                        @click=${() => props.onCopyDreamingArchivePath()}
                      >
                        Copy archive path
                      </button>
                    `
                  : nothing}
              </div>
            </div>
          `
        : nothing}

      <div class="dreams-advanced__sections">
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.stagedTitle",
          descriptionKey: "dreaming.advanced.stagedDescription",
          emptyKey: "dreaming.advanced.emptyGrounded",
          entries: groundedEntries,
          controls: html`
            <button
              class="btn btn--subtle btn--sm"
              ?disabled=${props.modeSaving || props.dreamDiaryActionLoading}
              @click=${() => props.onResetGroundedShortTerm()}
            >
              ${t("dreaming.scene.clearGrounded")}
            </button>
          `,
          badge: () => t("dreaming.advanced.originDailyLog"),
          meta: (entry) => [
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.recallCount > 0 ? `${entry.recallCount} recall` : "",
            entry.dailyCount > 0 ? `${entry.dailyCount} daily` : "",
          ],
        })}
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.shortTermTitle",
          descriptionKey: "dreaming.advanced.shortTermDescription",
          emptyKey: "dreaming.advanced.emptyShortTerm",
          entries: waitingEntries,
          controls: html`
            <div class="dreams-advanced__sort">
              <button
                class="dreams-advanced__sort-btn ${advancedWaitingSort === "recent"
                  ? "dreams-advanced__sort-btn--active"
                  : ""}"
                @click=${() => {
                  advancedWaitingSort = "recent";
                  props.onRequestUpdate?.();
                }}
              >
                ${t("dreaming.advanced.sortRecent")}
              </button>
              <button
                class="dreams-advanced__sort-btn ${advancedWaitingSort === "signals"
                  ? "dreams-advanced__sort-btn--active"
                  : ""}"
                @click=${() => {
                  advancedWaitingSort = "signals";
                  props.onRequestUpdate?.();
                }}
              >
                ${t("dreaming.advanced.sortSignals")}
              </button>
            </div>
          `,
          badge: (entry) => describeWaitingEntryOrigin(entry),
          meta: (entry) => [
            `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`,
            entry.recallCount > 0 ? `${entry.recallCount} recall` : "",
            entry.dailyCount > 0 ? `${entry.dailyCount} daily` : "",
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.phaseHitCount > 0 ? `${entry.phaseHitCount} phase hit` : "",
          ],
        })}
        ${renderAdvancedEntryList({
          titleKey: "dreaming.advanced.promotedTitle",
          descriptionKey: "dreaming.advanced.promotedDescription",
          emptyKey: "dreaming.advanced.emptyPromoted",
          entries: props.promotedEntries,
          badge: (entry) => describeWaitingEntryOrigin(entry),
          meta: (entry) => [
            entry.promotedAt
              ? `${t("dreaming.advanced.updatedPrefix")} ${formatCompactDateTime(entry.promotedAt)}`
              : "",
            entry.groundedCount > 0
              ? `${entry.groundedCount} ${t("dreaming.stats.grounded").toLowerCase()}`
              : "",
            entry.totalSignalCount > 0
              ? `${entry.totalSignalCount} ${t("dreaming.stats.signals").toLowerCase()}`
              : "",
          ],
        })}
      </div>

      ${props.statusError
        ? html`<div class="dreams__controls-error">${props.statusError}</div>`
        : nothing}
    </section>
  `;
}

function renderDiaryImportsSection(props: DreamingProps) {
  const importInsights = props.wikiImportInsights;
  const clusters = importInsights?.clusters ?? [];

  if (props.wikiImportInsightsLoading && clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">Loading imported insights…</div>
      </div>
    `;
  }

  if (clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">No imported insights yet</div>
        <div class="dreams-diary__empty-hint">
          Run a ChatGPT import with apply to surface clustered imported insights here.
        </div>
      </div>
    `;
  }

  diaryEntryCount = clusters.length;
  const clusterIndex = Math.max(0, Math.min(diaryPage, clusters.length - 1));
  const cluster = clusters[clusterIndex];

  return html`
    <div class="dreams-diary__daychips">
      ${clusters.map(
        (entry, index) => html`
          <button
            class="dreams-diary__day-chip ${index === clusterIndex
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(index);
              props.onRequestUpdate?.();
            }}
          >
            ${entry.label}
          </button>
        `,
      )}
    </div>

    <article class="dreams-diary__entry" key="imports-${cluster.key}">
      <div class="dreams-diary__accent"></div>
      <div class="dreams-diary__date">
        ${cluster.label} · ${cluster.itemCount} chats
        ${cluster.highRiskCount > 0 ? html`· ${cluster.highRiskCount} sensitive` : nothing}
        ${cluster.preferenceSignalCount > 0
          ? html`· ${cluster.preferenceSignalCount} signals`
          : nothing}
      </div>
      <div class="dreams-diary__prose">
        <p class="dreams-diary__para">
          Imported chats clustered around ${cluster.label.toLowerCase()}.
          ${cluster.withheldCount > 0
            ? ` ${cluster.withheldCount} digest${cluster.withheldCount === 1 ? " was" : "s were"} withheld pending review.`
            : ""}
        </p>
      </div>
      <div class="dreams-diary__insights">
        ${cluster.items.map((item) => {
          const expanded = expandedInsightCards.has(item.pagePath);
          return html`
            <article
              class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
              data-import-page=${item.pagePath}
              @click=${() =>
                toggleExpandedCard(expandedInsightCards, item.pagePath, props.onRequestUpdate)}
            >
              <div class="dreams-diary__insight-topline">
                <div class="dreams-diary__insight-title">${item.title}</div>
                <span
                  class="dreams-diary__insight-badge dreams-diary__insight-badge--${item.riskLevel}"
                >
                  ${formatImportBadge(item)}
                </span>
              </div>
              <div class="dreams-diary__insight-meta">
                ${item.updatedAt ? formatCompactDateTime(item.updatedAt) : basename(item.pagePath)}
                ${item.activeBranchMessages > 0 ? ` · ${item.activeBranchMessages} messages` : ""}
              </div>
              <p class="dreams-diary__insight-line">${item.summary}</p>
              ${item.candidateSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>Potentially useful signals</strong>
                      ${item.candidateSignals.map(
                        (signal) => html`<p class="dreams-diary__insight-line">• ${signal}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.correctionSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>Corrections or revisions</strong>
                      ${item.correctionSignals.map(
                        (signal) => html`<p class="dreams-diary__insight-line">• ${signal}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${expanded
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>Import details</strong>
                      ${item.firstUserLine
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>Started with:</strong> ${item.firstUserLine}
                            </p>
                          `
                        : nothing}
                      ${item.lastUserLine && item.lastUserLine !== item.firstUserLine
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>Ended on:</strong> ${item.lastUserLine}
                            </p>
                          `
                        : nothing}
                      <p class="dreams-diary__insight-line">
                        <strong>Messages:</strong> ${item.userMessageCount} user ·
                        ${item.assistantMessageCount} assistant
                      </p>
                      ${item.riskReasons.length > 0
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>Risk reasons:</strong> ${item.riskReasons.join(", ")}
                            </p>
                          `
                        : nothing}
                      ${item.labels.length > 0
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>Labels:</strong> ${item.labels.join(", ")}
                            </p>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
              ${item.preferenceSignals.length > 0
                ? html`
                    <div class="dreams-diary__insight-signals">
                      ${item.preferenceSignals.map(
                        (signal) =>
                          html`<span class="dreams-diary__insight-signal">${signal}</span>`,
                      )}
                    </div>
                  `
                : nothing}
              <div class="dreams-diary__insight-actions">
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    toggleExpandedCard(expandedInsightCards, item.pagePath, props.onRequestUpdate);
                  }}
                >
                  ${expanded ? "Hide details" : "Details"}
                </button>
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    void openWikiPreview(item.pagePath, props);
                  }}
                >
                  Open source page
                </button>
              </div>
            </article>
          `;
        })}
      </div>
    </article>
  `;
}

function renderMemoryPalaceSection(props: DreamingProps) {
  const palace = props.wikiMemoryPalace;
  const clusters = palace?.clusters ?? [];

  if (props.wikiMemoryPalaceLoading && clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">Loading memory palace…</div>
      </div>
    `;
  }

  if (clusters.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">Memory palace is not populated yet</div>
        <div class="dreams-diary__empty-hint">
          Right now the wiki mostly has raw source imports and operational reports. This tab becomes
          useful once syntheses, entities, or concepts start getting written.
        </div>
      </div>
    `;
  }

  diaryEntryCount = clusters.length;
  const clusterIndex = Math.max(0, Math.min(diaryPage, clusters.length - 1));
  const cluster = clusters[clusterIndex];
  const totalPages = palace?.totalPages ?? palace?.totalItems ?? 0;
  const totalClaims = palace?.totalClaims ?? 0;
  const totalQuestions = palace?.totalQuestions ?? 0;
  const totalContradictions = palace?.totalContradictions ?? 0;
  const pageBreakdown = palace
    ? formatMemoryPalacePageBreakdown(palace.pageCounts)
    : "No pages yet";
  const clusterSummary = formatMemoryPalaceClusterSummary(cluster);

  return html`
    <div class="dreams-diary__daychips">
      ${clusters.map(
        (entry, index) => html`
          <button
            class="dreams-diary__day-chip ${index === clusterIndex
              ? "dreams-diary__day-chip--active"
              : ""}"
            @click=${() => {
              setDiaryPage(index);
              props.onRequestUpdate?.();
            }}
          >
            ${entry.label}
          </button>
        `,
      )}
    </div>

    <article class="dreams-diary__entry" key="palace-${cluster.key}">
      <div class="dreams-diary__accent"></div>
      <div class="dreams-diary__date">
        Vault · ${formatCount(totalPages, "page")}
        ${totalClaims > 0 ? html`· ${formatCount(totalClaims, "claim row")}` : nothing}
        ${totalQuestions > 0 ? html`· ${formatCount(totalQuestions, "open question")}` : nothing}
        ${totalContradictions > 0
          ? html`· ${formatCount(totalContradictions, "contradiction")}`
          : nothing}
      </div>
      <div class="dreams-diary__prose">
        <p class="dreams-diary__para">Full vault breakdown: ${pageBreakdown}.</p>
        <p class="dreams-diary__para">
          Selected section: ${clusterSummary}.
          ${cluster.updatedAt ? ` Latest update ${formatCompactDateTime(cluster.updatedAt)}.` : ""}
        </p>
      </div>
      <div class="dreams-diary__insights">
        ${cluster.items.map((item) => {
          const expanded = expandedPalaceCards.has(item.pagePath);
          return html`
            <article
              class="dreams-diary__insight-card dreams-diary__insight-card--clickable"
              data-palace-page=${item.pagePath}
              @click=${() => {
                if (item.kind === "report") {
                  void openWikiPreview(item.pagePath, props);
                  return;
                }
                toggleExpandedCard(expandedPalaceCards, item.pagePath, props.onRequestUpdate);
              }}
            >
              <div class="dreams-diary__insight-topline">
                <div class="dreams-diary__insight-title">${item.title}</div>
                <span class="dreams-diary__insight-badge dreams-diary__insight-badge--palace">
                  ${formatKindLabel(item.kind)}
                </span>
              </div>
              <div class="dreams-diary__insight-meta">
                ${item.updatedAt ? formatCompactDateTime(item.updatedAt) : basename(item.pagePath)}
                · ${item.pagePath}
              </div>
              ${item.snippet
                ? html`<p class="dreams-diary__insight-line">${item.snippet}</p>`
                : nothing}
              ${item.claims.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>Claims</strong>
                      ${item.claims.map(
                        (claim) => html`<p class="dreams-diary__insight-line">• ${claim}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.questions.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>Open questions</strong>
                      ${item.questions.map(
                        (question) => html`<p class="dreams-diary__insight-line">• ${question}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${item.contradictions.length > 0
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>Contradictions</strong>
                      ${item.contradictions.map(
                        (entry) => html`<p class="dreams-diary__insight-line">• ${entry}</p>`,
                      )}
                    </div>
                  `
                : nothing}
              ${expanded
                ? html`
                    <div class="dreams-diary__insight-list">
                      <strong>Page details</strong>
                      <p class="dreams-diary__insight-line">
                        <strong>Wiki page:</strong> ${item.pagePath}
                      </p>
                      ${item.id
                        ? html`
                            <p class="dreams-diary__insight-line">
                              <strong>Id:</strong> ${item.id}
                            </p>
                          `
                        : nothing}
                    </div>
                  `
                : nothing}
              <div class="dreams-diary__insight-actions">
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    toggleExpandedCard(expandedPalaceCards, item.pagePath, props.onRequestUpdate);
                  }}
                >
                  ${expanded ? "Hide details" : "Details"}
                </button>
                <button
                  class="btn btn--subtle btn--sm"
                  @click=${(event: Event) => {
                    event.stopPropagation();
                    void openWikiPreview(item.pagePath, props);
                  }}
                >
                  Open wiki page
                </button>
              </div>
            </article>
          `;
        })}
      </div>
    </article>
  `;
}

const DIARY_DATE_VIEWS: { id: DiaryDateView; label: string }[] = [
  { id: "badges", label: "Badges" },
  { id: "timeline", label: "Timeline" },
  { id: "dropdown", label: "Dropdown" },
];

// Date navigation for the dream diary with three interchangeable presentations:
// the scrolling badge row, a vertical timeline, or a compact dropdown. All three
// drive the same diary page so switching views never loses the reader's place.
function renderDiaryDateNav(entries: DiaryEntryNav[], page: number, props: DreamingProps) {
  const select = (target: number) => {
    setDiaryPage(target);
    props.onRequestUpdate?.();
  };
  return html`
    <div class="dreams-diary__datenav">
      <div class="dreams-diary__dateview" role="group" aria-label="Date view">
        ${DIARY_DATE_VIEWS.map(
          (view) => html`
            <button
              class="dreams-diary__dateview-btn ${diaryDateView === view.id
                ? "dreams-diary__dateview-btn--active"
                : ""}"
              aria-pressed=${diaryDateView === view.id ? "true" : "false"}
              @click=${() => {
                setDiaryDateView(view.id);
                props.onRequestUpdate?.();
              }}
            >
              ${view.label}
            </button>
          `,
        )}
      </div>
      ${diaryDateView === "badges"
        ? renderDiaryDateBadges(entries, page, select)
        : diaryDateView === "dropdown"
          ? renderDiaryDateDropdown(entries, page, select)
          : nothing}
    </div>
  `;
}

function renderDiaryDateBadges(
  entries: DiaryEntryNav[],
  page: number,
  select: (page: number) => void,
) {
  return html`
    <div class="dreams-diary__daychips">
      ${entries.map(
        (entry) => html`
          <button
            class="dreams-diary__day-chip ${entry.page === page
              ? "dreams-diary__day-chip--active"
              : ""}"
            title=${entry.date}
            @click=${() => select(entry.page)}
          >
            ${formatDiaryChipLabel(entry.date)}
          </button>
        `,
      )}
    </div>
  `;
}

function renderDiaryDateDropdown(
  entries: DiaryEntryNav[],
  page: number,
  select: (page: number) => void,
) {
  return html`
    <label class="dreams-diary__dateselect">
      <select
        .value=${String(page)}
        @change=${(event: Event) => select(Number((event.target as HTMLSelectElement).value))}
      >
        ${entries.map(
          (entry) => html`
            <option value=${entry.page} ?selected=${entry.page === page}>
              ${entry.date || formatDiaryChipLabel(entry.date)}
            </option>
          `,
        )}
      </select>
    </label>
  `;
}

// One diary entry's date header + prose. The dropdown view already names the
// selected date, so it suppresses the header to avoid printing the date twice.
function renderDiaryEntryArticle(entry: DiaryEntryNav, showDate = true) {
  return html`
    <article class="dreams-diary__entry" key="${entry.page}">
      <div class="dreams-diary__accent"></div>
      ${showDate && entry.date
        ? html`<time class="dreams-diary__date">${entry.date}</time>`
        : nothing}
      <div class="dreams-diary__prose">
        ${flattenDiaryBody(entry.body).map(
          (para, i) =>
            html`<p class="dreams-diary__para" style="animation-delay: ${0.3 + i * 0.15}s;">
              ${unsafeHTML(toSanitizedMarkdownHtml(para))}
            </p>`,
        )}
      </div>
    </article>
  `;
}

function renderDreamDiaryEntries(props: DreamingProps) {
  if (typeof props.dreamDiaryContent !== "string") {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-moon">
          <svg viewBox="0 0 32 32" fill="none" width="32" height="32">
            <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="0.5" opacity="0.2" />
            <path d="M20 8a10 10 0 0 1 0 16 10 10 0 1 0 0-16z" fill="currentColor" opacity="0.08" />
          </svg>
        </div>
        <div class="dreams-diary__empty-text">${t("dreaming.diary.noDreamsYet")}</div>
        <div class="dreams-diary__empty-hint">${t("dreaming.diary.noDreamsHint")}</div>
      </div>
    `;
  }

  const entries = parseDiaryEntries(props.dreamDiaryContent);
  diaryEntryCount = entries.length;

  if (entries.length === 0) {
    return html`
      <div class="dreams-diary__empty">
        <div class="dreams-diary__empty-text">${t("dreaming.diary.waitingTitle")}</div>
        <div class="dreams-diary__empty-hint">${t("dreaming.diary.waitingHint")}</div>
      </div>
    `;
  }

  const reversed = buildDiaryNavigation(entries);
  const page = Math.max(0, Math.min(diaryPage, reversed.length - 1));
  const entry = reversed[page];

  // Timeline shows every entry as a feed; badges/dropdown show one. The dropdown
  // already names the selected date, so its single entry hides its date header.
  const body =
    diaryDateView === "timeline"
      ? reversed.map((item) => renderDiaryEntryArticle(item))
      : renderDiaryEntryArticle(entry, diaryDateView !== "dropdown");

  return html`
    ${renderDiaryDateNav(reversed, page, props)}
    <div class="dreams-diary__layout">
      <div class="dreams-diary__entries">${body}</div>
      ${renderDiaryCompanion(props)}
    </div>
  `;
}

// ── Diary section renderer ────────────────────────────────────────────

function renderDiarySection(props: DreamingProps) {
  const wikiTabSelected = activeDiarySubTab === "insights" || activeDiarySubTab === "palace";
  const memoryWikiUnavailable = wikiTabSelected && !props.memoryWikiEnabled;
  const diaryError =
    activeDiarySubTab === "dreams"
      ? props.dreamDiaryError
      : activeDiarySubTab === "insights"
        ? props.wikiImportInsightsError
        : props.wikiMemoryPalaceError;
  if (diaryError && !memoryWikiUnavailable) {
    return html`
      <section class="dreams-diary">
        <div class="dreams-diary__error">${diaryError}</div>
      </section>
    `;
  }

  return html`
    <section class="dreams-diary">
      <div class="dreams-diary__chrome">
        <div class="dreams-diary__header">
          <span class="dreams-diary__title">${t("dreaming.diary.title")}</span>
          <div class="dreams-diary__subtabs">
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "dreams"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                closeWikiPreview();
                activeDiarySubTab = "dreams";
                diaryPage = 0;
                props.onRequestUpdate?.();
              }}
            >
              Dreams
            </button>
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "insights"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                closeWikiPreview();
                activeDiarySubTab = "insights";
                diaryPage = 0;
                props.onRequestUpdate?.();
              }}
            >
              Imported Insights
            </button>
            <button
              class="dreams-diary__subtab ${activeDiarySubTab === "palace"
                ? "dreams-diary__subtab--active"
                : ""}"
              @click=${() => {
                closeWikiPreview();
                activeDiarySubTab = "palace";
                diaryPage = 0;
                props.onRequestUpdate?.();
              }}
            >
              Memory Palace
            </button>
          </div>
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${memoryWikiUnavailable
              ? false
              : props.modeSaving ||
                (activeDiarySubTab === "dreams"
                  ? props.dreamDiaryLoading
                  : activeDiarySubTab === "insights"
                    ? props.wikiImportInsightsLoading
                    : props.wikiMemoryPalaceLoading)}
            @click=${() => {
              diaryPage = 0;
              if (memoryWikiUnavailable) {
                props.onOpenConfig();
              } else if (activeDiarySubTab === "dreams") {
                props.onRefreshDiary();
              } else if (activeDiarySubTab === "insights") {
                props.onRefreshImports();
              } else {
                props.onRefreshMemoryPalace();
              }
            }}
          >
            ${memoryWikiUnavailable
              ? "How to enable"
              : activeDiarySubTab === "dreams"
                ? props.dreamDiaryLoading
                  ? t("dreaming.diary.reloading")
                  : t("dreaming.diary.reload")
                : activeDiarySubTab === "insights"
                  ? props.wikiImportInsightsLoading
                    ? "Reloading…"
                    : "Reload"
                  : props.wikiMemoryPalaceLoading
                    ? "Reloading…"
                    : "Reload"}
          </button>
        </div>
        ${renderDiarySubtabExplainer()}
      </div>

      ${memoryWikiUnavailable
        ? html`
            <div class="dreams-diary__empty">
              <div class="dreams-diary__empty-text">Memory Wiki is not enabled</div>
              <div class="dreams-diary__empty-hint">
                Imported Insights and Memory Palace are provided by the bundled
                <code>memory-wiki</code> plugin.
              </div>
              <div class="dreams-diary__empty-hint">
                Enable <code>plugins.entries.memory-wiki.enabled = true</code>, then reload this
                tab.
              </div>
              <div class="dreams-diary__empty-actions">
                <button class="btn btn--subtle btn--sm" @click=${() => props.onOpenConfig()}>
                  Open Config
                </button>
              </div>
            </div>
          `
        : activeDiarySubTab === "dreams"
          ? renderDreamDiaryEntries(props)
          : activeDiarySubTab === "insights"
            ? renderDiaryImportsSection(props)
            : renderMemoryPalaceSection(props)}
      ${renderWikiPreviewOverlay(props)}
    </section>
  `;
}
