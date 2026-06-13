// Control UI tests cover tool expansion state behavior.
import { afterEach, describe, expect, it } from "vitest";
import type { MessageGroup } from "../types/chat-types.ts";
import {
  getExpandedToolCards,
  markToolDisclosureUserToggled,
  resetToolExpansionStateForTest,
  syncToolCardExpansionState,
} from "./tool-expansion-state.ts";

afterEach(() => {
  resetToolExpansionStateForTest();
});

function createGroup(message: unknown, key = "assistant-1"): MessageGroup {
  return {
    kind: "group",
    key,
    role: "assistant",
    messages: [{ key, message }],
    timestamp: 1,
    isStreaming: false,
  };
}

describe("tool expansion state", () => {
  it("expands already-visible tool cards when auto-expand turns on", () => {
    const group = createGroup({
      role: "assistant",
      content: [
        {
          type: "toolcall",
          id: "call-1",
          name: "browser.open",
          arguments: { url: "https://example.com" },
        },
      ],
    });

    syncToolCardExpansionState("main", [group], false);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(false);

    syncToolCardExpansionState("main", [group], true);
    expect(getExpandedToolCards("main").get("assistant-1:toolcard:0")).toBe(true);
  });
});

function toolMessage(text: string) {
  return { role: "tool", toolName: "exec", content: text };
}

function toolGroup(entries: Array<{ key: string; message: unknown }>): MessageGroup {
  return {
    kind: "group",
    key: `group:tool:${entries[0]?.key}`,
    role: "tool",
    messages: entries,
    timestamp: 1,
    isStreaming: false,
  };
}

describe("live-run tool expansion follow", () => {
  it("expands the newest tool disclosure and collapses superseded ones while a run is active", () => {
    const first = { key: "m1", message: toolMessage("one") };
    syncToolCardExpansionState("main", [toolGroup([first])], false, true);
    const expanded = getExpandedToolCards("main");
    expect(expanded.get("toolmsg:m1")).toBe(true);

    const second = { key: "m2", message: toolMessage("two") };
    const group = toolGroup([first, second]);
    syncToolCardExpansionState("main", [group], false, true);
    expect(expanded.get("toolmsg:m1")).toBe(false);
    expect(expanded.get("toolmsg:m2")).toBe(true);
    expect(expanded.get(`activity:${group.key}`)).toBe(true);
  });

  it("collapses auto-expanded disclosures when the run ends", () => {
    const first = { key: "m1", message: toolMessage("one") };
    const second = { key: "m2", message: toolMessage("two") };
    const group = toolGroup([first, second]);
    syncToolCardExpansionState("main", [group], false, true);

    syncToolCardExpansionState("main", [group], false, false);
    const expanded = getExpandedToolCards("main");
    expect(expanded.get("toolmsg:m2")).toBe(false);
    // Activity entry is removed, not pinned closed, so the open-on-error
    // default still applies after the run.
    expect(expanded.has(`activity:${group.key}`)).toBe(false);
  });

  it("leaves user-toggled disclosures alone", () => {
    const first = { key: "m1", message: toolMessage("one") };
    syncToolCardExpansionState("main", [toolGroup([first])], false, true);
    markToolDisclosureUserToggled("main", "toolmsg:m1");

    const second = { key: "m2", message: toolMessage("two") };
    syncToolCardExpansionState("main", [toolGroup([first, second])], false, true);
    const expanded = getExpandedToolCards("main");
    expect(expanded.get("toolmsg:m1")).toBe(true);

    markToolDisclosureUserToggled("main", "toolmsg:m2");
    expanded.set("toolmsg:m2", false);
    syncToolCardExpansionState("main", [toolGroup([first, second])], false, true);
    expect(expanded.get("toolmsg:m2")).toBe(false);
  });

  it("does not auto-expand history when no run is active", () => {
    const first = { key: "m1", message: toolMessage("one") };
    syncToolCardExpansionState("main", [toolGroup([first])], false, false);
    expect(getExpandedToolCards("main").get("toolmsg:m1")).toBe(false);
  });
});
