// Control UI view: manage egress vault credentials.
//
// Self-contained element: holds its own list/form state and talks to the gateway
// directly via vault.list / vault.save / vault.delete. The plaintext value only
// leaves the masked input on save; the list never receives or shows values.
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway.ts";

type VaultApprovalPolicy = "auto" | "ask";

type VaultEntry = {
  name: string;
  hostAllowlist: string[];
  headerTemplate: string;
  approvalPolicy: VaultApprovalPolicy;
  createdAt: number;
  updatedAt: number;
};

export class OpenClawVaultView extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private entries: VaultEntry[] = [];
  @state() private loading = false;
  @state() private saving = false;
  @state() private error = "";
  @state() private formName = "";
  @state() private formValue = "";
  @state() private formHosts = "";
  @state() private formPolicy: VaultApprovalPolicy = "ask";

  static override styles = css`
    :host {
      display: block;
      padding: 16px;
      color: var(--text, #e6e6e6);
    }
    .intro {
      font-size: 13px;
      opacity: 0.75;
      margin-bottom: 16px;
      max-width: 60ch;
    }
    .error {
      color: var(--danger, #ff6b6b);
      font-size: 13px;
      margin-bottom: 12px;
    }
    .card {
      border: 1px solid var(--border, #333);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      background: var(--surface, rgba(255, 255, 255, 0.02));
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border, #2a2a2a);
    }
    .row:last-child {
      border-bottom: none;
    }
    .name {
      font-weight: 600;
    }
    .meta {
      font-size: 12px;
      opacity: 0.7;
    }
    .badge {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--border, #444);
      opacity: 0.85;
    }
    label {
      display: block;
      font-size: 12px;
      opacity: 0.8;
      margin: 10px 0 4px;
    }
    input,
    select {
      width: 100%;
      box-sizing: border-box;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid var(--border, #444);
      background: var(--input-bg, #111);
      color: inherit;
      font: inherit;
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
    button.danger {
      border-color: var(--danger, #b14);
      color: var(--danger, #ff8a8a);
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    h3 {
      margin: 0 0 8px;
      font-size: 14px;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  private async load(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.loading = true;
    this.error = "";
    try {
      const result = await this.client.request<{ entries: VaultEntry[] }>("vault.list");
      this.entries = result?.entries ?? [];
    } catch (err) {
      this.error = `Failed to load credentials: ${String(err)}`;
    } finally {
      this.loading = false;
    }
  }

  private async save(): Promise<void> {
    if (!this.client) {
      return;
    }
    const name = this.formName.trim();
    const hostAllowlist = this.formHosts
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    if (!name || !this.formValue || hostAllowlist.length === 0) {
      this.error = "Name, value, and at least one host are required.";
      return;
    }
    this.saving = true;
    this.error = "";
    try {
      await this.client.request("vault.save", {
        name,
        value: this.formValue,
        hostAllowlist,
        approvalPolicy: this.formPolicy,
      });
      this.formName = "";
      this.formValue = "";
      this.formHosts = "";
      this.formPolicy = "ask";
      await this.load();
    } catch (err) {
      this.error = `Failed to save: ${String(err)}`;
    } finally {
      this.saving = false;
    }
  }

  private async deleteEntry(name: string): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.request("vault.delete", { name });
      await this.load();
    } catch (err) {
      this.error = `Failed to delete: ${String(err)}`;
    }
  }

  private renderList() {
    if (this.loading) {
      return html`<div class="meta">Loading…</div>`;
    }
    if (this.entries.length === 0) {
      return html`<div class="meta">No saved credentials yet.</div>`;
    }
    return this.entries.map(
      (entry) => html`
        <div class="row">
          <div>
            <div class="name">${entry.name}</div>
            <div class="meta">${entry.hostAllowlist.join(", ")}</div>
          </div>
          <div style="display:flex; align-items:center; gap:10px;">
            <span class="badge">${entry.approvalPolicy}</span>
            <button class="danger" @click=${() => void this.deleteEntry(entry.name)}>Delete</button>
          </div>
        </div>
      `,
    );
  }

  override render() {
    return html`
      <div class="intro">
        Saved API credentials are encrypted on the gateway and injected into outbound requests only
        for their allowlisted hosts. The agent uses them via <code>http_request</code> and never
        sees the value.
      </div>
      ${this.error ? html`<div class="error">${this.error}</div>` : nothing}

      <div class="card">
        <h3>Saved credentials</h3>
        ${this.renderList()}
      </div>

      <div class="card">
        <h3>Add a credential</h3>
        <label for="vault-name">Name</label>
        <input
          id="vault-name"
          .value=${this.formName}
          @input=${(e: Event) => {
            this.formName = (e.target as HTMLInputElement).value;
          }}
          placeholder="stripe"
        />
        <label for="vault-value">Secret value</label>
        <input
          id="vault-value"
          type="password"
          autocomplete="off"
          .value=${this.formValue}
          @input=${(e: Event) => {
            this.formValue = (e.target as HTMLInputElement).value;
          }}
          placeholder="sk_live_…"
        />
        <label for="vault-hosts">Allowed hosts (comma-separated)</label>
        <input
          id="vault-hosts"
          .value=${this.formHosts}
          @input=${(e: Event) => {
            this.formHosts = (e.target as HTMLInputElement).value;
          }}
          placeholder="api.stripe.com"
        />
        <label for="vault-policy">Injection policy</label>
        <select
          id="vault-policy"
          .value=${this.formPolicy}
          @change=${(e: Event) => {
            this.formPolicy = (e.target as HTMLSelectElement).value as VaultApprovalPolicy;
          }}
        >
          <option value="ask">Ask before use</option>
          <option value="auto">Inject automatically</option>
        </select>
        <div style="margin-top:14px;">
          <button class="primary" ?disabled=${this.saving} @click=${() => void this.save()}>
            ${this.saving ? "Saving…" : "Save credential"}
          </button>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-vault-view")) {
  customElements.define("openclaw-vault-view", OpenClawVaultView);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-vault-view": OpenClawVaultView;
  }
}
