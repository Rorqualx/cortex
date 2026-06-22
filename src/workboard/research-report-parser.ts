/**
 * Parser for the autonomous daily-research pipeline reports written to
 * `<workspace>/memory/reports/*.md`. Pure, storage-agnostic functions: they
 * turn the three report kinds into structured items that `research-ingest.ts`
 * maps onto Workboard cards. Kept separate from ingest so the brittle markdown
 * scanning is unit-testable without a database.
 *
 * The reports are LLM-generated, so parsing is intentionally defensive: a
 * heading that doesn't match a known shape is recorded in `warnings` rather
 * than throwing. Callers surface warnings; they never block ingestion.
 */

export const RESEARCH_CATEGORIES = [
  "quick-win",
  "architecture",
  "long-horizon",
  "queue-guidance",
  "contradictory",
  "finding",
  "watch",
] as const;
export type ResearchCategory = (typeof RESEARCH_CATEGORIES)[number];

/** Map an analysis item-id prefix (QW/ARCH/LT/QFG/CONTRA) to a category. */
const ANALYSIS_PREFIX_TO_CATEGORY: Record<string, ResearchCategory> = {
  QW: "quick-win",
  ARCH: "architecture",
  LT: "long-horizon",
  QFG: "queue-guidance",
  CONTRA: "contradictory",
};

export type ParsedFinding = {
  /** 1-based position within the llm-research "Top Findings" list. */
  index: number;
  title: string;
  source?: string;
  summary?: string;
  relevance?: string;
};

export type ParsedResearchReport = {
  findings: ParsedFinding[];
  quickWins: string[];
  longerBets: string[];
  watchList: string[];
};

export type ParsedAnalysisItem = {
  /** Stable per-day item id, e.g. `QW-1`, `ARCH-2`, `CONTRA-1`. */
  itemId: string;
  category: ResearchCategory;
  title: string;
  complexity?: string;
  risk?: string;
  /** Reference to the source llm-research finding, e.g. `#2`. */
  sourceFinding?: string;
  /** Full markdown body of the item's section (everything under its heading). */
  body: string;
  /** Rank from the "Recommended Action Order" section, if listed. */
  actionOrder?: number;
};

export type ParsedAnalysisReport = {
  items: ParsedAnalysisItem[];
};

export type ImplementationOutcome = "implemented" | "skipped" | "failed";

export type ParsedImplItem = {
  itemId: string;
  outcome: ImplementationOutcome;
  filesChanged: string[];
  tests?: string;
  commit?: string;
  detail: string;
};

export type ParsedBacklogItem = {
  itemId?: string;
  text: string;
};

export type ParsedImplReport = {
  status?: string;
  items: ParsedImplItem[];
  backlog: ParsedBacklogItem[];
};

export type ParseResult<T> = {
  data: T;
  warnings: string[];
};

const ANALYSIS_ITEM_HEADING = /^#{2,4}\s+(QW|ARCH|LT|QFG|CONTRA)-(\d+):\s*(.+?)\s*$/;
const FINDING_HEADING = /^#{2,4}\s+(\d+)\.\s+(.+?)\s*$/;
const SECTION_HEADING = /^##\s+(.+?)\s*$/;
const COMMIT_SHA = /\b([0-9a-f]{7,40})\b/;

/** Split markdown into top-level (`##`) sections keyed by their lowercased title. */
function splitTopSections(markdown: string): { title: string; lines: string[] }[] {
  const out: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(SECTION_HEADING);
    if (match) {
      current = { title: match[1].trim(), lines: [] };
      out.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  return out;
}

/** Pull the value after a `- **Label:**` or `**Label**:` bullet in a block. */
function fieldValue(lines: string[], label: string): string | undefined {
  // Handle both `**Label:**` (colon inside the bold) and `**Label**:` forms.
  const re = new RegExp(`^[-*\\s]*\\*\\*${label}:?\\*\\*:?\\s*(.*)$`, "i");
  for (const line of lines) {
    const match = line.match(re);
    if (match && match[1].trim()) {
      return match[1].trim();
    }
  }
  return undefined;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Parse `llm-research-YYYY-MM-DD.md` → findings + quick-win/longer-bet/watch lists. */
export function parseResearchReport(markdown: string): ParseResult<ParsedResearchReport> {
  const warnings: string[] = [];
  const findings: ParsedFinding[] = [];
  const lines = markdown.split(/\r?\n/);

  // Findings are `### N. Title` blocks; capture each block body for field extraction.
  let block: { index: number; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (!block) {
      return;
    }
    findings.push({
      index: block.index,
      title: compact(block.title),
      source: fieldValue(block.lines, "Source"),
      summary: fieldValue(block.lines, "Summary"),
      relevance: fieldValue(block.lines, "OpenClaw Integration Relevance"),
    });
    block = null;
  };
  for (const line of lines) {
    const heading = line.match(FINDING_HEADING);
    if (heading) {
      flush();
      block = { index: Number(heading[1]), title: heading[2], lines: [] };
      continue;
    }
    if (line.match(SECTION_HEADING)) {
      flush();
      continue;
    }
    if (block) {
      block.lines.push(line);
    }
  }
  flush();

  const listFor = (titleMatch: RegExp): string[] => {
    const section = splitTopSections(markdown).find((s) => titleMatch.test(s.title));
    if (!section) {
      return [];
    }
    return extractListItems(section.lines);
  };

  return {
    data: {
      findings,
      quickWins: listFor(/quick win/i),
      longerBets: listFor(/longer bet|long.?term bet/i),
      watchList: listFor(/watch list/i),
    },
    warnings,
  };
}

/** Collect ordered/unordered list items (joining the leading line of each). */
function extractListItems(lines: string[]): string[] {
  const items: string[] = [];
  for (const raw of lines) {
    const match = raw.match(/^\s*(?:\d+\.|[-*])\s+(.*\S)\s*$/);
    if (match) {
      items.push(compact(match[1]));
    }
  }
  return items;
}

/** Parse `openclaw-analysis-YYYY-MM-DD.md` → categorized actionable items. */
export function parseAnalysisReport(markdown: string): ParseResult<ParsedAnalysisReport> {
  const warnings: string[] = [];
  const items: ParsedAnalysisItem[] = [];
  const lines = markdown.split(/\r?\n/);

  let block: { itemId: string; category: ResearchCategory; title: string; lines: string[] } | null =
    null;
  const flush = () => {
    if (!block) {
      return;
    }
    const body = block.lines.join("\n").trim();
    items.push({
      itemId: block.itemId,
      category: block.category,
      title: compact(block.title),
      complexity: fieldValue(block.lines, "Complexity"),
      risk: fieldValue(block.lines, "Risk"),
      sourceFinding: extractSourceFinding(block.lines),
      body,
    });
    block = null;
  };
  for (const line of lines) {
    const heading = line.match(ANALYSIS_ITEM_HEADING);
    if (heading) {
      flush();
      const prefix = heading[1];
      block = {
        itemId: `${prefix}-${heading[2]}`,
        category: ANALYSIS_PREFIX_TO_CATEGORY[prefix] ?? "finding",
        title: heading[3],
        lines: [],
      };
      continue;
    }
    if (block) {
      block.lines.push(line);
    }
  }
  flush();

  // "Complexity: S · Risk: Low" frequently appears on one combined line.
  for (const item of items) {
    if (!item.risk && item.complexity?.includes("Risk")) {
      const parts = item.complexity.split(/·|·|\|/);
      item.complexity = cleanFacet(parts[0]);
      const riskPart = parts.find((p) => /risk/i.test(p));
      if (riskPart) {
        item.risk = cleanFacet(riskPart);
      }
    } else {
      item.complexity = item.complexity ? cleanFacet(item.complexity) : undefined;
      item.risk = item.risk ? cleanFacet(item.risk) : undefined;
    }
  }

  applyActionOrder(markdown, items);
  return { data: { items }, warnings };
}

function cleanFacet(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  // Compact first so the label prefix (`Risk:`) is anchored at the string start.
  const stripped = compact(value.replace(/\*\*/g, "")).replace(/^(complexity|risk)\s*:\s*/i, "");
  return compact(stripped) || undefined;
}

function extractSourceFinding(lines: string[]): string | undefined {
  const raw = fieldValue(lines, "Source finding");
  if (!raw) {
    return undefined;
  }
  const match = raw.match(/#(\d+)/);
  return match ? `#${match[1]}` : compact(raw);
}

/** Read the "Recommended Action Order" list and stamp each item's rank. */
function applyActionOrder(markdown: string, items: ParsedAnalysisItem[]): void {
  const section = splitTopSections(markdown).find((s) => /recommended action order/i.test(s.title));
  if (!section) {
    return;
  }
  let rank = 0;
  for (const line of section.lines) {
    const match = line.match(/^\s*\d+\.\s+\*{0,2}(QW|ARCH|LT|QFG|CONTRA)-(\d+)/);
    if (!match) {
      continue;
    }
    rank += 1;
    const itemId = `${match[1]}-${match[2]}`;
    const target = items.find((i) => i.itemId === itemId);
    if (target) {
      target.actionOrder = rank;
    }
  }
}

/** Parse `implementation-YYYY-MM-DD.md` → per-item outcomes + remaining backlog. */
export function parseImplementationReport(markdown: string): ParseResult<ParsedImplReport> {
  const warnings: string[] = [];
  const items: ParsedImplItem[] = [];
  const sections = splitTopSections(markdown);

  const statusLine = markdown.split(/\r?\n/).find((l) => /^status:/i.test(l.trim()));
  const status = statusLine ? compact(statusLine.replace(/^status:/i, "")) : undefined;

  const outcomeForSection = (title: string): ImplementationOutcome | null => {
    if (/implement/i.test(title)) {
      return "implemented";
    }
    if (/skip/i.test(title)) {
      return "skipped";
    }
    if (/fail/i.test(title)) {
      return "failed";
    }
    return null;
  };

  for (const section of sections) {
    const outcome = outcomeForSection(section.title);
    if (!outcome) {
      continue;
    }
    // Each `### <itemId>: ...` under the section is one implemented/skipped item.
    let block: { itemId: string; lines: string[] } | null = null;
    const flush = () => {
      if (!block) {
        return;
      }
      const detail = block.lines.join("\n").trim();
      const commitRaw = fieldValue(block.lines, "Commit");
      items.push({
        itemId: block.itemId,
        outcome,
        filesChanged: splitInlineList(fieldValue(block.lines, "Files changed")),
        tests: fieldValue(block.lines, "Tests"),
        commit: commitRaw ? (commitRaw.match(COMMIT_SHA)?.[1] ?? undefined) : undefined,
        detail,
      });
      block = null;
    };
    for (const line of section.lines) {
      const heading = line.match(/^#{3,4}\s+(QW|ARCH|LT|QFG|CONTRA)-(\d+)\b.*$/);
      if (heading) {
        flush();
        block = { itemId: `${heading[1]}-${heading[2]}`, lines: [] };
        continue;
      }
      if (line.match(/^#{2,4}\s+/) && block) {
        flush();
      }
      if (block) {
        block.lines.push(line);
      }
    }
    flush();
  }

  const backlogSection = sections.find((s) => /backlog/i.test(s.title));
  const backlog: ParsedBacklogItem[] = [];
  if (backlogSection) {
    for (const text of extractListItems(backlogSection.lines)) {
      const idMatch = text.match(/\b(QW|ARCH|LT|QFG|CONTRA|A|L|Q)-(\d+)\b/);
      backlog.push({
        itemId: idMatch ? `${idMatch[1]}-${idMatch[2]}` : undefined,
        text,
      });
    }
  }

  return { data: { status, items, backlog }, warnings };
}

function splitInlineList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .replace(/`/g, "")
    .split(/,|;/)
    .map((part) => compact(part))
    .filter((part) => part.length > 0);
}

/** Derive the human category label for display/filtering. */
export function categoryLabel(category: ResearchCategory): string {
  switch (category) {
    case "quick-win":
      return "Quick Win";
    case "architecture":
      return "Architecture";
    case "long-horizon":
      return "Long-Horizon";
    case "queue-guidance":
      return "Queue for Guidance";
    case "contradictory":
      return "Contradictory";
    case "finding":
      return "Finding";
    case "watch":
      return "Watch";
  }
}
