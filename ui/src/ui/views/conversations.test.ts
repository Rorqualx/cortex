/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import {
  classifyConversation,
  renderConversations,
  type ConversationFilter,
  type ConversationsProps,
} from "./conversations.ts";

function row(overrides: Partial<GatewaySessionRow> & { key: string }): GatewaySessionRow {
  return {
    kind: "direct",
    updatedAt: 1_000,
    ...overrides,
  } as GatewaySessionRow;
}

const CRON = row({
  key: "agent:main:cron:9d1cec60-4db3-4c7c-a0da-447b7bcf26ce",
  label: "Cron: LLM Research",
  derivedTitle: "LLM Research",
  updatedAt: 3_000,
});
const CHANNEL = row({
  key: "agent:main:telegram:7814261895",
  derivedTitle: "hi there",
  updatedAt: 2_000,
});
const CHAT = row({
  key: "agent:main:main",
  derivedTitle: "Reply with exactly: pong",
  updatedAt: 1_000,
});

function createProps(overrides: Partial<ConversationsProps> = {}): ConversationsProps {
  return {
    loading: false,
    result: { sessions: [CRON, CHANNEL, CHAT] } as SessionsListResult,
    error: null,
    basePath: "",
    searchQuery: "",
    sourceFilter: "all",
    agentIdentityById: {},
    onSearchChange: vi.fn(),
    onSourceFilterChange: vi.fn(),
    onRefresh: vi.fn(),
    onNavigateToChat: vi.fn(),
    onDelete: vi.fn(),
    mainSessionKey: "agent:main:main",
    ...overrides,
  };
}

function mount(props: ConversationsProps): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderConversations(props), container);
  return container;
}

describe("classifyConversation", () => {
  it("buckets cron, channel, and chat sessions", () => {
    expect(classifyConversation(CRON)).toBe("cron");
    // Detected via the cron channel segment even without a "Cron:" label.
    expect(classifyConversation(row({ key: "agent:main:cron:abc" }))).toBe("cron");
    expect(classifyConversation(CHANNEL)).toBe("channel");
    expect(classifyConversation(CHAT)).toBe("chat");
  });
});

describe("renderConversations", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("renders an avatar (not the old dot) per row and a clean cron title", () => {
    const container = mount(createProps());
    expect(container.querySelector(".conversation-row__dot")).toBeNull();
    expect(container.querySelectorAll(".conversation-row__avatar")).toHaveLength(3);
    const names = [...container.querySelectorAll(".conversation-row__name")].map((n) =>
      n.textContent?.trim(),
    );
    expect(names).toContain("LLM Research");
  });

  it("badges cron and channel rows", () => {
    const container = mount(createProps());
    const badges = [...container.querySelectorAll(".conversation-row__badge")].map((b) =>
      b.textContent?.trim(),
    );
    expect(badges).toContain("cron");
    expect(badges).toContain("telegram");
  });

  it("renders source filter chips with per-source counts", () => {
    const container = mount(createProps());
    const chips = [...container.querySelectorAll(".conversations-filter")].map((c) =>
      c.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(chips.some((c) => c?.startsWith("All") && c.endsWith("3"))).toBe(true);
    expect(chips.some((c) => c?.startsWith("Cron") && c.endsWith("1"))).toBe(true);
  });

  it("applies the active source filter", () => {
    const container = mount(createProps({ sourceFilter: "cron" as ConversationFilter }));
    expect(container.querySelectorAll(".conversation-row")).toHaveLength(1);
    expect(container.querySelector(".conversation-row__name")?.textContent?.trim()).toBe(
      "LLM Research",
    );
  });

  it("fires onSourceFilterChange when a chip is clicked", () => {
    const onSourceFilterChange = vi.fn();
    const container = mount(createProps({ onSourceFilterChange }));
    const cronChip = [
      ...container.querySelectorAll<HTMLButtonElement>(".conversations-filter"),
    ].find((c) => c.textContent?.includes("Cron"));
    cronChip?.click();
    expect(onSourceFilterChange).toHaveBeenCalledWith("cron");
  });
});
