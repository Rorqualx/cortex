/**
 * Ingest the daily-research pipeline reports (`<workspace>/memory/reports/*.md`)
 * into Workboard cards on the dedicated "Recursive Self-Improvement Laboratory"
 * board. Idempotent: cards are keyed by `rsil:<cycleDate>:<itemId>` via the
 * store's `idempotencyKey`, so re-running updates in place. Operator edits set
 * `metadata.research.userTouched`, after which re-sync preserves the manual
 * status / assignee / next-steps and only refreshes descriptive fields.
 *
 * This is migration-style writer code: steady-state runtime only reads the
 * cards it produces. The scheduled `openclaw workboard research-sync` cron and
 * the `workboard.research.sync` gateway method are the only callers.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  categoryLabel,
  parseAnalysisReport,
  parseImplementationReport,
  parseResearchReport,
  type ParsedAnalysisItem,
  type ParsedFinding,
  type ParsedImplItem,
  type ResearchCategory,
} from "./research-report-parser.js";
import type { WorkboardStore } from "./store.js";
import type { WorkboardResearchCategory, WorkboardSection, WorkboardStatus } from "./types.js";

export const SELF_IMPROVEMENT_BOARD_ID = "self-improvement-lab";
export const SELF_IMPROVEMENT_BOARD_NAME = "Recursive Self-Improvement Laboratory";

const DEFAULT_RETENTION_DAYS = 30;
const REPORT_DATE = /^(llm-research|openclaw-analysis|implementation)-(\d{4}-\d{2}-\d{2})\.md$/;

export type ResearchIngestResult = {
  boardId: string;
  created: number;
  updated: number;
  skippedUserTouched: number;
  archived: number;
  cyclesProcessed: string[];
  warnings: string[];
};

export type ResearchIngestOptions = {
  store: WorkboardStore;
  reportsDir: string;
  now?: number;
  defaultAssignee?: string;
  retentionDays?: number;
};

/** Resolve `<workspace>/memory/reports`, the default research report location. */
export function resolveResearchReportsDir(cfg?: OpenClawConfig): string {
  const workspace =
    cfg?.agents?.defaults?.workspace?.trim() || path.join(resolveStateDir(), "workspace");
  return path.join(workspace, "memory", "reports");
}

type CycleReports = {
  date: string;
  findings: ParsedFinding[];
  analysisItems: ParsedAnalysisItem[];
  implByItem: Map<string, ParsedImplItem>;
  watchList: string[];
  warnings: string[];
};

/** Group report files by cycle date and parse each kind that's present. */
async function loadCycles(reportsDir: string): Promise<CycleReports[]> {
  let entries: string[];
  try {
    const dirents = await fs.readdir(reportsDir, { withFileTypes: true });
    entries = dirents.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }

  const byDate = new Map<string, { research?: string; analysis?: string; impl?: string }>();
  for (const name of entries.toSorted()) {
    const match = name.match(REPORT_DATE);
    if (!match) {
      continue;
    }
    const [, kind, date] = match;
    const slot = byDate.get(date) ?? {};
    if (kind === "llm-research") {
      slot.research = name;
    } else if (kind === "openclaw-analysis") {
      slot.analysis = name;
    } else {
      slot.impl = name;
    }
    byDate.set(date, slot);
  }

  const cycles: CycleReports[] = [];
  for (const [date, slot] of [...byDate.entries()].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const warnings: string[] = [];
    const cycle: CycleReports = {
      date,
      findings: [],
      analysisItems: [],
      implByItem: new Map(),
      watchList: [],
      warnings,
    };
    if (slot.research) {
      const parsed = parseResearchReport(await readFile(reportsDir, slot.research));
      cycle.findings = parsed.data.findings;
      cycle.watchList = parsed.data.watchList;
      warnings.push(...parsed.warnings.map((w) => `${slot.research}: ${w}`));
    }
    if (slot.analysis) {
      const parsed = parseAnalysisReport(await readFile(reportsDir, slot.analysis));
      cycle.analysisItems = parsed.data.items;
      warnings.push(...parsed.warnings.map((w) => `${slot.analysis}: ${w}`));
    }
    if (slot.impl) {
      const parsed = parseImplementationReport(await readFile(reportsDir, slot.impl));
      for (const item of parsed.data.items) {
        cycle.implByItem.set(item.itemId, item);
      }
      warnings.push(...parsed.warnings.map((w) => `${slot.impl}: ${w}`));
    }
    cycles.push(cycle);
  }
  return cycles;
}

async function readFile(dir: string, name: string): Promise<string> {
  return await fs.readFile(path.join(dir, name), "utf-8");
}

/** A card the ingest wants to exist; mapped to create/update against the store. */
type DesiredCard = {
  idempotencyKey: string;
  title: string;
  notes: string;
  status: WorkboardStatus;
  section: WorkboardSection;
  priority: "low" | "normal" | "high";
  labels: string[];
  sourceUrl?: string;
  research: {
    cycleDate: string;
    itemId: string;
    category: WorkboardResearchCategory;
    complexity?: string;
    risk?: string;
    sourcePaper?: string;
    sourceFindingRef?: string;
    nextSteps?: string[];
    outcome?: "implemented" | "skipped" | "failed";
    commit?: string;
  };
};

const CATEGORY_SECTION: Record<ResearchCategory, WorkboardSection> = {
  "quick-win": "tasks",
  architecture: "goals",
  "long-horizon": "goals",
  "queue-guidance": "ideas",
  contradictory: "ideas",
  finding: "ideas",
  watch: "ideas",
};

/** Categories the dispatcher is allowed to auto-work when un-triaged. */

function arxivUrl(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  const match = source.match(/arXiv:\s*(\d{4}\.\d{4,5})/i);
  return match ? `https://arxiv.org/abs/${match[1]}` : undefined;
}

/** Extract a numbered/bulleted "Change" or action list as discrete next-steps. */
function extractNextSteps(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const steps: string[] = [];
  let inChange = false;
  for (const line of lines) {
    if (/^\s*\*\*(change|design considerations|action)\*\*/i.test(line.replace(/:?\*\*/g, "**"))) {
      inChange = true;
      continue;
    }
    if (/^#{2,4}\s+/.test(line)) {
      inChange = false;
    }
    if (!inChange) {
      continue;
    }
    const match = line.match(/^\s*(?:\d+\.|[-*])\s+(.*\S)\s*$/);
    if (match) {
      // Bound each step under the store's per-entry string limit (600).
      steps.push(truncate(match[1].replace(/\s+/g, " ").trim(), 560));
    }
  }
  return steps.slice(0, 12);
}

function statusForAnalysisItem(impl?: ParsedImplItem): WorkboardStatus {
  if (impl?.outcome === "implemented") {
    return "done";
  }
  if (impl?.outcome === "failed") {
    return "blocked";
  }
  if (impl?.outcome === "skipped") {
    return "backlog";
  }
  // Seed un-implemented items as backlog, not ready: auto-work stays enabled on
  // the board, but nothing is dispatched until an operator promotes a card to
  // "ready". This avoids unsupervised workers editing the live checkout (and the
  // known in-place-`pnpm build` gateway-crash hazard) the moment a sync runs.
  return "backlog";
}

function buildDesiredCards(cycle: CycleReports): DesiredCard[] {
  const findingByIndex = new Map(cycle.findings.map((f) => [f.index, f]));
  const desired: DesiredCard[] = [];

  // 1. Actionable analysis items (QW/ARCH/LT/QFG/CONTRA).
  for (const item of cycle.analysisItems) {
    const impl = cycle.implByItem.get(item.itemId);
    const findingIndex = item.sourceFinding ? Number(item.sourceFinding.replace("#", "")) : NaN;
    const finding = Number.isFinite(findingIndex) ? findingByIndex.get(findingIndex) : undefined;
    const status = statusForAnalysisItem(impl);
    const labels = [
      "rsil",
      `rsil:${item.category}`,
      ...(item.complexity ? [`cx:${truncate(item.complexity, 16)}`] : []),
      ...(item.risk ? [`risk:${truncate(item.risk.toLowerCase(), 16)}`] : []),
      ...(impl?.outcome === "skipped" ? ["rsil:skipped"] : []),
      ...(impl?.outcome === "implemented" ? ["rsil:done"] : []),
    ];
    desired.push({
      idempotencyKey: `rsil:${cycle.date}:${item.itemId}`,
      title: truncate(`${item.itemId}: ${item.title}`, 200),
      notes: truncate(assembleNotes({ item, finding, impl }), 3990),
      status,
      section: CATEGORY_SECTION[item.category],
      priority:
        item.category === "quick-win"
          ? "high"
          : item.category === "architecture"
            ? "normal"
            : "low",
      labels,
      sourceUrl: arxivUrl(finding?.source) ?? arxivUrl(item.body),
      research: {
        cycleDate: cycle.date,
        itemId: item.itemId,
        category: item.category,
        complexity: item.complexity ? truncate(item.complexity, 24) : undefined,
        risk: item.risk ? truncate(item.risk, 24) : undefined,
        sourcePaper: truncate(
          finding ? `#${finding.index} ${finding.title}` : (item.sourceFinding ?? ""),
          240,
        ),
        sourceFindingRef: item.sourceFinding ? truncate(item.sourceFinding, 40) : undefined,
        nextSteps: extractNextSteps(item.body),
        outcome: impl?.outcome,
        commit: impl?.commit,
      },
    });
  }

  // 2. Source findings (the papers) as reference cards.
  for (const finding of cycle.findings) {
    desired.push({
      idempotencyKey: `rsil:${cycle.date}:F-${finding.index}`,
      title: truncate(`Finding #${finding.index}: ${finding.title}`, 200),
      notes: truncate(assembleFindingNotes(finding), 3990),
      status: "backlog",
      section: "ideas",
      priority: "low",
      labels: ["rsil", "rsil:finding"],
      sourceUrl: arxivUrl(finding.source),
      research: {
        cycleDate: cycle.date,
        itemId: `F-${finding.index}`,
        category: "finding",
        sourcePaper: finding.source ? truncate(finding.source, 240) : undefined,
      },
    });
  }

  // 3. Watch-list entries as low-priority watch cards.
  cycle.watchList.forEach((text, index) => {
    desired.push({
      idempotencyKey: `rsil:${cycle.date}:WATCH-${index + 1}`,
      title: truncate(stripMarkdown(text), 120),
      notes: truncate(text, 3990),
      status: "backlog",
      section: "ideas",
      priority: "low",
      labels: ["rsil", "rsil:watch"],
      sourceUrl: arxivUrl(text),
      research: {
        cycleDate: cycle.date,
        itemId: `WATCH-${index + 1}`,
        category: "watch",
      },
    });
  });

  return desired;
}

function assembleNotes(params: {
  item: ParsedAnalysisItem;
  finding?: ParsedFinding;
  impl?: ParsedImplItem;
}): string {
  const { item, finding, impl } = params;
  const parts: string[] = [`**Category:** ${categoryLabel(item.category)}`];
  if (item.complexity || item.risk) {
    parts.push(`**Complexity:** ${item.complexity ?? "—"} · **Risk:** ${item.risk ?? "—"}`);
  }
  if (finding) {
    parts.push(`### Source — Finding #${finding.index}: ${finding.title}`);
    if (finding.source) {
      parts.push(`- **Source:** ${finding.source}`);
    }
    if (finding.summary) {
      parts.push(`- **Summary:** ${finding.summary}`);
    }
    if (finding.relevance) {
      parts.push(`- **Integration relevance:** ${finding.relevance}`);
    }
  }
  parts.push("### Analysis", item.body);
  if (impl) {
    parts.push(`### Implementation — ${impl.outcome}`);
    if (impl.filesChanged.length > 0) {
      parts.push(`- **Files changed:** ${impl.filesChanged.join(", ")}`);
    }
    if (impl.tests) {
      parts.push(`- **Tests:** ${impl.tests}`);
    }
    if (impl.commit) {
      parts.push(`- **Commit:** ${impl.commit}`);
    }
  }
  return parts.join("\n\n");
}

function assembleFindingNotes(finding: ParsedFinding): string {
  const parts: string[] = [];
  if (finding.source) {
    parts.push(`- **Source:** ${finding.source}`);
  }
  if (finding.summary) {
    parts.push(`- **Summary:** ${finding.summary}`);
  }
  if (finding.relevance) {
    parts.push(`- **Integration relevance:** ${finding.relevance}`);
  }
  return parts.join("\n") || finding.title;
}

function stripMarkdown(value: string): string {
  return value.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/** Run a full ingest pass: ensure the board, upsert cards, apply retention. */
export async function runResearchIngest(
  options: ResearchIngestOptions,
): Promise<ResearchIngestResult> {
  const { store, reportsDir } = options;
  const now = options.now ?? Date.now();
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const result: ResearchIngestResult = {
    boardId: SELF_IMPROVEMENT_BOARD_ID,
    created: 0,
    updated: 0,
    skippedUserTouched: 0,
    archived: 0,
    cyclesProcessed: [],
    warnings: [],
  };

  await store.upsertBoard({
    id: SELF_IMPROVEMENT_BOARD_ID,
    name: SELF_IMPROVEMENT_BOARD_NAME,
    description: "Items ingested from the daily-research pipeline reports.",
    icon: "brain",
    orchestration: {
      autoDecompose: true,
      ...(options.defaultAssignee ? { defaultAssignee: options.defaultAssignee } : {}),
    },
  });

  const cycles = await loadCycles(reportsDir);
  const existing = await store.list({ boardId: SELF_IMPROVEMENT_BOARD_ID });
  const byKey = new Map(
    existing
      .filter((card) => card.metadata?.automation?.idempotencyKey)
      .map((card) => [card.metadata!.automation!.idempotencyKey as string, card]),
  );

  for (const cycle of cycles) {
    result.cyclesProcessed.push(cycle.date);
    result.warnings.push(...cycle.warnings);
    for (const desired of buildDesiredCards(cycle)) {
      const found = byKey.get(desired.idempotencyKey);
      if (!found) {
        await store.create({
          boardId: SELF_IMPROVEMENT_BOARD_ID,
          idempotencyKey: desired.idempotencyKey,
          title: desired.title,
          notes: desired.notes,
          status: desired.status,
          section: desired.section,
          priority: desired.priority,
          labels: desired.labels,
          ...(desired.sourceUrl ? { sourceUrl: desired.sourceUrl } : {}),
          ...(options.defaultAssignee ? { agentId: options.defaultAssignee } : {}),
          metadata: { research: desired.research },
        });
        result.created += 1;
        continue;
      }
      const userTouched = found.metadata?.research?.userTouched === true;
      if (userTouched) {
        // Refresh descriptive fields only; preserve manual status/assignee/next-steps.
        // Omit `nextSteps` entirely (not undefined) so the normalizer keeps the
        // operator's edited steps rather than overwriting them.
        const { nextSteps: _drop, ...researchNoSteps } = desired.research;
        await store.update(found.id, {
          title: desired.title,
          notes: desired.notes,
          labels: desired.labels,
          ...(desired.sourceUrl ? { sourceUrl: desired.sourceUrl } : {}),
          metadata: { research: { ...researchNoSteps, userTouched: true } },
        });
        result.skippedUserTouched += 1;
      } else {
        await store.update(found.id, {
          title: desired.title,
          notes: desired.notes,
          status: desired.status,
          section: desired.section,
          priority: desired.priority,
          labels: desired.labels,
          ...(desired.sourceUrl ? { sourceUrl: desired.sourceUrl } : {}),
          metadata: { research: desired.research },
        });
        result.updated += 1;
      }
    }
  }

  // Retention runs over the post-upsert set so freshly ingested historical
  // cycles are archived in the same pass, not only on a later run.
  const current = await store.list({ boardId: SELF_IMPROVEMENT_BOARD_ID });
  result.archived = await applyRetention(store, current, retentionDays, now);
  return result;
}

/** Archive ingested cards whose cycle date is older than the retention window. */
async function applyRetention(
  store: WorkboardStore,
  existing: Awaited<ReturnType<WorkboardStore["list"]>>,
  retentionDays: number,
  now: number,
): Promise<number> {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let archived = 0;
  for (const card of existing) {
    const cycleDate = card.metadata?.research?.cycleDate;
    if (!cycleDate || card.metadata?.archivedAt) {
      continue;
    }
    const cycleMs = Date.parse(`${cycleDate}T00:00:00Z`);
    if (Number.isFinite(cycleMs) && cycleMs < cutoff) {
      await store.update(card.id, { metadata: { archivedAt: now } });
      archived += 1;
    }
  }
  return archived;
}
