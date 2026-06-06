// Control UI view renders markdown sidebar screen content.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { resolveEmbedSandbox, type EmbedSandboxMode } from "../embed-sandbox.ts";
import { icons } from "../icons.ts";
import { highlightCode, normalizeHighlightLanguage, toSanitizedMarkdownHtml } from "../markdown.ts";
import type { SidebarContent } from "../sidebar-content.ts";

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
  if (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
  const lineCount = lines.length;
  const gutterWidth = String(lineCount).length + 1;
  let codeHtml =
    '<div class="code-viewer"><div class="code-viewer__gutter" style="min-width:' +
    gutterWidth +
    'ch">';
  for (let i = 1; i <= lineCount; i++) {
    codeHtml += `<div class="code-viewer__line-num" data-line="${i}">${i}</div>`;
  }
  codeHtml +=
    '</div><div class="code-viewer__content"><pre class="hljs language-' + (lang || "text") + '">';
  for (let i = 0; i < lines.length; i++) {
    codeHtml += `<div class="code-viewer__code-line">${lines[i] || " "}</div>`;
  }
  codeHtml += "</pre></div></div>";
  return html`
    <section class="sidebar-code-viewer-shell">
      <div class="sidebar-markdown-shell__toolbar">
        <div class="sidebar-markdown-shell__intro">
          <div class="sidebar-markdown-shell__eyebrow">
            ${icons.fileText}
            <span>${content.fileName}</span>
          </div>
          <div class="sidebar-markdown-shell__hint">
            ${lineCount.toLocaleString()} lines · ${content.language || "text"}
          </div>
        </div>
        <button @click=${() => {}} class="btn btn--sm" type="button">View Raw Text</button>
      </div>
      ${unsafeHTML(codeHtml)}
    </section>
  `;
}

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
