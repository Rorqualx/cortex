// Control UI view renders the Skill Forge pipeline dashboard.

import { html, nothing } from "lit-html";
import type {
  ForgeSkill,
  ForgeSkillStatus,
  ForgeCandidate,
  SkillForgeState,
  ForgeActionNotice,
} from "../controllers/skill-forge.ts";
import { filteredSkills, countSkillForge, allCandidates } from "../controllers/skill-forge.ts";
import { icons } from "../icons.ts";

export type SkillForgeProps = SkillForgeState & {
  onRunPipeline: () => void;
  onPromote: (name: string) => void;
  onRetire: (name: string) => void;
  onDecaySweep: () => void;
  onSelect: (name: string) => void;
  onFilterChange: (filter: ForgeSkillStatus | "all") => void;
  onQueryChange: (query: string) => void;
  onModeChange: (mode: "board" | "grid") => void;
  onQueueWidthChange: (width: number) => void;
};

const FILTER_TABS: Array<{ value: ForgeSkillStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "candidate", label: "Candidates" },
  { value: "staged", label: "Staged" },
  { value: "promoted", label: "Promoted" },
  { value: "retired", label: "Retired" },
];

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  promoted: { label: "Promoted", cls: "sf-badge--promoted" },
  staged: { label: "Staged", cls: "sf-badge--staged" },
  retired: { label: "Retired", cls: "sf-badge--retired" },
};

// ── Main render ────────────────────────────────────────────────────

export function renderSkillForge(props: SkillForgeProps) {
  const skills = filteredSkills(props);
  const counts = countSkillForge(props);
  const candidates = allCandidates(props);
  const selected = skills.find((s) => s.name === props.skillForgeSelectedName);
  const staged = props.skillForgeStatus?.skills.staged ?? [];
  const promoted = props.skillForgeStatus?.skills.promoted ?? [];
  const isEmpty = candidates.length === 0 && staged.length === 0 && promoted.length === 0;

  return html`
    <section class="skill-forge sf-mode-${props.skillForgeMode}">
      ${renderToolbar(props, counts)}
      ${props.skillForgeActionNotice ? renderActionNotice(props.skillForgeActionNotice) : nothing}
      ${props.skillForgeLoading && !props.skillForgeLoaded
        ? renderLoading()
        : isEmpty
          ? renderEmpty(props)
          : props.skillForgeMode === "grid"
            ? renderBody(props, skills, selected)
            : html`
                ${candidates.length > 0 ? renderCandidatesSection(candidates) : nothing}
                ${staged.length > 0 ? renderStagedSection(props, staged) : nothing}
                ${promoted.length > 0 ? renderPromotedSection(props, promoted) : nothing}
              `}
    </section>
  `;
}

// ── Body (grid mode: queue list + resizable detail panel) ──────────

const QUEUE_MIN_WIDTH = 240;
const QUEUE_MAX_WIDTH = 560;

function renderBody(
  props: SkillForgeProps,
  skills: ForgeSkill[],
  selected: ForgeSkill | undefined,
) {
  const width = Math.max(QUEUE_MIN_WIDTH, Math.min(QUEUE_MAX_WIDTH, props.skillForgeQueueWidth));
  return html`
    <div class="sf-body">
      <div class="sf-queue" style="width: ${width}px; position: relative;">
        ${renderQueue(props, skills, selected)}
        <div class="sf-divider" style="right: 0;" @pointerdown=${queueResizeHandler(props)}></div>
      </div>
      <div class="sf-detail">${selected ? renderDetail(props, selected) : renderNoSelection()}</div>
    </div>
  `;
}

// Drag the divider to resize the queue column; clamps to the queue width bounds
// and tears down the window listeners on pointerup so no drag state leaks.
function queueResizeHandler(props: SkillForgeProps) {
  return (event: PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = Math.max(
      QUEUE_MIN_WIDTH,
      Math.min(QUEUE_MAX_WIDTH, props.skillForgeQueueWidth),
    );
    const onMove = (move: PointerEvent) => {
      const next = startWidth + (move.clientX - startX);
      props.onQueueWidthChange(Math.max(QUEUE_MIN_WIDTH, Math.min(QUEUE_MAX_WIDTH, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
}

// ── Toolbar ────────────────────────────────────────────────────────

function renderToolbar(props: SkillForgeProps, counts: Record<string, number>) {
  return html`
    <div class="sf-toolbar">
      <div class="sf-toolbar__filters">
        ${FILTER_TABS.map(
          (tab) => html`
            <button
              class="sf-filter-tab ${props.skillForgeFilter === tab.value ? "is-active" : ""}"
              @click=${() => props.onFilterChange(tab.value)}
            >
              ${tab.label}
              <span class="sf-filter-tab__count">${counts[tab.value] ?? 0}</span>
            </button>
          `,
        )}
      </div>
      <div class="sf-toolbar__actions">
        <div class="sf-mode-toggle">
          <button
            class="sf-filter-tab ${props.skillForgeMode === "board" ? "is-active" : ""}"
            @click=${() => props.onModeChange("board")}
            title="Pipeline board view"
          >
            ▦ Board
          </button>
          <button
            class="sf-filter-tab ${props.skillForgeMode === "grid" ? "is-active" : ""}"
            @click=${() => props.onModeChange("grid")}
            title="Queue + detail view"
          >
            ${icons.menu} List
          </button>
        </div>
        <input
          type="search"
          class="sf-search"
          placeholder="Search skills..."
          .value=${props.skillForgeQuery}
          @input=${(e: Event) => props.onQueryChange((e.target as HTMLInputElement).value)}
        />
        <button
          class="sf-btn sf-btn--run ${props.skillForgeRunBusy ? "is-busy" : ""}"
          ?disabled=${props.skillForgeRunBusy}
          @click=${() => props.onRunPipeline()}
          title="Run forge pipeline"
        >
          ${props.skillForgeRunBusy ? "Running…" : "▶ Run Pipeline"}
        </button>
        <button
          class="sf-btn sf-btn--decay"
          @click=${() => props.onDecaySweep()}
          title="Retire stale skills (>30d unused)"
        >
          ${icons.trash} Decay
        </button>
      </div>
    </div>
  `;
}

// ── Candidates section (detected patterns, pre-draft) ──────────────

function renderCandidatesSection(candidates: ForgeCandidate[]) {
  return html`
    <div class="sf-pipeline-section">
      <div class="sf-pipeline-section__header">
        <span class="sf-pipeline-step sf-pipeline-step--candidate">1</span>
        <h3 class="sf-pipeline-section__title">Candidates</h3>
        <span class="sf-pipeline-section__badge">${candidates.length} detected</span>
        <span class="sf-pipeline-section__hint"
          >Run pipeline to distill these into skill drafts</span
        >
      </div>
      <div class="sf-candidate-grid">
        ${candidates.map(
          (c) => html`
            <div class="sf-candidate-card">
              <div class="sf-candidate-card__lane">${c.lane}</div>
              <div class="sf-candidate-card__flow">
                <span class="sf-candidate-card__tool sf-candidate-card__tool--fail"
                  >${c.failingTool}</span
                >
                <span class="sf-candidate-card__arrow">→</span>
                <span class="sf-candidate-card__tool sf-candidate-card__tool--recover"
                  >${c.recoveringTool}</span
                >
              </div>
              ${c.rationale
                ? html`<p class="sf-candidate-card__rationale">${c.rationale}</p>`
                : nothing}
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

// ── Staged section (drafted skills, awaiting promotion) ────────────

function renderStagedSection(props: SkillForgeProps, staged: ForgeSkill[]) {
  return html`
    <div class="sf-pipeline-section">
      <div class="sf-pipeline-section__header">
        <span class="sf-pipeline-step sf-pipeline-step--staged">2</span>
        <h3 class="sf-pipeline-section__title">Staged</h3>
        <span class="sf-pipeline-section__badge">${staged.length} awaiting review</span>
        <span class="sf-pipeline-section__hint">Promote to make live, or retire to discard</span>
      </div>
      <div class="sf-staged-grid">
        ${staged.map(
          (skill) => html`
            <div class="sf-staged-card">
              <div class="sf-staged-card__header">
                <span class="sf-staged-card__name"
                  >${skill.name.replace(/^forge-recover-/, "").replace(/-[a-f0-9]{6}$/, "")}</span
                >
                <span class="sf-queue__badge sf-badge--staged">Staged</span>
              </div>
              ${skill.description
                ? html`<p class="sf-staged-card__desc">${skill.description}</p>`
                : nothing}
              <div class="sf-staged-card__actions">
                <button
                  class="sf-btn sf-btn--promote sf-btn--sm ${props.skillForgeActionBusy ===
                  skill.name
                    ? "is-busy"
                    : ""}"
                  ?disabled=${props.skillForgeActionBusy === skill.name}
                  @click=${() => props.onPromote(skill.name)}
                >
                  ${props.skillForgeActionBusy === skill.name ? "…" : html`${icons.check} Promote`}
                </button>
                <button
                  class="sf-btn sf-btn--retire sf-btn--sm"
                  ?disabled=${props.skillForgeActionBusy === skill.name}
                  @click=${() => props.onRetire(skill.name)}
                >
                  ${icons.x} Retire
                </button>
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

// ── Promoted section (live skills) ─────────────────────────────────

function renderPromotedSection(props: SkillForgeProps, promoted: ForgeSkill[]) {
  return html`
    <div class="sf-pipeline-section">
      <div class="sf-pipeline-section__header">
        <span class="sf-pipeline-step sf-pipeline-step--promoted">3</span>
        <h3 class="sf-pipeline-section__title">Promoted</h3>
        <span class="sf-pipeline-section__badge">${promoted.length} live</span>
      </div>
      <div class="sf-staged-grid">
        ${promoted.map(
          (skill) => html`
            <div class="sf-staged-card sf-staged-card--promoted">
              <div class="sf-staged-card__header">
                <span class="sf-staged-card__name"
                  >${skill.name.replace(/^forge-recover-/, "").replace(/-[a-f0-9]{6}$/, "")}</span
                >
                <span class="sf-queue__badge sf-badge--promoted">${icons.check} Live</span>
              </div>
              ${skill.description
                ? html`<p class="sf-staged-card__desc">${skill.description}</p>`
                : nothing}
              <div class="sf-staged-card__meta">
                ${skill.usageCount > 0
                  ? html`<span class="sf-meta-used">Used ${skill.usageCount}×</span>`
                  : html`<span class="sf-meta-unused">Unused</span>`}
                ${skill.lastUsedAt
                  ? html`<span>Last ${relativeTime(skill.lastUsedAt)}</span>`
                  : nothing}
                <button
                  class="sf-btn sf-btn--retire sf-btn--sm"
                  ?disabled=${props.skillForgeActionBusy === skill.name}
                  @click=${() => props.onRetire(skill.name)}
                >
                  Retire
                </button>
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

// ── Queue (all skills list) ────────────────────────────────────────

function renderQueue(
  props: SkillForgeProps,
  skills: ForgeSkill[],
  selected: ForgeSkill | undefined,
) {
  return html`
    <div class="sf-queue__label">
      <span class="sf-pipeline-step sf-pipeline-step--promoted">3</span>
      Promoted & Retired
    </div>
    <div class="sf-queue__list">
      ${skills.map(
        (skill) => html`
          <button
            class="sf-queue__item ${selected?.name === skill.name
              ? "is-selected"
              : ""} ${skill.status === "staged" ? "is-actionable" : ""}"
            @click=${() => props.onSelect(skill.name)}
          >
            <span class="sf-queue__badge ${STATUS_BADGE[skill.status]?.cls ?? ""}">
              ${STATUS_BADGE[skill.status]?.label ?? skill.status}
            </span>
            <span class="sf-queue__name"
              >${skill.name.replace(/^forge-recover-/, "").replace(/-[a-f0-9]{6}$/, "")}</span
            >
            ${skill.description
              ? html`<span class="sf-queue__desc">${skill.description}</span>`
              : nothing}
            <span class="sf-queue__meta">
              ${skill.usageCount > 0 ? `${skill.usageCount}×` : "unused"}
              ${skill.lastUsedAt ? `· ${relativeTime(skill.lastUsedAt)}` : ""}
            </span>
          </button>
        `,
      )}
    </div>
  `;
}

// ── Detail panel ───────────────────────────────────────────────────

function renderDetail(props: SkillForgeProps, skill: ForgeSkill) {
  const badge = STATUS_BADGE[skill.status] ?? { label: skill.status, cls: "" };
  const isBusy = props.skillForgeActionBusy === skill.name;

  return html`
    <div class="sf-detail__inner">
      <div class="sf-detail__header">
        <span class="sf-queue__badge ${badge.cls}">${badge.label}</span>
        <h2 class="sf-detail__title">
          ${skill.name.replace(/^forge-recover-/, "").replace(/-[a-f0-9]{6}$/, "")}
        </h2>
      </div>
      ${skill.description
        ? html`<p class="sf-detail__description">${skill.description}</p>`
        : nothing}

      <div class="sf-detail__meta">
        <dl class="sf-meta-grid">
          <dt>Skill ID</dt>
          <dd class="sf-meta-mono">${skill.name}</dd>
          <dt>Status</dt>
          <dd>${skill.status}</dd>
          <dt>Usage</dt>
          <dd>${skill.usageCount} uses</dd>
          ${skill.lastUsedAt
            ? html`<dt>Last used</dt>
                <dd>${skill.lastUsedAt}</dd>`
            : nothing}
          ${skill.promotedAt
            ? html`<dt>Promoted</dt>
                <dd>${skill.promotedAt}</dd>`
            : nothing}
          ${skill.retiredAt
            ? html`<dt>Retired</dt>
                <dd>${skill.retiredAt}</dd>`
            : nothing}
          ${skill.retiredReason
            ? html`<dt>Reason</dt>
                <dd>${skill.retiredReason}</dd>`
            : nothing}
          ${skill.createdAt
            ? html`<dt>Created</dt>
                <dd>${skill.createdAt}</dd>`
            : nothing}
        </dl>
      </div>

      <div class="sf-detail__actions">
        ${skill.status === "staged"
          ? html`
              <button
                class="sf-btn sf-btn--promote ${isBusy ? "is-busy" : ""}"
                ?disabled=${isBusy}
                @click=${() => props.onPromote(skill.name)}
              >
                ${isBusy ? "Promoting…" : html`${icons.check} Promote`}
              </button>
              <button
                class="sf-btn sf-btn--retire ${isBusy ? "is-busy" : ""}"
                ?disabled=${isBusy}
                @click=${() => props.onRetire(skill.name)}
              >
                ${icons.x} Retire
              </button>
            `
          : skill.status === "promoted"
            ? html`
                <button
                  class="sf-btn sf-btn--retire ${isBusy ? "is-busy" : ""}"
                  ?disabled=${isBusy}
                  @click=${() => props.onRetire(skill.name)}
                >
                  ${icons.x} Retire
                </button>
              `
            : nothing}
      </div>

      ${props.skillForgeError
        ? html`<div class="sf-error">${props.skillForgeError}</div>`
        : nothing}
    </div>
  `;
}

// ── Empty / loading states ─────────────────────────────────────────

function renderEmpty(props: SkillForgeProps) {
  const hasFilter = props.skillForgeFilter !== "all" || props.skillForgeQuery.trim();
  return html`
    <div class="sf-empty">
      <div class="sf-empty__icon">${hasFilter ? icons.search : icons.wrench}</div>
      <p class="sf-empty__title">${hasFilter ? "No matching skills" : "Skill Forge"}</p>
      <p class="sf-empty__body">
        ${hasFilter
          ? "Try adjusting your filter or search query."
          : "The autonomous skill pipeline will surface drafted skills here. Run the pipeline to detect and distill patterns from captured sessions."}
      </p>
      ${!hasFilter
        ? html`
            <button
              class="sf-btn sf-btn--run"
              ?disabled=${props.skillForgeRunBusy}
              @click=${() => props.onRunPipeline()}
            >
              ▶ Run Pipeline
            </button>
          `
        : nothing}
    </div>
  `;
}

function renderNoSelection() {
  return html`
    <div class="sf-empty">
      <p class="sf-empty__body">Select a skill to view details.</p>
    </div>
  `;
}

function renderLoading() {
  return html`
    <div class="sf-loading">
      <div class="sf-loading__spinner"></div>
      <p>Loading forge status…</p>
    </div>
  `;
}

function renderActionNotice(notice: ForgeActionNotice) {
  return html` <div class="sf-notice sf-notice--${notice.type}">${notice.message}</div> `;
}

// ── Helpers ────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 60_000) {
      return "just now";
    }
    if (ms < 3_600_000) {
      return `${Math.floor(ms / 60_000)}m ago`;
    }
    if (ms < 86_400_000) {
      return `${Math.floor(ms / 3_600_000)}h ago`;
    }
    return `${Math.floor(ms / 86_400_000)}d ago`;
  } catch {
    return iso;
  }
}
