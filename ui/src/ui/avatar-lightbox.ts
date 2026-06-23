// Control UI component: click-to-expand lightbox for avatar images
// with inline crop-and-save utility and upload support.

import { html, LitElement, css, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "./icons.ts";
import {
  loadLocalUserIdentity,
  saveLocalAssistantIdentity,
  saveLocalUserIdentity,
} from "./storage.ts";

/** Which identity a lightbox edits. Agent crops must not touch the user store. */
export type AvatarTarget = "user" | "assistant";

/** Custom event fired when an avatar changes from the lightbox. */
export class AvatarChangeEvent extends CustomEvent<{ avatar: string; target: AvatarTarget }> {
  static eventName = "avatar-change" as const;
  constructor(avatar: string, target: AvatarTarget = "user") {
    super(AvatarChangeEvent.eventName, {
      bubbles: true,
      composed: true,
      detail: { avatar, target },
    });
  }
}

export class AvatarLightbox extends LitElement {
  @property() src = "";
  @property() alt = "";
  /** If true, show the crop/upload controls. Default true. */
  @property({ type: Boolean }) editable = true;
  /** If true, show the Remove button. Default false. */
  @property({ type: Boolean }) removable = false;
  /** Which identity this lightbox edits. Default user. */
  @property() target: AvatarTarget = "user";

  @state() private cropping = false;
  @state() private cropUrl: string | null = null;
  @state() private saved = false;

  private imgEl?: HTMLImageElement;
  private canvasEl?: HTMLCanvasElement;
  private crop = { x: 0, y: 0, size: 0 };
  private dragging = false;
  private dragStart = { x: 0, y: 0 };

  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 300;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      animation: al-fade-in 0.15s ease-out;
    }

    @keyframes al-fade-in {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }

    .lightbox-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      max-width: min(540px, calc(100vw - 48px));
    }

    .image-area {
      position: relative;
      border-radius: var(--radius-md, 8px);
      overflow: hidden;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
      cursor: pointer;
      background: #111;
    }

    .image-area img {
      display: block;
      max-width: min(480px, calc(100vw - 80px));
      max-height: calc(100dvh - 200px);
      object-fit: contain;
    }

    .crop-area {
      position: relative;
      border-radius: var(--radius-md, 8px);
      overflow: hidden;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
      background: #111;
    }

    .crop-area canvas {
      display: block;
      max-width: min(480px, calc(100vw - 80px));
      cursor: crosshair;
    }

    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: center;
    }

    .toolbar button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 16px;
      border: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      color: var(--text);
      background: var(--card);
      transition:
        background 0.12s,
        transform 0.1s;
    }

    .toolbar button:hover {
      background: var(--panel-strong);
      transform: translateY(-1px);
    }

    .toolbar button:active {
      transform: translateY(0);
    }

    .btn-save {
      background: var(--accent) !important;
      color: var(--bg) !important;
      border-color: var(--accent) !important;
    }

    .btn-save:hover {
      filter: brightness(1.1);
    }

    .btn-save:disabled {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none !important;
    }

    .btn-close {
      background: transparent !important;
      border: none !important;
      color: rgba(255, 255, 255, 0.5);
      padding: 8px !important;
    }
    .btn-close:hover {
      color: #fff;
      background: transparent !important;
    }

    .close-hint {
      color: rgba(255, 255, 255, 0.4);
      font-size: 0.7rem;
    }

    .saved-msg {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #10b981;
      font-size: 0.85rem;
      font-weight: 600;
      animation: al-pop 0.3s ease;
    }

    .saved-msg svg {
      width: 16px;
      height: 16px;
    }

    @keyframes al-pop {
      0% {
        transform: scale(0.8);
        opacity: 0;
      }
      100% {
        transform: scale(1);
        opacity: 1;
      }
    }

    .preview-row {
      display: flex;
      gap: 16px;
      align-items: center;
    }

    .preview-row div {
      text-align: center;
    }

    .preview-row p {
      font-size: 0.7rem;
      color: rgba(255, 255, 255, 0.4);
      margin-top: 4px;
    }

    .preview-row img {
      border-radius: var(--radius-md, 6px);
      border: 1px solid rgba(255, 255, 255, 0.15);
    }

    /* Hidden file input */
    input[type="file"] {
      display: none;
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback() {
    document.removeEventListener("keydown", this.handleKeydown);
    super.disconnectedCallback();
  }

  override updated(changed: Map<string, unknown>) {
    if (changed.has("cropping") && this.cropping) {
      this.initCropCanvas();
    }
  }

  override render() {
    return html`
      <div class="lightbox-content" @click=${(e: Event) => e.stopPropagation()}>
        ${this.cropping ? this.renderCropMode() : this.renderViewMode()}
      </div>
    `;
  }

  private renderViewMode() {
    return html`
      <div class="image-area" @click=${this.close}>
        <img src=${this.src} alt=${this.alt} />
      </div>
      ${this.saved
        ? html`<span class="saved-msg"
            >${icons.check}<span>Avatar updated — refreshing…</span></span
          >`
        : nothing}
      ${this.editable && !this.saved
        ? html`
            <div class="toolbar">
              <button @click=${this.startCrop} title="Crop this image">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M6.13 1L6 16a2 2 0 002 2h15" />
                  <path d="M1 6.13L16 6a2 2 0 012 2v15" />
                </svg>
                Crop
              </button>
              <button @click=${this.triggerUpload} title="Upload a new image">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                Upload
              </button>
              ${this.removable
                ? html`
                    <button @click=${this.removeAvatar} title="Remove your avatar">
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path
                          d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"
                        />
                      </svg>
                      Remove
                    </button>
                  `
                : nothing}
              <button class="btn-close" @click=${this.close} title="Close">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <span class="close-hint">Press Escape to close</span>
            <input id="avatar-upload" type="file" accept="image/*" @change=${this.handleUpload} />
          `
        : nothing}
    `;
  }

  private renderCropMode() {
    return html`
      <div class="crop-area">
        <canvas id="crop-canvas"></canvas>
      </div>
      ${this.cropUrl
        ? html`
            <div class="preview-row">
              <div>
                <img src=${this.cropUrl} width="36" height="36" style="border-radius:50%" />
                <p>Chat</p>
              </div>
              <div>
                <img src=${this.cropUrl} width="48" height="48" style="border-radius:8px" />
                <p>Settings</p>
              </div>
              <div>
                <img src=${this.cropUrl} width="80" height="80" style="border-radius:8px" />
                <p>Full</p>
              </div>
            </div>
          `
        : nothing}
      <div class="toolbar">
        <button class="btn-save" @click=${this.saveCrop} ?disabled=${!this.cropUrl}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Apply as Avatar
        </button>
        <button @click=${this.cancelCrop}>Cancel</button>
      </div>
    `;
  }

  // ─── Crop logic ───

  private startCrop() {
    this.cropping = true;
    this.cropUrl = null;
  }

  private cancelCrop() {
    this.cropping = false;
    this.cropUrl = null;
  }

  private initCropCanvas() {
    const canvas = this.shadowRoot?.getElementById("crop-canvas") as HTMLCanvasElement | null;
    if (!canvas) {
      return;
    }
    this.canvasEl = canvas;

    const img = new Image();
    img.onload = () => {
      this.imgEl = img;
      const maxW = Math.min(480, window.innerWidth - 80);
      const scale = maxW / img.width;
      canvas.style.width = `${Math.round(img.width * scale)}px`;
      canvas.style.height = `${Math.round(img.height * scale)}px`;
      canvas.width = img.width;
      canvas.height = img.height;

      const s = Math.min(img.width, img.height);
      this.crop = { x: (img.width - s) / 2, y: (img.height - s) / 2, size: s };
      this.drawCropOverlay();
      this.updateCropPreview();

      canvas.addEventListener("mousedown", this.onPointerDown);
      canvas.addEventListener("mousemove", this.onPointerMove);
      canvas.addEventListener("mouseup", this.onPointerUp);
      canvas.addEventListener("mouseleave", this.onPointerUp);
      canvas.addEventListener("touchstart", this.onTouchStart, { passive: false });
      canvas.addEventListener("touchmove", this.onTouchMove, { passive: false });
      canvas.addEventListener("touchend", this.onPointerUp);
    };
    img.src = this.src;
  }

  private drawCropOverlay() {
    const canvas = this.canvasEl;
    const img = this.imgEl;
    if (!canvas || !img) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const { x, y, size } = this.crop;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, canvas.width, y);
    ctx.fillRect(0, y, x, size);
    ctx.fillRect(x + size, y, canvas.width - x - size, size);
    ctx.fillRect(0, y + size, canvas.width, canvas.height - y - size);

    ctx.strokeStyle = "var(--accent, #4a9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, size, size);

    ctx.fillStyle = "var(--accent, #4a9)";
    for (const [cx, cy] of [
      [x, y],
      [x + size, y],
      [x, y + size],
      [x + size, y + size],
    ]) {
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private updateCropPreview() {
    const img = this.imgEl;
    if (!img) {
      return;
    }
    const { x, y, size } = this.crop;
    const tc = document.createElement("canvas");
    tc.width = size;
    tc.height = size;
    tc.getContext("2d")!.drawImage(img, x, y, size, size, 0, 0, size, size);
    this.cropUrl = tc.toDataURL("image/jpeg", 0.92);
  }

  private canvasCoords(clientX: number, clientY: number) {
    const canvas = this.canvasEl!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  private onPointerDown = (e: MouseEvent) => {
    this.dragStart = this.canvasCoords(e.clientX, e.clientY);
    this.dragging = true;
  };

  private onPointerMove = (e: MouseEvent) => {
    if (!this.dragging) {
      return;
    }
    this.updateCropFromPointer(e.clientX, e.clientY);
  };

  private onPointerUp = () => {
    this.dragging = false;
  };

  private onTouchStart = (e: TouchEvent) => {
    e.preventDefault();
    const t = e.touches[0];
    this.dragStart = this.canvasCoords(t.clientX, t.clientY);
    this.dragging = true;
  };

  private onTouchMove = (e: TouchEvent) => {
    e.preventDefault();
    if (!this.dragging) {
      return;
    }
    const t = e.touches[0];
    this.updateCropFromPointer(t.clientX, t.clientY);
  };

  private updateCropFromPointer(clientX: number, clientY: number) {
    const canvas = this.canvasEl!;
    const p = this.canvasCoords(clientX, clientY);
    const dx = p.x - this.dragStart.x;
    const dy = p.y - this.dragStart.y;
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    if (side < 10) {
      return;
    }
    const sx = dx >= 0 ? this.dragStart.x : this.dragStart.x - side;
    const sy = dy >= 0 ? this.dragStart.y : this.dragStart.y - side;
    const cx = Math.max(0, Math.min(sx, canvas.width - side));
    const cy = Math.max(0, Math.min(sy, canvas.height - side));
    const cs = Math.min(side, canvas.width - cx, canvas.height - cy);
    if (cs < 20) {
      return;
    }
    this.crop = { x: cx, y: cy, size: cs };
    this.drawCropOverlay();
    this.updateCropPreview();
  }

  // ─── Save ───

  private saveCrop() {
    if (!this.cropUrl) {
      return;
    }
    this.applyAvatar(this.cropUrl);
  }

  private removeAvatar() {
    try {
      this.persistAvatar(null);

      this.dispatchEvent(new AvatarChangeEvent("", this.target));
      document.dispatchEvent(new AvatarChangeEvent("", this.target));

      this.saved = true;
      setTimeout(() => this.close(), 800);
    } catch {
      // best effort
    }
  }

  private applyAvatar(dataUrl: string) {
    try {
      this.persistAvatar(dataUrl);

      // Dispatch so the app updates its reactive state; the document hop reaches
      // listeners from the shadow DOM, and target tells the host which identity
      // to apply so an agent crop never lands on the user's avatar.
      this.dispatchEvent(new AvatarChangeEvent(dataUrl, this.target));
      document.dispatchEvent(new AvatarChangeEvent(dataUrl, this.target));

      this.src = dataUrl;
      this.cropping = false;
      this.cropUrl = null;
      this.saved = true;

      // Auto-close and refresh after a beat
      setTimeout(() => this.close(), 1200);
    } catch {
      // localStorage quota — best effort
    }
  }

  // Persist to the store that matches what this lightbox edits. Agent avatars
  // own a separate local identity from the user's; never cross them.
  private persistAvatar(avatar: string | null) {
    if (this.target === "assistant") {
      saveLocalAssistantIdentity({ avatar });
      return;
    }
    saveLocalUserIdentity({ ...loadLocalUserIdentity(), avatar });
  }

  // ─── Upload ───

  private triggerUpload() {
    const input = this.shadowRoot?.getElementById("avatar-upload") as HTMLInputElement | null;
    if (input) {
      input.click();
    }
  }

  private handleUpload(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    // Validate size (keep under 1.5MB after base64 expansion)
    if (file.size > 1_500_000) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Switch to crop mode with the uploaded image
      this.src = dataUrl;
      this.cropping = true;
      this.cropUrl = null;
    };
    reader.readAsDataURL(file);
    // Reset input so re-uploading the same file works
    input.value = "";
  }

  // ─── Keyboard / close ───

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (this.cropping) {
        this.cancelCrop();
      } else {
        this.close();
      }
    }
  };

  close = () => {
    this.remove();
  };
}

if (!customElements.get("avatar-lightbox")) {
  customElements.define("avatar-lightbox", AvatarLightbox);
}

declare global {
  interface HTMLElementTagNameMap {
    "avatar-lightbox": AvatarLightbox;
  }
}

/**
 * Opens a lightbox overlay showing the full avatar image.
 * Call from a click handler on an <img> avatar element.
 */
export function openAvatarLightbox(
  src: string,
  alt: string = "",
  opts?: { editable?: boolean; removable?: boolean; target?: AvatarTarget },
) {
  const lightbox = document.createElement("avatar-lightbox");
  lightbox.src = src;
  lightbox.alt = alt;
  lightbox.editable = opts?.editable ?? true;
  lightbox.removable = opts?.removable ?? false;
  lightbox.target = opts?.target ?? "user";
  lightbox.addEventListener("click", () => lightbox.close?.());
  document.body.appendChild(lightbox);
}
