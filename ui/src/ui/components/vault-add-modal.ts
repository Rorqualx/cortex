// Control UI: composer modal for adding a vault credential.
//
// Collects name, description, credential type, the secret value (masked), allowed
// hosts, and injection policy, then saves via vault.save. The type drives the
// injection header template; the value is sent once and encrypted server-side.
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway.ts";
import "./modal-dialog.ts";

type VaultPolicy = "ask" | "auto";

const CREDENTIAL_TYPES = [
  { value: "bearer", label: "API token (Bearer)", needsHeaderName: false },
  { value: "api_key", label: "API key (custom header)", needsHeaderName: true },
  { value: "basic", label: "Basic auth (base64 user:pass)", needsHeaderName: false },
  { value: "custom", label: "Custom header", needsHeaderName: true },
] as const;

export class OpenClawVaultAddModal extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private name = "";
  @state() private description = "";
  @state() private credentialType = "bearer";
  @state() private headerName = "X-API-Key";
  @state() private value = "";
  @state() private hosts = "";
  @state() private policy: VaultPolicy = "ask";
  @state() private saving = false;
  @state() private error = "";

  static override styles = css`
    .form {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: min(440px, 80vw);
      color: var(--text, #e6e6e6);
    }
    .hint {
      font-size: 12px;
      opacity: 0.7;
      margin: 0 0 6px;
    }
    label {
      font-size: 12px;
      opacity: 0.85;
      margin-top: 8px;
    }
    input,
    select,
    textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--border, #444);
      background: var(--input-bg, #111);
      color: inherit;
      font: inherit;
    }
    textarea {
      resize: vertical;
      min-height: 44px;
    }
    .error {
      color: var(--danger, #ff8a8a);
      font-size: 13px;
      margin-top: 8px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    button {
      padding: 7px 14px;
      border-radius: 6px;
      border: 1px solid var(--border, #444);
      background: var(--surface, rgba(255, 255, 255, 0.05));
      color: inherit;
      cursor: pointer;
      font: inherit;
    }
    button.primary {
      background: var(--accent, #3b82f6);
      border-color: var(--accent, #3b82f6);
      color: #fff;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  private close = () => {
    this.dispatchEvent(new CustomEvent("vault-close", { bubbles: true, composed: true }));
  };

  private computeHeaderTemplate(): string {
    if (this.credentialType === "basic") {
      return "Authorization: Basic {{value}}";
    }
    if (this.credentialType === "api_key" || this.credentialType === "custom") {
      const header = this.headerName.trim() || "Authorization";
      return `${header}: {{value}}`;
    }
    return "Authorization: Bearer {{value}}";
  }

  private async save(): Promise<void> {
    if (!this.client) {
      return;
    }
    const name = this.name.trim();
    const hostAllowlist = this.hosts
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    if (!name || !this.value || hostAllowlist.length === 0) {
      this.error = "Name, secret value, and at least one allowed host are required.";
      return;
    }
    this.saving = true;
    this.error = "";
    try {
      await this.client.request("vault.save", {
        name,
        value: this.value,
        hostAllowlist,
        headerTemplate: this.computeHeaderTemplate(),
        approvalPolicy: this.policy,
        credentialType: this.credentialType,
        ...(this.description.trim() ? { description: this.description.trim() } : {}),
      });
      this.dispatchEvent(new CustomEvent("vault-saved", { bubbles: true, composed: true }));
      this.close();
    } catch (err) {
      this.error = `Failed to save: ${String(err)}`;
    } finally {
      this.saving = false;
    }
  }

  override render() {
    const needsHeaderName = this.credentialType === "api_key" || this.credentialType === "custom";
    return html`
      <openclaw-modal-dialog label="Add a credential" @modal-cancel=${this.close}>
        <div class="form">
          <p class="hint">
            Encrypted on the gateway and injected into requests only for the hosts you allow. The
            agent uses it without ever seeing the value.
          </p>

          <label for="v-name">Name</label>
          <input
            id="v-name"
            .value=${this.name}
            @input=${(e: Event) => {
              this.name = (e.target as HTMLInputElement).value;
            }}
            placeholder="stripe"
          />

          <label for="v-desc">Description (optional)</label>
          <textarea
            id="v-desc"
            .value=${this.description}
            @input=${(e: Event) => {
              this.description = (e.target as HTMLTextAreaElement).value;
            }}
            placeholder="Stripe live secret key for charges"
          ></textarea>

          <label for="v-type">Credential type</label>
          <select
            id="v-type"
            .value=${this.credentialType}
            @change=${(e: Event) => {
              this.credentialType = (e.target as HTMLSelectElement).value;
            }}
          >
            ${CREDENTIAL_TYPES.map((t) => html`<option value=${t.value}>${t.label}</option>`)}
          </select>

          ${needsHeaderName
            ? html`
                <label for="v-header">Header name</label>
                <input
                  id="v-header"
                  .value=${this.headerName}
                  @input=${(e: Event) => {
                    this.headerName = (e.target as HTMLInputElement).value;
                  }}
                  placeholder="X-API-Key"
                />
              `
            : nothing}

          <label for="v-value">Secret value (key or password)</label>
          <input
            id="v-value"
            type="password"
            autocomplete="off"
            .value=${this.value}
            @input=${(e: Event) => {
              this.value = (e.target as HTMLInputElement).value;
            }}
            placeholder="sk_live_…"
          />

          <label for="v-hosts">Allowed hosts (comma-separated)</label>
          <input
            id="v-hosts"
            .value=${this.hosts}
            @input=${(e: Event) => {
              this.hosts = (e.target as HTMLInputElement).value;
            }}
            placeholder="api.stripe.com"
          />

          <label for="v-policy">When the agent uses it</label>
          <select
            id="v-policy"
            .value=${this.policy}
            @change=${(e: Event) => {
              this.policy = (e.target as HTMLSelectElement).value as VaultPolicy;
            }}
          >
            <option value="ask">Ask me each new host</option>
            <option value="auto">Use automatically</option>
          </select>

          ${this.error ? html`<div class="error">${this.error}</div>` : nothing}

          <div class="actions">
            <button @click=${this.close}>Cancel</button>
            <button class="primary" ?disabled=${this.saving} @click=${() => void this.save()}>
              ${this.saving ? "Saving…" : "Save credential"}
            </button>
          </div>
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
