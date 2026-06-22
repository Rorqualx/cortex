import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../types.ts";
import { renderPixelAgentsStrip } from "./pixel-office.ts";

function agentsList(ids: string[]): AgentsListResult {
  return {
    defaultId: ids[0] ?? "main",
    mainKey: "main",
    scope: "operator",
    agents: ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  };
}

function renderStrip(opts: Parameters<typeof renderPixelAgentsStrip>[1]): HTMLElement {
  const container = document.createElement("div");
  render(renderPixelAgentsStrip([], opts), container);
  return container;
}

describe("renderPixelAgentsStrip", () => {
  it("renders one clickable buddy per real agent", () => {
    const container = renderStrip({ agentsList: agentsList(["main", "varys", "newbie"]) });
    expect(container.querySelectorAll(".mo-buddy-btn")).toHaveLength(3);
  });

  it("shows the + create card only when canCreate", () => {
    expect(
      renderStrip({ agentsList: agentsList(["main"]), canCreate: true }).querySelector(
        ".mo-strip__add",
      ),
    ).not.toBeNull();
    expect(
      renderStrip({ agentsList: agentsList(["main"]), canCreate: false }).querySelector(
        ".mo-strip__add",
      ),
    ).toBeNull();
  });

  it("opens the create modal from the + card", () => {
    const requestUpdate = vi.fn();
    const opts = { agentsList: agentsList(["main"]), canCreate: true, requestUpdate };
    const container = renderStrip(opts);
    container.querySelector<HTMLButtonElement>(".mo-strip__add")?.click();
    expect(requestUpdate).toHaveBeenCalled();
    render(renderPixelAgentsStrip([], opts), container);
    const modal = container.querySelector(".mo-modal");
    expect(modal?.textContent).toContain("New agent");
    // Name, Description, Workspace, Model, Emoji.
    expect(container.querySelectorAll(".mo-field")).toHaveLength(5);
  });

  it("composes a prompt from the description via agents.composePrompt", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, prompt: "# Composed\n- you help" });
    const opts = {
      agentsList: agentsList(["main"]),
      canCreate: true,
      connected: true,
      client: { request } as never,
      requestUpdate: vi.fn(),
    };
    const container = renderStrip(opts);
    container.querySelector<HTMLButtonElement>(".mo-strip__add")?.click();
    render(renderPixelAgentsStrip([], opts), container);

    const description = container.querySelector<HTMLTextAreaElement>(".mo-field textarea");
    description!.value = "Triages bug reports.";
    description!.dispatchEvent(new Event("input"));
    render(renderPixelAgentsStrip([], opts), container);

    container.querySelector<HTMLButtonElement>(".mo-btn--ghost")?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("agents.composePrompt", { brief: "Triages bug reports." });
  });

  it("loads SOUL.md in the profile and saves edits via agents.files.set", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "agents.files.get") {
        return { file: { name: "SOUL.md", content: "# Varys\n- you research" } };
      }
      return { ok: true };
    });
    const opts = {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "operator",
        agents: [{ id: "varys", name: "Varys", description: "Research" }],
      } as AgentsListResult,
      connected: true,
      client: { request } as never,
      requestUpdate: vi.fn(),
    };
    const container = renderStrip(opts);
    container.querySelector<HTMLButtonElement>(".mo-buddy-btn")?.click();
    await Promise.resolve();
    await Promise.resolve();
    render(renderPixelAgentsStrip([], opts), container);

    expect(request).toHaveBeenCalledWith("agents.files.get", { agentId: "varys", name: "SOUL.md" });
    container.querySelector<HTMLButtonElement>(".mo-prompt__save")?.click();
    await Promise.resolve();
    expect(request).toHaveBeenCalledWith("agents.files.set", {
      agentId: "varys",
      name: "SOUL.md",
      content: "# Varys\n- you research",
    });
  });

  it("submits agents.create with name + workspace", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, agentId: "tyrion", name: "Tyrion" });
    const onAgentsChanged = vi.fn();
    const opts = {
      agentsList: agentsList(["main"]),
      canCreate: true,
      connected: true,
      client: { request } as never,
      requestUpdate: vi.fn(),
      onAgentsChanged,
    };
    const container = renderStrip(opts);
    container.querySelector<HTMLButtonElement>(".mo-strip__add")?.click();
    render(renderPixelAgentsStrip([], opts), container);

    const [nameInput, workspaceInput] =
      container.querySelectorAll<HTMLInputElement>(".mo-field input");
    nameInput.value = "Tyrion";
    nameInput.dispatchEvent(new Event("input"));
    workspaceInput.value = "/tmp/tyrion";
    workspaceInput.dispatchEvent(new Event("input"));

    const submit = [...container.querySelectorAll<HTMLButtonElement>(".mo-btn--primary")].find(
      (b) => b.textContent?.includes("Create"),
    );
    submit?.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(request).toHaveBeenCalledWith("agents.create", {
      name: "Tyrion",
      workspace: "/tmp/tyrion",
    });
    expect(onAgentsChanged).toHaveBeenCalled();
  });

  it("opens a profile modal with the agent's data", () => {
    const opts = {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "operator",
        agents: [
          { id: "varys", name: "Varys", description: "Research & Intel", workspace: "/ws/varys" },
        ],
      } as AgentsListResult,
      requestUpdate: vi.fn(),
    };
    const container = renderStrip(opts);
    container.querySelector<HTMLButtonElement>(".mo-buddy-btn")?.click();
    render(renderPixelAgentsStrip([], opts), container);
    const modal = container.querySelector(".mo-modal");
    expect(modal?.textContent).toContain("Varys");
    expect(modal?.textContent).toContain("/ws/varys");
  });
});
