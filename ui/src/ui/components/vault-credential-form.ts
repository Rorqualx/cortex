// Control UI: shared add-credential form for the egress vault.
//
// One element, used inline by the Vault view and inside the composer modal, so
// the auth-kind fields stay in a single place. It collects the kind-specific
// secret material + non-secret config and saves via vault.save; the value is
// sent once and encrypted server-side. On success it emits `vault-saved`.
import { LitElement, css, html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway.ts";

type VaultPolicy = "ask" | "auto";
type AuthKind = "bearer" | "basic" | "header" | "login";
type HeaderRow = { name: string; value: string };

const AUTH_KINDS: { value: AuthKind; label: string }[] = [
  { value: "bearer", label: "API token (Bearer)" },
  { value: "basic", label: "Username + password (Basic)" },
  { value: "header", label: "Custom header(s)" },
  { value: "login", label: "Login form → session token" },
];

export class OpenClawVaultCredentialForm extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private name = "";
  @state() private hosts = "";
  @state() private description = "";
  @state() private policy: VaultPolicy = "ask";
  @state() private authKind: AuthKind = "bearer";

  // bearer
  @state() private token = "";
  // basic / login
  @state() private username = "";
  @state() private password = "";
  // header
  @state() private headerRows: HeaderRow[] = [{ name: "X-API-Key", value: "" }];
  // login (defaults match the common router login-form shape)
  @state() private loginUrl = "";
  @state() private bodyTemplate = "login_authorization={{basic}}";
  @state() private extractFrom: "set-cookie" | "header" | "json" = "set-cookie";
  @state() private extractKey = "asus_token";
  @state() private placeAs: "cookie" | "header" = "cookie";
  @state() private placeKey = "asus_token";
  @state() private ttl = "1800";

  @state() private saving = false;
  @state() private error = "";

  static override styles = css`
    :host {
      display: block;
      color: var(--text, #e6e6e6);
    }
    .form {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .hint {
      font-size: 12px;
      opacity: 0.7;
      margin: 0 0 6px;
    }
    label {
      display: block;
      font-size: 12px;
      opacity: 0.85;
      margin: 10px 0 4px;
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
      min-height: 40px;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .row input {
      flex: 1;
    }
    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
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
    button.link {
      border: none;
      background: none;
      padding: 4px 0;
      opacity: 0.8;
      text-decoration: underline;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  private input(
    field:
      | "name"
      | "hosts"
      | "description"
      | "token"
      | "username"
      | "password"
      | "loginUrl"
      | "bodyTemplate"
      | "extractKey"
      | "placeKey"
      | "ttl",
  ) {
    return (e: Event) => {
      this[field] = (e.target as HTMLInputElement).value;
    };
  }

  private setHeaderRow(index: number, key: keyof HeaderRow, value: string): void {
    this.headerRows = this.headerRows.map((row, i) =>
      i === index ? { ...row, [key]: value } : row,
    );
  }

  private buildPayload(): Record<string, unknown> | null {
    const name = this.name.trim();
    const hostAllowlist = this.hosts
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean);
    if (!name || hostAllowlist.length === 0) {
      this.error = "Name and at least one host are required.";
      return null;
    }
    const common = {
      name,
      hostAllowlist,
      approvalPolicy: this.policy,
      ...(this.description.trim() ? { description: this.description.trim() } : {}),
    };
    if (this.authKind === "bearer") {
      if (!this.token) {
        this.error = "Token is required.";
        return null;
      }
      return { ...common, authKind: "bearer", token: this.token };
    }
    if (this.authKind === "basic") {
      if (!this.username || !this.password) {
        this.error = "Username and password are required.";
        return null;
      }
      return { ...common, authKind: "basic", username: this.username, password: this.password };
    }
    if (this.authKind === "header") {
      const headers = this.headerRows
        .map((row) => ({ name: row.name.trim(), value: row.value }))
        .filter((row) => row.name && row.value);
      if (headers.length === 0) {
        this.error = "At least one header name and value are required.";
        return null;
      }
      return { ...common, authKind: "header", headers };
    }
    if (!this.username || !this.password) {
      this.error = "Username and password are required.";
      return null;
    }
    if (!this.loginUrl.trim() || !this.extractKey.trim() || !this.placeKey.trim()) {
      this.error = "Login URL and the token extract/place fields are required.";
      return null;
    }
    const extract =
      this.extractFrom === "set-cookie"
        ? { from: "set-cookie", cookieName: this.extractKey.trim() }
        : this.extractFrom === "header"
          ? { from: "header", header: this.extractKey.trim() }
          : { from: "json", path: this.extractKey.trim() };
    const place =
      this.placeAs === "cookie"
        ? { as: "cookie", cookieName: this.placeKey.trim() }
        : { as: "header", template: this.placeKey.trim() };
    return {
      ...common,
      authKind: "login",
      username: this.username,
      password: this.password,
      login: {
        loginUrl: this.loginUrl.trim(),
        bodyTemplate: this.bodyTemplate,
        extract,
        place,
        ttlSeconds: Number(this.ttl) || 1800,
      },
    };
  }

  private async save(): Promise<void> {
    if (!this.client) {
      return;
    }
    this.error = "";
    const payload = this.buildPayload();
    if (!payload) {
      return;
    }
    this.saving = true;
    try {
      await this.client.request("vault.save", payload);
      this.dispatchEvent(new CustomEvent("vault-saved", { bubbles: true, composed: true }));
    } catch (err) {
      this.error = `Failed to save: ${String(err)}`;
    } finally {
      this.saving = false;
    }
  }

  private renderKindFields() {
    if (this.authKind === "bearer") {
      return html`
        <label for="v-token">API token</label>
        <input
          id="v-token"
          type="password"
          autocomplete="off"
          .value=${this.token}
          @input=${this.input("token")}
          placeholder="sk_live_…"
        />
      `;
    }
    if (this.authKind === "basic" || this.authKind === "login") {
      return html`
        <div class="grid2">
          <div>
            <label for="v-user">Username</label>
            <input id="v-user" .value=${this.username} @input=${this.input("username")} />
          </div>
          <div>
            <label for="v-pass">Password</label>
            <input
              id="v-pass"
              type="password"
              autocomplete="off"
              .value=${this.password}
              @input=${this.input("password")}
            />
          </div>
        </div>
        ${this.authKind === "login" ? this.renderLoginFields() : nothing}
      `;
    }
    // header
    return html`
      ${this.headerRows.map(
        (row, i) => html`
          <div class="row" style="margin-top:8px;">
            <input
              placeholder="Header name"
              .value=${row.name}
              @input=${(e: Event) =>
                this.setHeaderRow(i, "name", (e.target as HTMLInputElement).value)}
            />
            <input
              type="password"
              autocomplete="off"
              placeholder="Value"
              .value=${row.value}
              @input=${(e: Event) =>
                this.setHeaderRow(i, "value", (e.target as HTMLInputElement).value)}
            />
            ${this.headerRows.length > 1
              ? html`<button
                  class="link"
                  @click=${() => {
                    this.headerRows = this.headerRows.filter((_, j) => j !== i);
                  }}
                >
                  remove
                </button>`
              : nothing}
          </div>
        `,
      )}
      <button
        class="link"
        @click=${() => {
          this.headerRows = [...this.headerRows, { name: "", value: "" }];
        }}
      >
        + add header
      </button>
    `;
  }

  private renderLoginFields() {
    return html`
      <label for="v-loginurl">Login URL</label>
      <input
        id="v-loginurl"
        .value=${this.loginUrl}
        @input=${this.input("loginUrl")}
        placeholder="http://192.168.50.1/login.cgi"
      />
      <label for="v-body">Login body template</label>
      <input
        id="v-body"
        .value=${this.bodyTemplate}
        @input=${this.input("bodyTemplate")}
        placeholder="login_authorization={{basic}}"
      />
      <p class="hint">
        Placeholders: <code>{{username}}</code> <code>{{password}}</code>
        <code>{{basic}}</code> (base64 user:pass) <code>{{basicRaw}}</code> (user:pass).
      </p>
      <div class="grid2">
        <div>
          <label for="v-extract-from">Token from</label>
          <select
            id="v-extract-from"
            .value=${this.extractFrom}
            @change=${(e: Event) => {
              this.extractFrom = (e.target as HTMLSelectElement).value as typeof this.extractFrom;
            }}
          >
            <option value="set-cookie">Response cookie</option>
            <option value="header">Response header</option>
            <option value="json">JSON body field</option>
          </select>
        </div>
        <div>
          <label for="v-extract-key">Cookie / header / path</label>
          <input id="v-extract-key" .value=${this.extractKey} @input=${this.input("extractKey")} />
        </div>
      </div>
      <div class="grid2">
        <div>
          <label for="v-place-as">Send token as</label>
          <select
            id="v-place-as"
            .value=${this.placeAs}
            @change=${(e: Event) => {
              this.placeAs = (e.target as HTMLSelectElement).value as typeof this.placeAs;
            }}
          >
            <option value="cookie">Cookie</option>
            <option value="header">Header template</option>
          </select>
        </div>
        <div>
          <label for="v-place-key"
            >${this.placeAs === "cookie" ? "Cookie name" : "Header template ({{token}})"}</label
          >
          <input id="v-place-key" .value=${this.placeKey} @input=${this.input("placeKey")} />
        </div>
      </div>
      <label for="v-ttl">Session lifetime (seconds)</label>
      <input id="v-ttl" type="number" .value=${this.ttl} @input=${this.input("ttl")} />
    `;
  }

  override render() {
    return html`
      <div class="form">
        <label for="v-name">Name</label>
        <input id="v-name" .value=${this.name} @input=${this.input("name")} placeholder="stripe" />

        <label for="v-kind">Credential type</label>
        <select
          id="v-kind"
          .value=${this.authKind}
          @change=${(e: Event) => {
            this.authKind = (e.target as HTMLSelectElement).value as AuthKind;
          }}
        >
          ${AUTH_KINDS.map((kind) => html`<option value=${kind.value}>${kind.label}</option>`)}
        </select>

        ${this.renderKindFields()}

        <label for="v-hosts">Allowed hosts (comma-separated)</label>
        <input
          id="v-hosts"
          .value=${this.hosts}
          @input=${this.input("hosts")}
          placeholder="api.stripe.com"
        />

        <label for="v-desc">Description (optional)</label>
        <input id="v-desc" .value=${this.description} @input=${this.input("description")} />

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
          <button class="primary" ?disabled=${this.saving} @click=${() => void this.save()}>
            ${this.saving ? "Saving…" : "Save credential"}
          </button>
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-vault-credential-form")) {
  customElements.define("openclaw-vault-credential-form", OpenClawVaultCredentialForm);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-vault-credential-form": OpenClawVaultCredentialForm;
  }
}
