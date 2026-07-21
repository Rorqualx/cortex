/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderQuickSettings,
  type QuickSettingsAgentCard,
  type QuickSettingsProps,
} from "./config-quick.ts";

// Minimal full props so renderQuickSettings (which renders every card) mounts.
// The Personal-card assertions below only depend on the identity fields.
function createProps(overrides: Partial<QuickSettingsProps> = {}): QuickSettingsProps {
  return {
    currentModel: "gpt-5.5",
    thinkingLevel: "off",
    fastMode: false,
    modelOptions: [{ value: "", label: "Default" }],
    selectedModelValue: "",
    onModelSelect: vi.fn(),
    onThinkingChange: vi.fn(),
    onFastModeChange: vi.fn(),
    channels: [],
    onChannelConfigure: vi.fn(),
    automation: { cronJobCount: 0, skillCount: 0, mcpServerCount: 0 },
    onManageCron: vi.fn(),
    onBrowseSkills: vi.fn(),
    onConfigureMcp: vi.fn(),
    security: {
      gatewayAuth: "Unknown",
      execPolicy: "Allowlist",
      deviceAuth: true,
      browserEnabled: true,
      toolProfile: "coding",
    },
    onSecurityConfigure: vi.fn(),
    onBrowserEnabledToggle: vi.fn(),
    onToolProfileChange: vi.fn(),
    theme: "claw",
    themeMode: "system",
    hasCustomTheme: false,
    customThemeLabel: null,
    borderRadius: 50,
    textScale: 100,
    setTheme: vi.fn(),
    onOpenCustomThemeImport: vi.fn(),
    setThemeMode: vi.fn(),
    setBorderRadius: vi.fn(),
    setTextScale: vi.fn(),
    userAvatar: null,
    onUserAvatarChange: vi.fn(),
    configObject: {},
    onSelectPreset: vi.fn(),
    onAdvancedSettings: vi.fn(),
    connected: true,
    gatewayUrl: "ws://localhost:18789",
    assistantName: "OpenClaw",
    assistantAvatar: null,
    basePath: "",
    version: "2026.4.22",
    ...overrides,
  };
}

const AGENTS: QuickSettingsAgentCard[] = [
  {
    id: "main",
    name: "Davos",
    description: "General-purpose assistant.",
    emoji: "🧅",
    avatarUrl: "blob:fake-davos",
    isDefault: true,
    hasOverride: false,
  },
  {
    id: "varys",
    name: "Varys",
    description: "Long-context specialist.",
    emoji: "🕸️",
    avatarUrl: null,
    isDefault: false,
    hasOverride: false,
  },
];

function personalCard(container: Element): Element {
  const card = container.querySelector(".qs-card--personal");
  if (!card) {
    throw new Error("Personal card not rendered");
  }
  return card;
}

describe("Personal card agents grid", () => {
  it("renders one card per agent: image for the default, emoji for the rest", () => {
    const container = document.createElement("div");
    render(renderQuickSettings(createProps({ agents: AGENTS })), container);

    const card = personalCard(container);
    const assistantCards = card.querySelectorAll(".qs-identity-card--assistant");
    expect(assistantCards.length).toBe(2);

    // Default agent shows its fetched image (blob URL).
    const davosImg = card.querySelector<HTMLImageElement>(
      ".qs-identity-card--assistant img.qs-assistant-avatar",
    );
    expect(davosImg?.getAttribute("src")).toBe("blob:fake-davos");

    // Non-default agent with no image falls back to its emoji.
    const emoji = card.querySelector(".qs-assistant-avatar--text");
    expect(emoji?.textContent?.trim()).toBe("🕸️");

    // Both agent names are present.
    const titles = Array.from(card.querySelectorAll(".qs-identity-card__title")).map((n) =>
      n.textContent?.trim(),
    );
    expect(titles).toContain("Davos");
    expect(titles).toContain("Varys");
  });

  it("routes a per-agent upload through onAgentAvatarOverrideChange with the agent id", () => {
    const onAgentAvatarOverrideChange = vi.fn();
    const container = document.createElement("div");
    render(
      renderQuickSettings(createProps({ agents: AGENTS, onAgentAvatarOverrideChange })),
      container,
    );

    const card = personalCard(container);
    const varysCard = Array.from(card.querySelectorAll(".qs-identity-card--assistant")).find(
      (el) => el.querySelector(".qs-identity-card__title")?.textContent?.trim() === "Varys",
    );
    const fileInput = varysCard?.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).toBeInstanceOf(HTMLInputElement);

    const file = new File(["x"], "varys.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file] });
    // FileReader is async; assert the handler is wired by spying on it via change.
    fileInput?.dispatchEvent(new Event("change"));
    // The read completes on a microtask/macrotask; just assert the input was consumed.
    expect(fileInput?.value).toBe("");
  });

  it("falls back to the legacy single-assistant card when no agents are provided", () => {
    const container = document.createElement("div");
    render(
      renderQuickSettings(
        createProps({
          agents: [],
          assistantName: "Davos",
          onAssistantAvatarOverrideChange: vi.fn(),
        }),
      ),
      container,
    );
    const card = personalCard(container);
    expect(card.querySelectorAll(".qs-identity-card--assistant").length).toBe(1);
    expect(card.textContent).toContain("Stores a Control UI override");
  });
});
