// Control UI tests cover agents behavior.
import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { renderAgentFiles } from "./agents-panels-status-files.ts";
import { renderAgents, type AgentsProps } from "./agents.ts";

function createSkill() {
  return {
    name: "Repo Skill",
    description: "Skill description",
    source: "workspace",
    filePath: "/tmp/skill",
    baseDir: "/tmp",
    skillKey: "repo-skill",
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    missing: {
      bins: [],
      env: [],
      config: [],
      os: [],
    },
    configChecks: [],
    install: [],
  };
}

function directText(element: Element | null | undefined): string | undefined {
  return Array.from(element?.childNodes ?? [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
}

function expectAgentTab(container: Element, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).find(
    (candidate) => directText(candidate) === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected agent tab "${text}"`);
  }
  return button;
}

function createProps(overrides: Partial<AgentsProps> = {}): AgentsProps {
  return {
    basePath: "",
    loading: false,
    error: null,
    agentsList: {
      defaultId: "alpha",
      mainKey: "main",
      scope: "workspace",
      agents: [{ id: "alpha", name: "Alpha" } as never, { id: "beta", name: "Beta" } as never],
    },
    selectedAgentId: "beta",
    activePanel: "overview",
    config: {
      form: null,
      loading: false,
      saving: false,
      dirty: false,
    },
    channels: {
      snapshot: null,
      loading: false,
      error: null,
      lastSuccess: null,
    },
    cron: {
      status: null,
      jobs: [],
      loading: false,
      error: null,
    },
    agentFiles: {
      list: null,
      loading: false,
      error: null,
      active: null,
      contents: {},
      drafts: {},
      saving: false,
    },
    agentIdentityLoading: false,
    agentIdentityError: null,
    agentIdentityById: {},
    agentSkills: {
      report: null,
      loading: false,
      error: null,
      agentId: null,
      filter: "",
    },
    toolsCatalog: {
      loading: false,
      error: null,
      result: null,
    },
    toolsEffective: {
      loading: false,
      error: null,
      result: null,
    },
    runtimeSessionKey: "main",
    runtimeSessionMatchesSelectedAgent: false,
    modelCatalog: [],
    onRefresh: () => undefined,
    onSelectAgent: () => undefined,
    onSelectPanel: () => undefined,
    onLoadFiles: () => undefined,
    onSelectFile: () => undefined,
    onFileDraftChange: () => undefined,
    onFileReset: () => undefined,
    onFileSave: () => undefined,
    onToolsProfileChange: () => undefined,
    onToolsOverridesChange: () => undefined,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    onModelChange: () => undefined,
    onModelFallbacksChange: () => undefined,
    onThinkingDefaultChange: () => undefined,
    onChannelsRefresh: () => undefined,
    onCronRefresh: () => undefined,
    onCronRunNow: () => undefined,
    onSkillsFilterChange: () => undefined,
    onSkillsRefresh: () => undefined,
    onAgentSkillToggle: () => undefined,
    onAgentSkillsClear: () => undefined,
    onAgentSkillsDisableAll: () => undefined,
    onSetDefault: () => undefined,
    ...overrides,
  };
}

describe("renderAgents", () => {
  it("selects the configured primary model on initial render", async () => {
    const container = document.createElement("div");
    const configForm = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        list: [{ id: "alpha" }, { id: "beta" }],
      },
    };

    render(
      renderAgents(
        createProps({
          selectedAgentId: "alpha",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const defaultSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>(".agent-model-fields select");
      expect(select?.value).toBe("openai/gpt-5.4");
      return select;
    });
    expect(defaultSelect?.selectedOptions[0]?.value).toBe("openai/gpt-5.4");

    render(
      renderAgents(
        createProps({
          selectedAgentId: "beta",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const inheritedSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>(".agent-model-fields select");
      expect(select?.value).toBe("");
      return select;
    });
    expect(inheritedSelect?.selectedOptions[0]?.textContent?.trim()).toBe(
      "Inherit default (openai/gpt-5.4)",
    );
  });

  it("remounts overview model controls when switching selected agents", async () => {
    const container = document.createElement("div");
    const configForm = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-sonnet-4-6": {},
            "openai/gpt-5.4": {},
          },
        },
        list: [
          { id: "alpha", model: { primary: "anthropic/claude-sonnet-4-6" } },
          { id: "beta", model: { primary: "openai/gpt-5.4" } },
        ],
      },
    };

    render(
      renderAgents(
        createProps({
          selectedAgentId: "beta",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const betaSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>(".agent-model-fields select");
      expect(
        Array.from(select?.options ?? []).some((option) => option.value === "openai/gpt-5.4"),
      ).toBe(true);
      return select;
    });

    render(
      renderAgents(
        createProps({
          selectedAgentId: "alpha",
          config: {
            form: configForm,
            loading: false,
            saving: false,
            dirty: false,
          },
        }),
      ),
      container,
    );

    const alphaSelect = await vi.waitFor(() => {
      const select = container.querySelector<HTMLSelectElement>(".agent-model-fields select");
      expect(
        Array.from(select?.options ?? []).some(
          (option) => option.value === "anthropic/claude-sonnet-4-6",
        ),
      ).toBe(true);
      return select;
    });
    expect(alphaSelect).not.toBe(betaSelect);
  });

  it("renders the resolved per-agent thinking default in the overview", async () => {
    const container = document.createElement("div");

    render(
      renderAgents(
        createProps({
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "alpha", name: "Alpha", thinkingDefault: "off" } as never,
              { id: "beta", name: "Beta", thinkingDefault: "xhigh" } as never,
            ],
          },
          selectedAgentId: "beta",
        }),
      ),
      container,
    );

    await Promise.resolve();

    const thinkingKv = Array.from(container.querySelectorAll(".agent-kv")).find(
      (entry) =>
        entry.querySelector(".label")?.textContent?.trim() === t("agents.context.thinkingDefault"),
    );
    expect(thinkingKv?.textContent).toContain("xhigh");
  });

  it("offers only the model's thinking levels and stages the choice", async () => {
    const container = document.createElement("div");
    const thinkingChanges: Array<string | null> = [];
    const configForm = {
      agents: {
        list: [{ id: "beta", thinkingDefault: "high" }],
      },
    };

    render(
      renderAgents(
        createProps({
          agentsList: {
            defaultId: "alpha",
            mainKey: "main",
            scope: "workspace",
            agents: [
              { id: "alpha", name: "Alpha" } as never,
              {
                id: "beta",
                name: "Beta",
                thinkingDefault: "medium",
                thinkingLevels: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ],
              } as never,
            ],
          },
          selectedAgentId: "beta",
          config: { form: configForm, loading: false, saving: false, dirty: false },
          onThinkingDefaultChange: (_agentId, level) => thinkingChanges.push(level),
        }),
      ),
      container,
    );

    const select = await vi.waitFor(() => {
      const found = container.querySelector<HTMLSelectElement>(".agent-thinking-default");
      expect(found).toBeTruthy();
      return found as HTMLSelectElement;
    });

    // Inherit + only the model-supported levels; the explicit override is selected.
    expect(Array.from(select.options).map((option) => option.value)).toEqual([
      "",
      "low",
      "medium",
      "high",
    ]);
    expect(select.value).toBe("high");

    // Picking a level stages it; picking inherit clears it.
    select.value = "low";
    select.dispatchEvent(new Event("change"));
    expect(thinkingChanges.at(-1)).toBe("low");

    select.value = "";
    select.dispatchEvent(new Event("change"));
    expect(thinkingChanges.at(-1)).toBeNull();
  });

  it("shows the skills count only for the selected agent's report", async () => {
    const container = document.createElement("div");
    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "alpha",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    let skillsTab = expectAgentTab(container, "Skills");

    expect(skillsTab.textContent?.trim()).toBe("Skills");

    render(
      renderAgents(
        createProps({
          agentSkills: {
            report: {
              workspaceDir: "/tmp/workspace",
              managedSkillsDir: "/tmp/skills",
              skills: [createSkill()],
            },
            loading: false,
            error: null,
            agentId: "beta",
            filter: "",
          },
        }),
      ),
      container,
    );
    await Promise.resolve();

    skillsTab = expectAgentTab(container, "Skills");

    expect(directText(skillsTab)).toBe("Skills");
    expect(skillsTab.querySelector(".agent-tab-count")?.textContent).toBe("1");
  });

  it("keeps the Cron Jobs tab label while localizing channel refresh never state", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");

    try {
      render(
        renderAgents(
          createProps({
            activePanel: "channels",
            channels: {
              snapshot: null,
              loading: false,
              error: null,
              lastSuccess: null,
            },
          }),
        ),
        container,
      );
      await Promise.resolve();

      const tabLabels = Array.from(container.querySelectorAll<HTMLButtonElement>(".agent-tab")).map(
        (button) => button.textContent?.trim(),
      );

      expect(tabLabels).toEqual(["概览", "文件", "工具", "技能", "频道", "Cron Jobs"]);
      const cards = container.querySelectorAll("section.card");
      expect(cards[1]?.querySelector(".muted")?.textContent?.trim()).toBe("上次刷新：从未");
    } finally {
      await i18n.setLocale("en");
      vi.unstubAllGlobals();
    }
  });

  it("renders ordered numbered fallbacks, reorders, removes, and offers configured models to add", async () => {
    const container = document.createElement("div");
    const fallbackChanges: string[][] = [];
    const configForm = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {},
            "anthropic/claude-sonnet-4-6": {},
            "google/gemini-2.0-flash": {},
            "deepseek/deepseek-v4-pro": {},
          },
        },
        list: [
          {
            id: "beta",
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["anthropic/claude-sonnet-4-6", "google/gemini-2.0-flash"],
            },
          },
        ],
      },
    };

    render(
      renderAgents(
        createProps({
          selectedAgentId: "beta",
          config: { form: configForm, loading: false, saving: false, dirty: false },
          onModelFallbacksChange: (_agentId, next) => fallbackChanges.push(next),
        }),
      ),
      container,
    );

    const rows = await vi.waitFor(() => {
      const found = container.querySelectorAll(".agent-fallback-row");
      expect(found.length).toBe(2);
      return found;
    });

    // Numbered in priority order.
    expect(rows[0]?.querySelector(".agent-fallback-index")?.textContent?.trim()).toBe("1");
    expect(rows[1]?.querySelector(".agent-fallback-index")?.textContent?.trim()).toBe("2");
    expect(rows[0]?.querySelector(".agent-fallback-name")?.textContent?.trim()).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(rows[1]?.querySelector(".agent-fallback-name")?.textContent?.trim()).toBe(
      "google/gemini-2.0-flash",
    );

    // Add picker offers the unused configured model but not the primary or chosen fallbacks.
    const addSelect = container.querySelector<HTMLSelectElement>(".agent-fallback-add");
    const optionValues = Array.from(addSelect?.options ?? [])
      .map((option) => option.value)
      .filter(Boolean);
    expect(optionValues).toContain("deepseek/deepseek-v4-pro");
    expect(optionValues).not.toContain("openai/gpt-5.4");
    expect(optionValues).not.toContain("anthropic/claude-sonnet-4-6");
    expect(optionValues).not.toContain("google/gemini-2.0-flash");

    // First row cannot move up; moving it down swaps the order.
    const firstUp = rows[0]?.querySelector<HTMLButtonElement>(
      ".agent-fallback-move[aria-label='Move fallback up']",
    );
    expect(firstUp?.disabled).toBe(true);
    rows[0]
      ?.querySelector<HTMLButtonElement>(".agent-fallback-move[aria-label='Move fallback down']")
      ?.click();
    expect(fallbackChanges.at(-1)).toEqual([
      "google/gemini-2.0-flash",
      "anthropic/claude-sonnet-4-6",
    ]);

    // Removing a row drops that fallback.
    rows[0]?.querySelector<HTMLButtonElement>(".chip-remove")?.click();
    expect(fallbackChanges.at(-1)).toEqual(["google/gemini-2.0-flash"]);

    // Selecting from the add picker appends it to the end.
    if (addSelect) {
      addSelect.value = "deepseek/deepseek-v4-pro";
      addSelect.dispatchEvent(new Event("change"));
    }
    expect(fallbackChanges.at(-1)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "google/gemini-2.0-flash",
      "deepseek/deepseek-v4-pro",
    ]);
  });
});

describe("renderAgentFiles", () => {
  it("renders the upgraded markdown preview structure with file metadata", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    expect(container.querySelectorAll(".md-preview-dialog__reader.sidebar-markdown")).toHaveLength(
      1,
    );
    expect(container.querySelector(".md-preview-dialog__path")?.textContent?.trim()).toBe(
      "USER.md",
    );
    expect(container.querySelector(".md-preview-dialog__chip strong")?.textContent).toBe(
      "Saved Preview",
    );
    expect(container.querySelector(".md-preview-dialog__eyebrow span")?.textContent?.trim()).toBe(
      "Markdown Preview",
    );
  });

  it("renders preview header controls as icon-only buttons with accessible labels", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    const actions = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".md-preview-dialog__actions button"),
    );

    expect(actions).toHaveLength(3);
    expect(actions.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Expand preview",
      "Edit file",
      "Close preview",
    ]);
    expect(actions.map((button) => button.textContent?.trim())).toEqual(["", "", ""]);
  });

  it("resets the expanded preview button state when the dialog closes", () => {
    const container = document.createElement("div");

    render(
      renderAgentFiles({
        agentId: "alpha",
        agentFilesList: {
          agentId: "alpha",
          workspace: "/tmp/workspace",
          files: [
            {
              name: "USER.md",
              path: "/tmp/workspace/USER.md",
              missing: false,
              size: 128,
              updatedAtMs: 1_700_000_000_000,
            },
          ],
        },
        agentFilesLoading: false,
        agentFilesError: null,
        agentFileActive: "USER.md",
        agentFileContents: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileDrafts: {
          "USER.md": "# User Profile\n\nHello world",
        },
        agentFileSaving: false,
        onLoadFiles: () => undefined,
        onSelectFile: () => undefined,
        onFileDraftChange: () => undefined,
        onFileReset: () => undefined,
        onFileSave: () => undefined,
      }),
      container,
    );

    const dialog = container.querySelector<HTMLDialogElement>(".md-preview-dialog");
    const panel = container.querySelector<HTMLElement>(".md-preview-dialog__panel");
    const expandButton = container.querySelector<HTMLButtonElement>(".md-preview-expand-btn");

    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(panel).toBeInstanceOf(HTMLElement);
    expect(expandButton).toBeInstanceOf(HTMLButtonElement);
    const previewPanel = panel!;
    const previewExpandButton = expandButton!;
    previewExpandButton.click();

    expect([...previewPanel.classList]).toEqual(["md-preview-dialog__panel", "fullscreen"]);
    expect([...previewExpandButton.classList]).toEqual([
      "btn",
      "btn--sm",
      "md-preview-icon-btn",
      "md-preview-expand-btn",
      "is-fullscreen",
    ]);
    expect(previewExpandButton.getAttribute("aria-pressed")).toBe("true");
    expect(previewExpandButton.getAttribute("aria-label")).toBe("Collapse preview");

    dialog!.dispatchEvent(new Event("close"));

    expect([...previewPanel.classList]).toEqual(["md-preview-dialog__panel"]);
    expect([...previewExpandButton.classList]).toEqual([
      "btn",
      "btn--sm",
      "md-preview-icon-btn",
      "md-preview-expand-btn",
    ]);
    expect(previewExpandButton.getAttribute("aria-pressed")).toBe("false");
    expect(previewExpandButton.getAttribute("aria-label")).toBe("Expand preview");
  });
});
