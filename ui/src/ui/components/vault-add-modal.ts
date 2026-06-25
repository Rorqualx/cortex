// Control UI: composer modal for adding a vault credential.
//
// Thin wrapper that hosts the shared credential form inside a dialog, so the
// quick-add entry point and the Vault view share one form implementation.
import { LitElement, css, html } from "lit";
import { property } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import "./modal-dialog.ts";
import "./vault-credential-form.ts";

export class OpenClawVaultAddModal extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  static override styles = css`
    .wrap {
      min-width: min(460px, 82vw);
      color: var(--text, #e6e6e6);
    }
    .hint {
      font-size: 12px;
      opacity: 0.7;
      margin: 0 0 8px;
    }
  `;

  private close = () => {
    this.dispatchEvent(new CustomEvent("vault-close", { bubbles: true, composed: true }));
  };

  override render() {
    return html`
      <openclaw-modal-dialog label="Add a credential" @modal-cancel=${this.close}>
        <div class="wrap">
          <p class="hint">
            Encrypted on the gateway and injected into requests only for the hosts you allow. The
            agent uses it without ever seeing the value.
          </p>
          <openclaw-vault-credential-form
            .client=${this.client}
            @vault-saved=${this.close}
          ></openclaw-vault-credential-form>
        </div>
      </openclaw-modal-dialog>
    `;
  }
}

if (!customElements.get("openclaw-vault-add-modal")) {
  customElements.define("openclaw-vault-add-modal", OpenClawVaultAddModal);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-vault-add-modal": OpenClawVaultAddModal;
  }
}
