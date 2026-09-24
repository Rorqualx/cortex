/**
 * ARCH-1 (a78e8033) — deterministic prose distillation lane.
 *
 * Structure-preserving, fully deterministic compressor for prose/markdown
 * tool outputs (design lab/2026-09-17, plan 09-18, probe 09-19, test 09-20,
 * review 09-21). No LLM in the hot path; keeps all headings and code blocks
 * verbatim, prefers temporally-anchored paragraphs (F8 rule via temporal.ts),
 * fills to the target ratio (floored at PROSE_RATIO_FLOOR) in document
 * order. Same input ⇒ byte-identical output. Dispatch is flag-gated in the
 * content router (`enabledTypes.prose`, default off ⇒ byte parity).
 */
import { hasTemporalAnchor } from "./temporal.js";
import type { CompressorOutput } from "./types.js";

type BlockKind = "heading" | "code" | "list" | "paragraph";

interface Block {
  kind: BlockKind;
  text: string;
}

/** Split content into blocks: fenced code is atomic; blank lines separate. */
export function segmentBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("\n").trim();
    current = [];
    if (text.length === 0) return;
    const first = text.split("\n")[0];
    if (/^#{1,6} /.test(first)) blocks.push({ kind: "heading", text });
    else if (/^([-*+] |\d+\. )/.test(first)) blocks.push({ kind: "list", text });
    else blocks.push({ kind: "paragraph", text });
  };

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      // Fence toggle; fenced regions accumulate atomically (even blank lines).
      if (!inFence) {
        flush();
        inFence = true;
        current = [line];
      } else {
        current.push(line);
        blocks.push({ kind: "code", text: current.join("\n") });
        current = [];
        inFence = false;
      }
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line);
  }
  if (inFence) {
    // Unterminated fence — treat accumulated lines as code.
    blocks.push({ kind: "code", text: current.join("\n") });
  } else {
    flush();
  }
  return blocks;
}

function renderListHead(text: string): string {
  const items = text.split("\n").filter((l) => l.trim().length > 0);
  if (items.length <= 1) return text;
  return `${items[0]}\n[+${items.length - 1} more items]`;
}

export const PROSE_RATIO_FLOOR = 0.3;

/**
 * Deterministically distill prose content down to ~`targetRatio` of its
 * characters (floored at PROSE_RATIO_FLOOR). Structure-preserving: every
 * heading and code block survives verbatim; the first paragraph after each
 * heading and the final paragraph survive; temporally-anchored paragraphs are
 * always kept (F8); remaining paragraphs are kept in document order until the
 * budget is met. The floor is a BUDGET floor (lab 09-20 pin): list-dominant
 * docs may undershoot it because lists are always kept head-truncated and the
 * fill pass only adds paragraphs. Same input ⇒ byte-identical output.
 */
export function compressProseOutput(content: string, targetRatio: number): CompressorOutput {
  const charsBefore = content.length;
  const ratio = Math.max(targetRatio, PROSE_RATIO_FLOOR);
  const blocks = segmentBlocks(content);

  const paragraphs = blocks.filter((b) => b.kind === "paragraph");
  const budgetChars = ratio * charsBefore;

  // Fixed keep-set: headings + code + lists (head-truncated) always survive;
  // first paragraph after each heading, last paragraph of the document, and
  // temporally-anchored paragraphs also survive.
  const keep = new Set<number>();
  let lastParaIdx = -1;
  let prevWasHeading = false;
  let keptChars = 0;
  blocks.forEach((b, i) => {
    if (b.kind === "heading" || b.kind === "code" || b.kind === "list") {
      keep.add(i);
      keptChars += b.kind === "list" ? renderListHead(b.text).length : b.text.length;
      prevWasHeading = b.kind === "heading";
      return;
    }
    if (b.kind === "paragraph") {
      lastParaIdx = i;
      if (prevWasHeading || hasTemporalAnchor(b.text)) {
        keep.add(i);
        keptChars += b.text.length;
      }
      prevWasHeading = false;
      return;
    }
    prevWasHeading = false;
  });
  if (lastParaIdx >= 0 && !keep.has(lastParaIdx)) {
    keep.add(lastParaIdx);
    keptChars += blocks[lastParaIdx].text.length;
  }

  // Fill pass: remaining paragraphs in document order until budget met.
  blocks.forEach((b, i) => {
    if (keep.has(i) || b.kind !== "paragraph") return;
    if (keptChars < budgetChars) {
      keep.add(i);
      keptChars += b.text.length;
    }
  });

  const renderBlock = (b: Block): string => (b.kind === "list" ? renderListHead(b.text) : b.text);

  const keptContent = blocks
    .map((b, i) => (keep.has(i) ? renderBlock(b) : null))
    .filter((s): s is string => s !== null)
    .join("\n\n");
  const keptParas = blocks.filter((b, i) => keep.has(i) && b.kind === "paragraph").length;
  const summary = `— prose distilled: kept ${keptParas}/${paragraphs.length} paragraphs, ${blocks.filter((b) => b.kind === "heading").length} headings, ${blocks.filter((b) => b.kind === "code").length} code blocks (ratio ${ratio.toFixed(2)}) —`;
  const out = `${keptContent}\n\n${summary}`;

  if (out.length >= charsBefore) {
    return {
      content,
      compressed: false,
      charsBefore,
      charsAfter: charsBefore,
      contentType: "prose",
    };
  }

  // Deterministic single pass; no RNG, no clock reads.
  return {
    content: out,
    compressed: true,
    charsBefore,
    charsAfter: out.length,
    contentType: "prose",
  };
}
