/**
 * Controller for the Recursive Self-Improvement Laboratory tab.
 *
 * Holds module-level state (like dreaming-layers) so the tab plugs into
 * app-render with a single render call. Cards live on the dedicated Workboard
 * board `self-improvement-lab`; this controller reads them via the shared
 * `workboard.cards.list` RPC and mutates via `workboard.cards.update`, stamping
 * `metadata.research.userTouched` so the daily ingest cron preserves manual
 * triage. Raw reports come from `workboard.research.reports`.
 */
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { GatewayBrowserClient } from "../gateway.ts";
import type { AgentsListResult } from "../types.ts";

export const RSIL_BOARD_ID = "self-improvement-lab";

export const RSIL_CATEGORY_ORDER = [
  "quick-win",
  "architecture",
  "long-horizon",
  "queue-guidance",
  "contradictory",
  "finding",
  "watch",
] as const;
export type RsilCategory = (typeof RSIL_CATEGORY_ORDER)[number];

// Operator-chosen column order, persisted client-side (a pure display
// preference). Stored categories are validated against RSIL_CATEGORY_ORDER and
// any categories missing from the stored value (e.g. newly added ones) are
// appended in default order so the board never drops a column.
const RSIL_COLUMN_ORDER_KEY = "openclaw.rsil.columnOrder";

function normalizeColumnOrder(value: unknown): RsilCategory[] {
  const known = new Set<RsilCategory>(RSIL_CATEGORY_ORDER);
  const ordered = Array.isArray(value)
    ? value.filter((c): c is RsilCategory => known.has(c as RsilCategory))
    : [];
  const seen = new Set(ordered);
  return [...ordered, ...RSIL_CATEGORY_ORDER.filter((c) => !seen.has(c))];
}

function loadColumnOrder(): RsilCategory[] {
  const raw = getSafeLocalStorage()?.getItem(RSIL_COLUMN_ORDER_KEY);
  if (!raw) {
    return [...RSIL_CATEGORY_ORDER];
  }
  try {
    return normalizeColumnOrder(JSON.parse(raw));
  } catch {
    return [...RSIL_CATEGORY_ORDER];
  }
}

function saveColumnOrder(order: RsilCategory[]): void {
  try {
    getSafeLocalStorage()?.setItem(RSIL_COLUMN_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Best-effort: quota/security errors must not block the in-memory reorder.
  }
}

// RSIL's status set. The core workboard keeps a redundant `todo` alongside
// `backlog` — both are passive parking with identical automation — so the lab
// collapses them: an incoming `todo` normalizes to `backlog` (normalizeCard,
// via the includes() guard) and the board never offers `todo` as its own state.
export const RSIL_STATUSES = [
  "triage",
  "backlog",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;
export type RsilStatus = (typeof RSIL_STATUSES)[number];

// Statuses an operator sets by hand. The rest (scheduled, running, review) are
// driven by the dispatcher/store, so the move dropdown only offers them when the
// card already sits there (moveTargets) — keeping the common case to a short,
// decision-focused list instead of all nine workboard states.
export const RSIL_OPERATOR_STATUSES = [
  "triage",
  "backlog",
  "ready",
  "blocked",
  "done",
] as const satisfies readonly RsilStatus[];
const RSIL_OPERATOR_STATUS_SET = new Set<RsilStatus>(RSIL_OPERATOR_STATUSES);

export type RsilResearchMeta = {
  cycleDate: string;
  itemId: string;
  category: RsilCategory;
  complexity?: string;
  risk?: string;
  sourcePaper?: string;
  sourceFindingRef?: string;
  nextSteps?: string[];
  outcome?: "implemented" | "skipped" | "failed";
  commit?: string;
  userTouched?: boolean;
};

export type RsilCard = {
  id: string;
  title: string;
  notes?: string;
  status: RsilStatus;
  section?: string;
  priority: string;
  labels: string[];
  agentId?: string;
  sourceUrl?: string;
  position: number;
  updatedAt: number;
  archived: boolean;
  research?: RsilResearchMeta;
};

export type RsilReportInfo = { name: string; kind: string; date: string | null; size: number };

export type RsilHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  agentsList: AgentsListResult | null;
  requestUpdate?: () => void;
};

type RsilState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  cards: RsilCard[];
  tab: "board" | "reports";
  cycle: string;
  category: string;
  status: string;
  assignee: string;
  search: string;
  columnOrder: RsilCategory[];
  selectedCardId: string | null;
  busyCardId: string | null;
  reportsLoaded: boolean;
  reportsLoading: boolean;
  reports: RsilReportInfo[];
  activeReport: string | null;
  reportContent: string | null;
  reportLoading: boolean;
  loadGen: number;
};

const state: RsilState = {
  loaded: false,
  loading: false,
  error: null,
  cards: [],
  tab: "board",
  cycle: "",
  category: "",
  status: "",
  assignee: "",
  search: "",
  columnOrder: loadColumnOrder(),
  selectedCardId: null,
  busyCardId: null,
  reportsLoaded: false,
  reportsLoading: false,
  reports: [],
  activeReport: null,
  reportContent: null,
  reportLoading: false,
  loadGen: 0,
};

export function getRsilState(): Readonly<RsilState> {
  return state;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeResearch(value: unknown): RsilResearchMeta | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const category = RSIL_CATEGORY_ORDER.includes(record.category as RsilCategory)
    ? (record.category as RsilCategory)
    : "finding";
  const nextSteps = Array.isArray(record.nextSteps)
    ? record.nextSteps.filter((s): s is string => typeof s === "string")
    : undefined;
  return {
    cycleDate: typeof record.cycleDate === "string" ? record.cycleDate : "",
    itemId: typeof record.itemId === "string" ? record.itemId : "",
    category,
    complexity: typeof record.complexity === "string" ? record.complexity : undefined,
    risk: typeof record.risk === "string" ? record.risk : undefined,
    sourcePaper: typeof record.sourcePaper === "string" ? record.sourcePaper : undefined,
    sourceFindingRef:
      typeof record.sourceFindingRef === "string" ? record.sourceFindingRef : undefined,
    nextSteps,
    outcome:
      record.outcome === "implemented" ||
      record.outcome === "skipped" ||
      record.outcome === "failed"
        ? record.outcome
        : undefined,
    commit: typeof record.commit === "string" ? record.commit : undefined,
    userTouched: record.userTouched === true,
  };
}

function normalizeCard(value: unknown): RsilCard | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.title !== "string") {
    return null;
  }
  const metadata = asRecord(record.metadata);
  const status = RSIL_STATUSES.includes(record.status as RsilStatus)
    ? (record.status as RsilStatus)
    : "backlog";
  return {
    id: record.id,
    title: record.title,
    notes: typeof record.notes === "string" ? record.notes : undefined,
    status,
    section: typeof record.section === "string" ? record.section : undefined,
    priority: typeof record.priority === "string" ? record.priority : "normal",
    labels: Array.isArray(record.labels)
      ? record.labels.filter((l): l is string => typeof l === "string")
      : [],
    agentId: typeof record.agentId === "string" ? record.agentId : undefined,
    sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : undefined,
    position: typeof record.position === "number" ? record.position : 0,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    archived: Boolean(metadata?.archivedAt),
    research: normalizeResearch(metadata?.research),
  };
}

// ── Loaders ────────────────────────────────────────────────────────

export async function ensureRsil(host: RsilHost): Promise<void> {
  if (state.loaded || state.loading) {
    return;
  }
  await reloadRsil(host);
}

export async function reloadRsil(host: RsilHost): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  state.loading = true;
  state.error = null;
  host.requestUpdate?.();
  const gen = ++state.loadGen;
  try {
    const res = await host.client.request<{ cards?: unknown[] }>("workboard.cards.list", {
      boardId: RSIL_BOARD_ID,
    });
    if (gen !== state.loadGen) {
      return;
    }
    // Lab is research-only: keep strictly the cards ingested from the research
    // pipeline (they carry research metadata). This guarantees separation from
    // chat-distilled Workboard tasks even if a card lands on this board.
    state.cards = (res.cards ?? [])
      .map(normalizeCard)
      .filter((c): c is RsilCard => c !== null && c.research != null);
    state.loaded = true;
    if (!state.cycle) {
      // Default the cycle filter to the most recent cycle so the board opens focused.
      state.cycle = cycleDates()[0] ?? "";
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.loading = false;
    host.requestUpdate?.();
  }
}

export async function ensureReports(host: RsilHost): Promise<void> {
  if (state.reportsLoaded || state.reportsLoading || !host.client || !host.connected) {
    return;
  }
  state.reportsLoading = true;
  host.requestUpdate?.();
  try {
    const res = await host.client.request<{ reports?: RsilReportInfo[] }>(
      "workboard.research.reports",
      {},
    );
    state.reports = Array.isArray(res.reports) ? res.reports : [];
    state.reportsLoaded = true;
    if (!state.activeReport && state.reports[0]) {
      void openReport(host, state.reports[0].name);
    }
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.reportsLoading = false;
    host.requestUpdate?.();
  }
}

export async function openReport(host: RsilHost, name: string): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  state.activeReport = name;
  state.reportContent = null;
  state.reportLoading = true;
  host.requestUpdate?.();
  try {
    const res = await host.client.request<{ content?: string }>("workboard.research.reports", {
      name,
    });
    state.reportContent = typeof res.content === "string" ? res.content : "";
  } catch (error) {
    state.reportContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    state.reportLoading = false;
    host.requestUpdate?.();
  }
}

// ── Mutations ──────────────────────────────────────────────────────

async function applyUpdate(
  host: RsilHost,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!host.client || !host.connected) {
    return;
  }
  state.busyCardId = id;
  host.requestUpdate?.();
  try {
    await host.client.request("workboard.cards.update", { id, ...patch });
    await reloadRsil(host);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.busyCardId = null;
    host.requestUpdate?.();
  }
}

/** Build a research patch that flags the card as operator-touched. */
function touchedResearch(card: RsilCard): Record<string, unknown> | undefined {
  return card.research ? { research: { ...card.research, userTouched: true } } : undefined;
}

export function moveCard(host: RsilHost, card: RsilCard, status: RsilStatus): Promise<void> {
  const meta = touchedResearch(card);
  return applyUpdate(host, card.id, { status, ...(meta ? { metadata: meta } : {}) });
}

export function assignCard(host: RsilHost, card: RsilCard, agentId: string): Promise<void> {
  const meta = touchedResearch(card);
  return applyUpdate(host, card.id, {
    agentId: agentId || "",
    ...(meta ? { metadata: meta } : {}),
  });
}

export function saveNextSteps(host: RsilHost, card: RsilCard, steps: string[]): Promise<void> {
  const research = { ...(card.research ?? {}), nextSteps: steps, userTouched: true };
  return applyUpdate(host, card.id, { metadata: { research } });
}

// ── Selectors ──────────────────────────────────────────────────────

export function cycleDates(): string[] {
  const set = new Set<string>();
  for (const card of state.cards) {
    if (!card.archived && card.research?.cycleDate) {
      set.add(card.research.cycleDate);
    }
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}

export function assigneeOptions(host: RsilHost): Array<{ id: string; label: string }> {
  return (host.agentsList?.agents ?? []).map((a) => ({ id: a.id, label: a.name || a.id }));
}

export function filteredCards(): RsilCard[] {
  const search = state.search.trim().toLowerCase();
  return state.cards.filter((card) => {
    if (card.archived) {
      return false;
    }
    if (state.cycle && card.research?.cycleDate !== state.cycle) {
      return false;
    }
    if (state.category && card.research?.category !== state.category) {
      return false;
    }
    if (state.status && card.status !== state.status) {
      return false;
    }
    if (state.assignee === "__unassigned__" && card.agentId) {
      return false;
    }
    if (state.assignee && state.assignee !== "__unassigned__" && card.agentId !== state.assignee) {
      return false;
    }
    if (search && !card.title.toLowerCase().includes(search)) {
      return false;
    }
    return true;
  });
}

// Completed cards collect into the dedicated bottom container, not their
// category column, so the active columns stay focused on in-flight work.
const RSIL_DONE_STATUS: RsilStatus = "done";

export function cardsByCategory(): Array<{ category: RsilCategory; cards: RsilCard[] }> {
  const filtered = filteredCards().filter((c) => c.status !== RSIL_DONE_STATUS);
  return state.columnOrder
    .map((category) => ({
      category,
      cards: filtered
        .filter((c) => (c.research?.category ?? "finding") === category)
        .sort((a, b) => a.position - b.position),
    }))
    .filter((group) => group.cards.length > 0);
}

/**
 * Move column `dragged` to where `target` sits in the persisted order. Dragging
 * rightward drops after the target, leftward drops before it, matching the
 * direction the operator dragged.
 */
export function reorderColumn(host: RsilHost, dragged: RsilCategory, target: RsilCategory): void {
  if (dragged === target) {
    return;
  }
  const order = [...state.columnOrder];
  const from = order.indexOf(dragged);
  const targetIndex = order.indexOf(target);
  if (from === -1 || targetIndex === -1) {
    return;
  }
  const dropAfter = from < targetIndex;
  order.splice(from, 1);
  const insertAt = order.indexOf(target) + (dropAfter ? 1 : 0);
  order.splice(insertAt, 0, dragged);
  state.columnOrder = order;
  saveColumnOrder(order);
  host.requestUpdate?.();
}

// Move-dropdown targets: operator states plus the card's current state, so an
// auto-managed status (scheduled/running/review) stays visible and reversible
// without cluttering the dropdown for cards that never entered those states.
export function moveTargets(card: RsilCard): RsilStatus[] {
  return RSIL_STATUSES.filter((s) => RSIL_OPERATOR_STATUS_SET.has(s) || s === card.status);
}

// Status-filter options limited to statuses actually present on the board, so
// empty states drop out of the filter dropdown (auto-hide). Derived from all
// non-archived cards, not the post-status-filter set, so picking a status never
// removes the other options.
export function filterStatuses(): RsilStatus[] {
  const present = new Set<RsilStatus>();
  for (const card of state.cards) {
    if (!card.archived) {
      present.add(card.status);
    }
  }
  return RSIL_STATUSES.filter((s) => present.has(s));
}

/** Done cards across all categories, for the full-width bottom container. */
export function doneCards(): RsilCard[] {
  return filteredCards()
    .filter((c) => c.status === RSIL_DONE_STATUS)
    .sort((a, b) => a.position - b.position);
}

export function selectedCard(): RsilCard | null {
  return state.cards.find((c) => c.id === state.selectedCardId) ?? null;
}

export function setTab(host: RsilHost, tab: "board" | "reports"): void {
  state.tab = tab;
  host.requestUpdate?.();
  if (tab === "reports") {
    void ensureReports(host);
  }
}

export function setFilter(
  host: RsilHost,
  key: "cycle" | "category" | "status" | "assignee" | "search",
  value: string,
): void {
  state[key] = value;
  host.requestUpdate?.();
}

export function openCard(host: RsilHost, id: string | null): void {
  state.selectedCardId = id;
  host.requestUpdate?.();
}

/** Drop cached data on disconnect so a reconnect re-fetches fresh. */
export function resetRsil(): void {
  state.loaded = false;
  state.reportsLoaded = false;
  state.cards = [];
  state.reports = [];
  state.activeReport = null;
  state.reportContent = null;
  state.loadGen += 1;
}
