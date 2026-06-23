/**
 * Recursive Self-Improvement Laboratory view.
 *
 * Renders the dedicated Workboard board (`self-improvement-lab`) populated by
 * the daily-research ingest: a category-grouped board with move/assign controls,
 * an item detail drawer with editable next-steps, and a raw-reports browser.
 * State + RPCs live in controllers/rsil.ts.
 */
import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../../i18n/index.ts";
import { agentAvatarUrl } from "../avatar/agent-avatar.ts";
import {
  assignCard,
  assigneeOptions,
  cardsByCategory,
  cycleDates,
  doneCards,
  ensureRsil,
  filteredCards,
  filterStatuses,
  getRsilState,
  moveCard,
  moveTargets,
  openCard,
  openReport,
  reorderColumn,
  reloadRsil,
  type RsilCard,
  type RsilCategory,
  type RsilHost,
  type RsilReportInfo,
  type RsilStatus,
  saveNextSteps,
  selectedCard,
  setFilter,
  setTab,
} from "../controllers/rsil.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";

function statusLabel(status: RsilStatus): string {
  return t(`workboard.status.${status}`);
}

function categoryLabel(category: string): string {
  return t(`rsil.category.${category}`);
}

function stopClick(event: Event): void {
  event.stopPropagation();
}

// Transient drag state for column reordering (cleared on drop/dragend).
let draggedColumn: RsilCategory | null = null;

function clearColumnDragClasses(): void {
  document
    .querySelectorAll(".rsil__col--dragging, .rsil__col--drag-over")
    .forEach((el) => el.classList.remove("rsil__col--dragging", "rsil__col--drag-over"));
}

function onColHeadDragStart(event: DragEvent, category: RsilCategory): void {
  draggedColumn = category;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", category);
  }
  (event.currentTarget as HTMLElement).closest(".rsil__col")?.classList.add("rsil__col--dragging");
}

function onColHeadDragEnd(): void {
  draggedColumn = null;
  clearColumnDragClasses();
}

function onColDragOver(event: DragEvent): void {
  if (!draggedColumn) {
    return;
  }
  // Only preventDefault for a column drag so the column becomes a valid drop
  // target; other drags (text, files) keep their native behavior.
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "move";
  }
  (event.currentTarget as HTMLElement).classList.add("rsil__col--drag-over");
}

function onColDragLeave(event: DragEvent): void {
  (event.currentTarget as HTMLElement).classList.remove("rsil__col--drag-over");
}

function onColDrop(host: RsilHost, event: DragEvent, target: RsilCategory): void {
  if (!draggedColumn) {
    return;
  }
  event.preventDefault();
  (event.currentTarget as HTMLElement).classList.remove("rsil__col--drag-over");
  const dragged = draggedColumn;
  draggedColumn = null;
  clearColumnDragClasses();
  reorderColumn(host, dragged, target);
}

function renderBadges(card: RsilCard): TemplateResult {
  const r = card.research;
  return html`
    <div class="rsil-card__badges">
      <span class="badge rsil-badge--${card.status}">${statusLabel(card.status)}</span>
      ${r?.complexity
        ? html`<span class="badge">${t("rsil.cardComplexity")}: ${r.complexity}</span>`
        : nothing}
      ${r?.risk
        ? html`<span class="badge rsil-badge--risk-${r.risk.toLowerCase()}"
            >${t("rsil.cardRisk")}: ${r.risk}</span
          >`
        : nothing}
      ${r?.outcome
        ? html`<span class="badge rsil-badge--${r.outcome}">${r.outcome}</span>`
        : nothing}
    </div>
  `;
}

function renderStatusSelect(host: RsilHost, card: RsilCard): TemplateResult {
  const busy = getRsilState().busyCardId === card.id;
  return html`
    <label class="rsil-card__control" @click=${stopClick}>
      <span>${t("rsil.moveTo")}</span>
      <select
        ?disabled=${busy}
        .value=${card.status}
        @change=${(e: Event) =>
          moveCard(host, card, (e.target as HTMLSelectElement).value as RsilStatus)}
      >
        ${moveTargets(card).map(
          (s) => html`<option value=${s} ?selected=${s === card.status}>${statusLabel(s)}</option>`,
        )}
      </select>
    </label>
  `;
}

function renderAssigneeSelect(host: RsilHost, card: RsilCard): TemplateResult {
  const busy = getRsilState().busyCardId === card.id;
  const options = assigneeOptions(host);
  const assignee = card.agentId?.trim();
  // Honor the agent's assigned avatar (else generated invader), like the office.
  const assigneeIdentity = host.agentsList?.agents.find((a) => a.id === assignee)?.identity;
  return html`
    <label class="rsil-card__control rsil-assignee" @click=${stopClick}>
      ${assignee
        ? html`<img
            class="rsil-assignee__img"
            src=${agentAvatarUrl(assignee, assigneeIdentity)}
            alt=""
          />`
        : nothing}
      <span>${t("rsil.assignTo")}</span>
      <select
        ?disabled=${busy}
        .value=${card.agentId ?? ""}
        @change=${(e: Event) => assignCard(host, card, (e.target as HTMLSelectElement).value)}
      >
        <option value="">${t("rsil.unassigned")}</option>
        ${options.map(
          (o) => html`<option value=${o.id} ?selected=${o.id === card.agentId}>${o.label}</option>`,
        )}
      </select>
    </label>
  `;
}

function renderCard(host: RsilHost, card: RsilCard): TemplateResult {
  return html`
    <article
      class="rsil-card ${getRsilState().selectedCardId === card.id ? "rsil-card--active" : ""}"
      @click=${() => openCard(host, card.id)}
    >
      <div class="rsil-card__title">${card.title}</div>
      ${renderBadges(card)}
      <div class="rsil-card__foot">
        ${renderStatusSelect(host, card)} ${renderAssigneeSelect(host, card)}
      </div>
    </article>
  `;
}

function renderFilters(host: RsilHost): TemplateResult {
  const s = getRsilState();
  const cycles = cycleDates();
  const count = filteredCards().length;
  return html`
    <div class="rsil__filters">
      <label class="rsil__filter">
        <span>${t("rsil.filterCycle")}</span>
        <select
          @change=${(e: Event) => setFilter(host, "cycle", (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${s.cycle === ""}>${t("rsil.allCycles")}</option>
          ${cycles.map((c) => html`<option value=${c} ?selected=${c === s.cycle}>${c}</option>`)}
        </select>
      </label>
      <label class="rsil__filter">
        <span>${t("rsil.filterStatus")}</span>
        <select
          @change=${(e: Event) => setFilter(host, "status", (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${s.status === ""}>${t("rsil.allStatuses")}</option>
          ${filterStatuses().map(
            (st) =>
              html`<option value=${st} ?selected=${st === s.status}>${statusLabel(st)}</option>`,
          )}
        </select>
      </label>
      <label class="rsil__filter">
        <span>${t("rsil.filterAssignee")}</span>
        <select
          @change=${(e: Event) =>
            setFilter(host, "assignee", (e.target as HTMLSelectElement).value)}
        >
          <option value="" ?selected=${s.assignee === ""}>${t("rsil.allAssignees")}</option>
          <option value="__unassigned__" ?selected=${s.assignee === "__unassigned__"}>
            ${t("rsil.unassigned")}
          </option>
          ${assigneeOptions(host).map(
            (o) => html`<option value=${o.id} ?selected=${o.id === s.assignee}>${o.label}</option>`,
          )}
        </select>
      </label>
      <label class="rsil__filter rsil__filter--search">
        <span>${t("rsil.filterSearch")}</span>
        <input
          type="search"
          .value=${s.search}
          placeholder=${t("rsil.filterSearch")}
          @input=${(e: Event) => setFilter(host, "search", (e.target as HTMLInputElement).value)}
        />
      </label>
      <span class="rsil__count">${t("rsil.count", { count: String(count) })}</span>
    </div>
  `;
}

function renderDoneContainer(host: RsilHost, cards: RsilCard[]): TemplateResult {
  // Full-width strip across the bottom of the board collecting completed cards
  // from every category. Reuses the column header/card styling.
  return html`
    <section class="rsil__done">
      <header class="rsil__col-head">
        <span>${statusLabel("done")}</span>
        <span class="rsil__col-count">${cards.length}</span>
      </header>
      <div class="rsil__done-cards">
        ${repeat(
          cards,
          (c) => c.id,
          (c) => renderCard(host, c),
        )}
      </div>
    </section>
  `;
}

function renderBoard(host: RsilHost): TemplateResult {
  const s = getRsilState();
  if (s.loading && !s.loaded) {
    return html`<div class="rsil__status">${icons.loader}</div>`;
  }
  const groups = cardsByCategory();
  const done = doneCards();
  if (groups.length === 0 && done.length === 0) {
    return html`<div class="rsil__empty">${t("rsil.empty")}</div>`;
  }
  return html`
    ${groups.length > 0
      ? html`<div class="rsil__columns">
          ${repeat(
            groups,
            (g) => g.category,
            (g) => html`
              <section
                class="rsil__col"
                @dragover=${onColDragOver}
                @dragleave=${onColDragLeave}
                @drop=${(e: DragEvent) => onColDrop(host, e, g.category)}
              >
                <header
                  class="rsil__col-head rsil__col-head--draggable"
                  draggable="true"
                  @dragstart=${(e: DragEvent) => onColHeadDragStart(e, g.category)}
                  @dragend=${onColHeadDragEnd}
                >
                  <span>${categoryLabel(g.category)}</span>
                  <span class="rsil__col-count">${g.cards.length}</span>
                </header>
                <div class="rsil__col-cards">
                  ${repeat(
                    g.cards,
                    (c) => c.id,
                    (c) => renderCard(host, c),
                  )}
                </div>
              </section>
            `,
          )}
        </div>`
      : nothing}
    ${done.length > 0 ? renderDoneContainer(host, done) : nothing}
  `;
}

function renderNextSteps(host: RsilHost, card: RsilCard): TemplateResult {
  const steps = card.research?.nextSteps ?? [];
  const busy = getRsilState().busyCardId === card.id;
  return html`
    <div class="rsil-detail__section">
      <h4>${t("rsil.detailNextSteps")}</h4>
      <textarea
        id="rsil-steps-${card.id}"
        class="rsil-detail__steps"
        rows=${Math.max(3, steps.length + 1)}
        .value=${steps.join("\n")}
      ></textarea>
      <button
        class="rsil-detail__save"
        ?disabled=${busy}
        @click=${() => {
          const el = document.getElementById(`rsil-steps-${card.id}`) as HTMLTextAreaElement | null;
          const next = (el?.value ?? "")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          void saveNextSteps(host, card, next);
        }}
      >
        ${t("rsil.detailSave")}
      </button>
    </div>
  `;
}

function renderDetail(host: RsilHost, card: RsilCard): TemplateResult {
  const r = card.research;
  const notesHtml = card.notes ? toSanitizedMarkdownHtml(card.notes) : "";
  return html`
    <aside class="rsil-detail">
      <header class="rsil-detail__head">
        <h3>${card.title}</h3>
        <button class="rsil-detail__close" @click=${() => openCard(host, null)}>${icons.x}</button>
      </header>
      <div class="rsil-detail__meta">
        ${r?.category ? html`<span class="badge">${categoryLabel(r.category)}</span>` : nothing}
        ${r?.cycleDate
          ? html`<span class="badge">${t("rsil.detailCycle")}: ${r.cycleDate}</span>`
          : nothing}
        ${r?.complexity
          ? html`<span class="badge">${t("rsil.cardComplexity")}: ${r.complexity}</span>`
          : nothing}
        ${r?.risk ? html`<span class="badge">${t("rsil.cardRisk")}: ${r.risk}</span>` : nothing}
        ${r?.outcome
          ? html`<span class="badge rsil-badge--${r.outcome}"
              >${t("rsil.detailOutcome")}: ${r.outcome}</span
            >`
          : nothing}
      </div>
      <div class="rsil-detail__controls">
        ${renderStatusSelect(host, card)} ${renderAssigneeSelect(host, card)}
      </div>
      ${r?.sourcePaper
        ? html`<div class="rsil-detail__section">
            <h4>${t("rsil.detailSourcePaper")}</h4>
            <p>
              ${card.sourceUrl
                ? html`<a href=${card.sourceUrl} target="_blank" rel="noopener"
                    >${r.sourcePaper}</a
                  >`
                : r.sourcePaper}
            </p>
          </div>`
        : nothing}
      ${renderNextSteps(host, card)}
      ${card.notes
        ? html`<div class="rsil-detail__section rsil-detail__notes">${unsafeHTML(notesHtml)}</div>`
        : nothing}
      ${r?.cycleDate
        ? html`<button
            class="rsil-detail__report"
            @click=${() => {
              setTab(host, "reports");
              void openReport(host, `openclaw-analysis-${r.cycleDate}.md`);
            }}
          >
            ${t("rsil.openReport")}
          </button>`
        : nothing}
    </aside>
  `;
}

function renderReports(host: RsilHost): TemplateResult {
  const s = getRsilState();
  const contentHtml = s.reportContent ? toSanitizedMarkdownHtml(s.reportContent) : "";
  const grouped = groupReports(s.reports);
  return html`
    <div class="rsil-reports">
      <nav class="rsil-reports__list">
        ${s.reportsLoading
          ? html`<div class="rsil__status">${icons.loader}</div>`
          : s.reports.length === 0
            ? html`<div class="rsil__empty">${t("rsil.reportsEmpty")}</div>`
            : repeat(
                grouped,
                (g) => g.date,
                (g) => html`
                  <div class="rsil-reports__group">
                    <div class="rsil-reports__date">${g.date}</div>
                    ${g.reports.map(
                      (rep) => html`
                        <button
                          class="rsil-reports__item ${s.activeReport === rep.name
                            ? "rsil-reports__item--active"
                            : ""}"
                          @click=${() => openReport(host, rep.name)}
                        >
                          ${rep.kind}
                        </button>
                      `,
                    )}
                  </div>
                `,
              )}
      </nav>
      <div class="rsil-reports__content">
        ${s.reportLoading
          ? html`<div class="rsil__status">${icons.loader}</div>`
          : s.reportContent
            ? html`<div class="rsil-reports__md">${unsafeHTML(contentHtml)}</div>`
            : html`<div class="rsil__empty">${t("rsil.selectReport")}</div>`}
      </div>
    </div>
  `;
}

function groupReports(
  reports: RsilReportInfo[],
): Array<{ date: string; reports: RsilReportInfo[] }> {
  const map = new Map<string, RsilReportInfo[]>();
  for (const rep of reports) {
    const key = rep.date ?? "other";
    const list = map.get(key) ?? [];
    list.push(rep);
    map.set(key, list);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({ date, reports: list }));
}

export function renderRsil(host: RsilHost): TemplateResult {
  // Lazy-load the board on first render of the tab.
  void ensureRsil(host);
  const s = getRsilState();
  const card = selectedCard();
  return html`
    <section class="rsil-page">
      <header class="rsil__head">
        <div>
          <div class="rsil__title">${t("rsil.title")}</div>
          <div class="rsil__tagline">${t("rsil.tagline")}</div>
        </div>
        <div class="rsil__head-actions">
          <span class="rsil__autowork">${icons.brain} ${t("rsil.autoWorkOn")}</span>
          <button class="rsil__refresh" @click=${() => void reloadRsil(host)}>
            ${icons.loader} ${t("rsil.refresh")}
          </button>
        </div>
      </header>
      ${s.error ? html`<div class="rsil__error">${s.error}</div>` : nothing}
      <nav class="rsil__tabs">
        <button
          class="rsil__tab ${s.tab === "board" ? "rsil__tab--active" : ""}"
          @click=${() => setTab(host, "board")}
        >
          ${t("rsil.tabBoard")}
        </button>
        <button
          class="rsil__tab ${s.tab === "reports" ? "rsil__tab--active" : ""}"
          @click=${() => setTab(host, "reports")}
        >
          ${t("rsil.tabReports")}
        </button>
      </nav>
      ${s.tab === "board"
        ? html`<div class="rsil__body">
            <div class="rsil__board">${renderFilters(host)} ${renderBoard(host)}</div>
            ${card ? renderDetail(host, card) : nothing}
          </div>`
        : renderReports(host)}
    </section>
  `;
}
