// Control UI component: modal listing the channels an operator can configure.
// Opened imperatively from the Quick Settings "Channels" card "+" button,
// mirroring openAvatarLightbox so callers don't thread modal open-state through
// the stateless Quick Settings render functions.

import { html, LitElement, css, nothing } from "lit";
import { property } from "lit/decorators.js";

export type ChannelsModalEntry = {
  id: string;
  label: string;
  /** True when the channel already has config (drives the dot + status copy). */
  configured: boolean;
  detail?: string;
};

export class ChannelsModal extends LitElement {
  @property({ attribute: false }) channels: ChannelsModalEntry[] = [];
  /** Invoked with the chosen channel id; the modal closes right after. */
  @property({ attribute: false }) onConfigure?: (channelId: string) => void;

  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 300;
      display: block;
      animation: cm-fade-in 0.15s ease-out;
    }

    @keyframes cm-fade-in {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }

    .backdrop {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }

    .panel {
      width: min(440px, 100%);
      max-height: calc(100dvh - 48px);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--card, #14161a);
      border: 1px solid color-mix(in srgb, var(--border, #2a2e36) 80%, transparent);
      border-radius: var(--radius-lg, 14px);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
      color: var(--text, #e6e8ec);
    }

    .panel__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 16px;
      background: color-mix(in srgb, var(--bg-elevated, #1b1e24) 60%, var(--card, #14161a) 40%);
      border-bottom: 1px solid color-mix(in srgb, var(--border, #2a2e36) 50%, transparent);
    }

    .panel__title {
      margin: 0;
      font-size: 0.9375rem;
      font-weight: 650;
      letter-spacing: -0.01em;
      color: var(--text-strong, #f4f5f7);
    }

    .panel__sub {
      margin: 2px 0 0;
      font-size: 0.75rem;
      color: var(--muted, #9aa0ab);
    }

    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
      padding: 0;
      border: none;
      border-radius: var(--radius-sm, 6px);
      background: transparent;
      color: var(--muted, #9aa0ab);
      cursor: pointer;
      transition:
        background 0.12s ease,
        color 0.12s ease;
    }

    .icon-btn:hover {
      background: var(--bg-hover, rgba(255, 255, 255, 0.06));
      color: var(--text, #e6e8ec);
    }

    .icon-btn:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #4f9dff) 30%, transparent);
    }

    .icon-btn svg {
      width: 16px;
      height: 16px;
      stroke: currentColor;
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .list {
      overflow-y: auto;
      padding: 6px 0;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 16px;
      min-height: 44px;
    }

    .row + .row {
      border-top: 1px solid color-mix(in srgb, var(--border, #2a2e36) 40%, transparent);
    }

    .row__label {
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text, #e6e8ec);
    }

    .dot {
      width: 7px;
      height: 7px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--muted, #9aa0ab);
    }

    .dot--ok {
      background: var(--ok, #3ecf8e);
      box-shadow: 0 0 6px color-mix(in srgb, var(--ok, #3ecf8e) 45%, transparent);
    }

    .row__action {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 0 0 auto;
    }

    .status {
      font-size: 0.75rem;
      color: var(--muted, #9aa0ab);
    }

    .cfg-btn {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--accent, #4f9dff);
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: var(--radius-sm, 6px);
      white-space: nowrap;
      transition:
        background 0.12s ease,
        opacity 0.12s ease;
    }

    .cfg-btn:hover {
      opacity: 0.85;
      background: var(--accent-subtle, rgba(79, 157, 255, 0.12));
    }

    .cfg-btn:focus-visible {
      outline: none;
      background: var(--accent-subtle, rgba(79, 157, 255, 0.12));
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #4f9dff) 20%, transparent);
    }

    .empty {
      padding: 18px 16px;
      font-size: 0.8125rem;
      color: var(--muted, #9aa0ab);
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    window.removeEventListener("keydown", this.handleKeydown);
    super.disconnectedCallback();
  }

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  // Backdrop is the click target only when the click lands outside the panel;
  // panel clicks have a different target and never reach this branch.
  private handleBackdrop = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      this.close();
    }
  };

  private configure(id: string) {
    this.onConfigure?.(id);
    this.close();
  }

  close = () => {
    this.remove();
  };

  override render() {
    return html`
      <div class="backdrop" @click=${this.handleBackdrop}>
        <div class="panel" role="dialog" aria-modal="true" aria-label="Configure channels">
          <div class="panel__head">
            <div>
              <h2 class="panel__title">Configure channels</h2>
              <p class="panel__sub">Connect a channel to reach your agent there.</p>
            </div>
            <button class="icon-btn" aria-label="Close" @click=${this.close}>
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="list">
            ${this.channels.length === 0
              ? html`<div class="empty">No channels available.</div>`
              : this.channels.map((ch) => this.renderRow(ch))}
          </div>
        </div>
      </div>
    `;
  }

  private renderRow(ch: ChannelsModalEntry) {
    return html`
      <div class="row">
        <span class="row__label">
          <span class="dot ${ch.configured ? "dot--ok" : ""}"></span>
          ${ch.label}
        </span>
        <span class="row__action">
          ${ch.configured
            ? html`<span class="status">${ch.detail ?? "Configured"}</span>`
            : nothing}
          <button class="cfg-btn" @click=${() => this.configure(ch.id)}>
            ${ch.configured ? "Manage →" : "Configure →"}
          </button>
        </span>
      </div>
    `;
  }
}

if (!customElements.get("channels-modal")) {
  customElements.define("channels-modal", ChannelsModal);
}

declare global {
  interface HTMLElementTagNameMap {
    "channels-modal": ChannelsModal;
  }
}

/** Open the channels configuration modal as a body-level overlay. */
export function openChannelsModal(opts: {
  channels: ChannelsModalEntry[];
  onConfigure?: (channelId: string) => void;
}): ChannelsModal {
  const modal = document.createElement("channels-modal");
  modal.channels = opts.channels;
  modal.onConfigure = opts.onConfigure;
  document.body.appendChild(modal);
  return modal;
}
