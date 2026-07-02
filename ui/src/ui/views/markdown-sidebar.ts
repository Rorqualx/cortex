// Control UI view renders markdown sidebar screen content.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import {
  escapeHtml,
  highlightCode,
  normalizeHighlightLanguage,
  toSanitizedMarkdownHtml,
} from "../markdown.ts";
import type { SidebarContent } from "../sidebar-content.ts";

let lastReadingScrollFile = "";
let readingAnimFrameId: number | null = null;
// Single slot suffices: the app-render scan animates each tool call at most
// once (keyed by toolCallId), so pendingEdit never alternates between edits.
let lastEditScanKey = "";

function cancelReadingScroll() {
  if (readingAnimFrameId != null) {
    cancelAnimationFrame(readingAnimFrameId);
    readingAnimFrameId = null;
  }
}

function triggerReadingScroll(fileName: string) {
  if (fileName === lastReadingScrollFile) {
    return;
  }
  lastReadingScrollFile = fileName;
  // Wait for unsafeHTML to commit, then animate scroll on the sidebar content container
  setTimeout(() => {
    const sidebarContent = document.querySelector(".sidebar-content") as HTMLElement | null;
    if (!sidebarContent) {
      return;
    }
    const duration = 2500;
    const startTime = performance.now();
    const scrollHeight = sidebarContent.scrollHeight - sidebarContent.clientHeight;
    if (scrollHeight <= 0) {
      return;
    }
    sidebarContent.scrollTop = 0;
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      sidebarContent.scrollTop = eased * scrollHeight;
      if (progress < 1) {
        readingAnimFrameId = requestAnimationFrame(animate);
      } else {
        readingAnimFrameId = null;
      }
    };
    readingAnimFrameId = requestAnimationFrame(animate);
  }, 100);
}

/** Dedicated edit scan: sweeps from top to the diff location, holds, then resolves. */
function triggerEditScan(editKey: string) {
  // Only fire once per unique edit
  if (editKey === lastEditScanKey) {
    return;
  }
  lastEditScanKey = editKey;

  // Kill any active read scan
  cancelReadingScroll();
  lastReadingScrollFile = "";

  setTimeout(() => {
    const sidebarContent = document.querySelector(".sidebar-content") as HTMLElement | null;
    if (!sidebarContent) {
      return;
    }
    const diffLine = document.querySelector(
      ".code-viewer__code-line--removed",
    ) as HTMLElement | null;
    if (!diffLine) {
      return;
    }

    // Calculate where the diff line is relative to the scroll container
    const containerTop = sidebarContent.getBoundingClientRect().top;
    const lineTop = diffLine.getBoundingClientRect().top - containerTop + sidebarContent.scrollTop;
    const targetScroll = Math.max(0, lineTop - sidebarContent.clientHeight / 3);
    const duration = 800; // Fast sweep to the edit
    const startTime = performance.now();
    const startScroll = 0;

    sidebarContent.scrollTop = 0;

    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
      sidebarContent.scrollTop = startScroll + eased * (targetScroll - startScroll);
      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };
    requestAnimationFrame(animate);
  }, 120);
}

function resolveSidebarCanvasSandbox(
  content: SidebarContent,
  embedSandboxMode: EmbedSandboxMode,
): string {
  return content.kind === "canvas" ? resolveEmbedSandbox(embedSandboxMode) : "allow-scripts";
}

export type MarkdownSidebarProps = {
  content: SidebarContent | null;
  error: string | null;
  onClose: () => void;
  onViewRawText: () => void;
  canvasPluginSurfaceUrl?: string | null;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
};

function renderCodeViewer(content: import("../sidebar-content.ts").CodeSidebarContent) {
  const lang = normalizeHighlightLanguage(content.language);
  const highlighted = highlightCode(content.content, lang);
  const lines = highlighted.split("\n");
  // Remove trailing empty line from trailing newline
  if (lines.length > 1 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  const rawLines = content.content.split("\n");
  if (rawLines.length > 1 && rawLines[rawLines.length - 1].trim() === "") {
    rawLines.pop();
  }
  const lineCount = lines.length;
  const readingClass = content.reading
    ? " code-viewer--reading"
    : content.editing
      ? " code-viewer--editing"
      : "";
  if (content.reading) {
    triggerReadingScroll(content.fileName);
  }
  if (content.editing && content.pendingEdit) {
    // Key by the unique call id: identical diff text from two distinct calls
    // must still sweep, and a content-derived key cannot tell them apart.
    triggerEditScan(content.pendingEdit.callId);
  }

  // Resolve inline diff position
  let diffStart = -1;
  const pe = content.pendingEdit;
  if (pe && (pe.removed.length || pe.added.length)) {
    if (typeof pe.matchLineIndex === "number" && pe.matchLineIndex >= 0) {
      diffStart = pe.matchLineIndex;
    } else {
      // Fallback: try to find the first added line in raw content (post-edit)
      const firstAdded = pe.added[0];
      if (firstAdded) {
        const idx = rawLines.findIndex((l) => l.trim() === firstAdded.trim());
        if (idx >= 0) {
          diffStart = idx;
        }
      }
      // If not found, try removed lines (pre-edit content)
      if (diffStart < 0) {
        const firstRemoved = pe.removed[0];
        if (firstRemoved) {
          const idx = rawLines.findIndex((l) => l.trim() === firstRemoved.trim());
          if (idx >= 0) {
            diffStart = idx;
          }
        }
      }
    }
  }

  const hasInlineDiff = diffStart >= 0;

  // Calculate total gutter lines (accounting for diff insertions)
  const addedDiffLines = hasInlineDiff ? pe!.added.length : 0;
  const totalVisualLines = lineCount + addedDiffLines;
  const gutterNumWidth = String(Math.max(totalVisualLines, lineCount)).length + 1;

  let codeHtml =
    '<div class="code-viewer' +
    readingClass +
    '"><div class="code-viewer__gutter" style="min-width:' +
    gutterNumWidth +
    'ch">';

  // Build a map of gutter line numbers — diff inserted lines get no number
  let gutterNum = 0;
  for (let i = 0; i < lineCount; i++) {
    gutterNum++;
    codeHtml += `<div class="code-viewer__line-num" data-line="${gutterNum}">${gutterNum}</div>`;
    if (hasInlineDiff && i === diffStart) {
      // Add gutter cells for inserted diff lines (no number, dim)
      for (let d = 0; d < addedDiffLines; d++) {
        codeHtml += `<div class="code-viewer__line-num code-viewer__line-num--diff">&nbsp;</div>`;
      }
    }
  }

  codeHtml +=
    '</div><div class="code-viewer__content"><pre class="hljs language-' + (lang || "text") + '">';
  for (let i = 0; i < lines.length; i++) {
    if (hasInlineDiff && i === diffStart) {
      // Removed lines: red background, struck through
      for (const rm of pe!.removed) {
        codeHtml += `<div class="code-viewer__code-line code-viewer__code-line--removed"><span class="code-viewer__diff-marker">-</span>${escapeHtml(rm) || " "}</div>`;
      }
      // Added lines: green background
      for (const add of pe!.added) {
        codeHtml += `<div class="code-viewer__code-line code-viewer__code-line--added"><span class="code-viewer__diff-marker">+</span>${escapeHtml(add) || " "}</div>`;
      }
      // Skip the original lines that were "removed" (they're shown in red above)
      // Don't skip — keep original lines too for context, but mark them as replaced
      codeHtml += `<div class="code-viewer__code-line code-viewer__code-line--context">${lines[i] || " "}</div>`;
    } else {
      codeHtml += `<div class="code-viewer__code-line">${lines[i] || " "}</div>`;
    }
  }
  codeHtml += "</pre></div></div>";
  return html`
    <section
      class="sidebar-code-viewer-shell${
        content.reading
          ? " sidebar-code-viewer-shell--reading"
          : content.editing
            ? " sidebar-code-viewer-shell--editing"
            : ""
      }""
    >
      <div class="sidebar-markdown-shell__toolbar">
        <div class="sidebar-markdown-shell__intro">
          <div class="sidebar-markdown-shell__eyebrow">
            ${icons.fileText}
            <span>${content.fileName}</span>
          </div>
          <div class="sidebar-markdown-shell__hint">
            ${
              content.reading
                ? html`<span class="code-viewer__status">Reading...</span>`
                : content.editing
                  ? html`<span class="code-viewer__status code-viewer__status--edit"
                      >Editing...</span
                    >`
                  : content.pendingEdit
                    ? html`<span class="code-viewer__status code-viewer__status--edit"
                        >Editing...</span
                      >`
                    : html`${lineCount.toLocaleString()} lines · ${content.language || "text"}`
            }
          </div>
        </div>
      </div>
      ${unsafeHTML(codeHtml)}
    </section>
  `;
}

export { triggerEditScan };

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  const content = props.content;
  const markdownHtml =
    content?.kind === "markdown" && content.content.trim()
      ? toSanitizedMarkdownHtml(content.content)
      : "";
  const canvasSandbox =
    content?.kind === "canvas"
      ? resolveSidebarCanvasSandbox(content, props.embedSandboxMode ?? "scripts")
      : "";
  const canvasSrc =
    content?.kind === "canvas"
      ? resolveCanvasIframeUrl(
          content.entryUrl,
          props.canvasPluginSurfaceUrl,
          props.allowExternalEmbedUrls ?? false,
        )
      : null;
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">
          ${content?.kind === "canvas"
            ? content.title?.trim() || "Render Preview"
            : content?.kind === "code"
              ? content.fileName || "Code Viewer"
              : content?.kind === "markdown"
                ? "Markdown Preview"
                : "Tool Details"}
        </div>
        <button
          @click=${props.onClose}
          class="btn"
          type="button"
          title="Close sidebar"
          aria-label="Close sidebar"
        >
          ${icons.x}
        </button>
      </div>
      <div class="sidebar-content">
        ${props.error
          ? html`
              <div class="callout danger">${props.error}</div>
              ${content?.rawText?.trim()
                ? html`
                    <button
                      @click=${props.onViewRawText}
                      class="btn"
                      type="button"
                      style="margin-top: 12px;"
                    >
                      View Raw Text
                    </button>
                  `
                : nothing}
            `
          : content
            ? content.kind === "canvas"
              ? html`
                  <div class="chat-tool-card__preview" data-kind="canvas">
                    <div class="chat-tool-card__preview-panel" data-side="front">
                      ${keyed(
                        `${canvasSandbox}\u0000${canvasSrc ?? ""}\u0000${content.preferredHeight ?? ""}`,
                        html`
                          <iframe
                            class="chat-tool-card__preview-frame"
                            title=${content.title?.trim() || "Render preview"}
                            sandbox=${canvasSandbox}
                            src=${canvasSrc ?? nothing}
                            style=${content.preferredHeight
                              ? `height:${content.preferredHeight}px`
                              : ""}
                          ></iframe>
                        `,
                      )}
                    </div>
                    ${content.rawText?.trim()
                      ? html`
                          <div style="margin-top: 12px;">
                            <button @click=${props.onViewRawText} class="btn" type="button">
                              View Raw Text
                            </button>
                          </div>
                        `
                      : nothing}
                  </div>
                `
              : content.kind === "code"
                ? renderCodeViewer(content)
                : html`
                    <section class="sidebar-markdown-shell">
                      <div class="sidebar-markdown-shell__toolbar">
                        <div class="sidebar-markdown-shell__intro">
                          <div class="sidebar-markdown-shell__eyebrow">
                            ${icons.scrollText}
                            <span>Rendered Markdown</span>
                          </div>
                          <div class="sidebar-markdown-shell__hint">
                            Sanitized rich-text preview for quick reading.
                          </div>
                        </div>
                        <button @click=${props.onViewRawText} class="btn btn--sm" type="button">
                          View Raw Text
                        </button>
                      </div>
                      ${markdownHtml
                        ? html`
                            <article class="sidebar-markdown-reader sidebar-markdown">
                              ${unsafeHTML(markdownHtml)}
                            </article>
                          `
                        : html`
                            <div class="sidebar-markdown-empty">
                              No previewable markdown content.
                            </div>
                          `}
                    </section>
                  `
            : html` <div class="muted">No content available</div> `}
      </div>
    </div>
  `;
}
