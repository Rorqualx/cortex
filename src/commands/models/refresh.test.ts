// `openclaw models refresh` is a fork command: it probes each refreshable
// provider's live /models endpoint and reports what appeared or was deprecated.
// Upstream repointed the same command name at its hosted catalog, so the test
// that shipped with upstream exercised a body this fork does not have.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadModelsConfig: vi.fn(async () => ({}) as never),
  listRefreshableProviders: vi.fn(() => [] as string[]),
  runProviderModelDiscovery: vi.fn(),
}));
vi.mock("./load-config.js", () => ({ loadModelsConfig: mocks.loadModelsConfig }));
vi.mock("../../model-catalog/discovery-orchestrator.js", () => ({
  listRefreshableProviders: mocks.listRefreshableProviders,
  runProviderModelDiscovery: mocks.runProviderModelDiscovery,
}));

import { modelsRefreshCommand } from "./refresh.js";

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function report(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    provider: "zai",
    activeCount: 2,
    added: [],
    deprecated: [],
    probedAdded: [],
    ...over,
  };
}

beforeEach(() => {
  mocks.loadModelsConfig.mockClear();
  mocks.listRefreshableProviders.mockReset().mockReturnValue([]);
  mocks.runProviderModelDiscovery.mockReset();
});

describe("models refresh", () => {
  it("explains how to opt in when no provider is refreshable", async () => {
    const rt = runtime();
    await modelsRefreshCommand({}, rt as never);
    expect(mocks.runProviderModelDiscovery).not.toHaveBeenCalled();
    expect(rt.log).toHaveBeenCalledWith(expect.stringContaining('discovery: "refreshable"'));
  });

  it("refreshes an explicit --provider even when it is not opted in", async () => {
    // The opt-in gates the no-argument sweep; naming a provider is an explicit
    // operator request and must override it.
    const rt = runtime();
    mocks.runProviderModelDiscovery.mockResolvedValue(report({ provider: "kimi" }));
    await modelsRefreshCommand({ provider: "kimi" }, rt as never);
    expect(mocks.listRefreshableProviders).not.toHaveBeenCalled();
    expect(mocks.runProviderModelDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "kimi", probeServed: true }),
    );
  });

  it("reports added, served-only, and deprecated models per provider", async () => {
    const rt = runtime();
    mocks.listRefreshableProviders.mockReturnValue(["zai"]);
    mocks.runProviderModelDiscovery.mockResolvedValue(
      report({ added: ["glm-5.2"], probedAdded: ["glm-5.2-air"], deprecated: ["glm-4.9"] }),
    );
    await modelsRefreshCommand({}, rt as never);
    const out = rt.log.mock.calls.flat().join("\n");
    expect(out).toContain("glm-5.2");
    expect(out).toContain("glm-5.2-air");
    expect(out).toContain("glm-4.9");
    // Deprecated models stay recorded, so the operator has to be told what clears them.
    expect(out).toContain("openclaw doctor --fix");
  });

  it("omits the doctor hint when nothing was deprecated", async () => {
    const rt = runtime();
    mocks.listRefreshableProviders.mockReturnValue(["zai"]);
    mocks.runProviderModelDiscovery.mockResolvedValue(report({ added: ["glm-5.2"] }));
    await modelsRefreshCommand({}, rt as never);
    expect(rt.log.mock.calls.flat().join("\n")).not.toContain("openclaw doctor --fix");
  });

  it("emits the raw reports and no prose in JSON mode", async () => {
    const rt = runtime();
    mocks.listRefreshableProviders.mockReturnValue(["zai"]);
    mocks.runProviderModelDiscovery.mockResolvedValue(report());
    await modelsRefreshCommand({ json: true }, rt as never);
    expect(rt.log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(rt.log.mock.calls[0]![0] as string).reports).toHaveLength(1);
  });

  it("surfaces a skipped provider with its reason instead of failing", async () => {
    const rt = runtime();
    mocks.listRefreshableProviders.mockReturnValue(["zai"]);
    mocks.runProviderModelDiscovery.mockResolvedValue({
      ok: false,
      provider: "zai",
      reason: "no api key",
    });
    await modelsRefreshCommand({}, rt as never);
    expect(rt.log.mock.calls.flat().join("\n")).toContain("skipped (no api key)");
  });
});
