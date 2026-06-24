/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ActivityEvent, ActivityStatusKey } from "../activity-model.ts";
import { renderActivity, type ActivityProps } from "./activity.ts";

function event(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    eventId: "run-1:tool:tool-1",
    ts: 120_900,
    agentId: "davos",
    sessionKey: "main",
    runId: "run-1",
    groupKey: "run-1",
    kind: "tool",
    status: "running",
    title: "Read src/foo.ts",
    ...overrides,
  };
}

function createProps(overrides: Partial<ActivityProps> = {}): ActivityProps {
  const statusFilters: Record<ActivityStatusKey, boolean> = {
    running: true,
    ok: true,
    error: true,
    blocked: true,
    info: true,
  };
  return {
    events: [event()],
    loading: false,
    error: null,
    hasMore: false,
    filterText: "",
    statusFilters,
    kindFilter: "",
    agentFilter: "",
    expandedIds: new Set<string>(),
    autoFollow: true,
    onFilterTextChange: vi.fn(),
    onKindFilterChange: vi.fn(),
    onAgentFilterChange: vi.fn(),
    onStatusToggle: vi.fn(),
    onToggleAutoFollow: vi.fn(),
    onClear: vi.fn(),
    onRefresh: vi.fn(),
    onLoadMore: vi.fn(),
    onExpandAll: vi.fn(),
    onCollapseAll: vi.fn(),
    onEntryToggle: vi.fn(),
    onScroll: vi.fn(),
    ...overrides,
  };
}

describe("renderActivity", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("groups events into a run card and titles steps with the action", () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    const run = container.querySelector(".activity-run");
    expect(run?.getAttribute("role")).toBe("listitem");
    expect(container.querySelector(".activity-run__agent")?.textContent?.trim()).toBe("davos");
    expect(container.querySelector(".activity-step__title")?.textContent?.trim()).toBe(
      "Read src/foo.ts",
    );
  });

  it("surfaces running work in the Now strip", () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    const now = container.querySelector(".activity-now");
    expect(now?.querySelector(".activity-now__chip")?.textContent).toContain("Read src/foo.ts");
  });

  it("exposes the stream as a named list and counts run groups", () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(renderActivity(createProps()), container);

    const stream = container.querySelector(".activity-stream");
    expect(stream?.getAttribute("role")).toBe("list");
    expect(stream?.getAttribute("aria-label")).toBe("Activity feed");
    expect(container.querySelector(".activity-toolbar__count")?.textContent?.trim()).toBe("1 of 1");
  });

  it("hides events whose status filter is off", () => {
    const container = document.createElement("div");
    document.body.append(container);

    render(
      renderActivity(
        createProps({
          statusFilters: { running: false, ok: true, error: true, blocked: true, info: true },
        }),
      ),
      container,
    );

    expect(container.querySelector(".activity-run")).toBeNull();
    expect(container.querySelector(".activity-empty")?.textContent?.trim()).toBe(
      "No activity matches these filters.",
    );
  });
});
