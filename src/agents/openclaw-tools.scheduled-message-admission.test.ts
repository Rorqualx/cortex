import { expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../gateway/message-action-turn-capability.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createOpenClawTools } from "./openclaw-tools.js";

// Regression: openclaw-tools stopped mapping the factory's
// `admitScheduledMessageInvocation` onto the message tool's
// `admitScheduledInvocation`, so scheduled sends failed closed with
// "Scheduled message invocation requires current tool policy admission" even
// when the run held a minted turn capability (cron isolated runs).

const identity = {
  agentId: "main",
  runId: "openclaw-tools-admission-run",
  sessionKey: "agent:main:cron:admission-mapping:run:fixture",
};

function createConfig(): OpenClawConfig {
  return { channels: { discord: { token: "fixture-token" } } };
}

function mintScheduledCapability(): string {
  return mintMessageActionTurnCapability({
    ...identity,
    scheduled: {
      policy: { version: 1, mode: "trusted" },
      assertCurrent: () => {},
      assertSourceCurrent: () => {},
    },
  });
}

function createMessageToolFor(capability: string, admit?: () => OpenClawConfig) {
  const config = createConfig();
  const tools = createOpenClawTools({
    config,
    agentId: identity.agentId,
    agentSessionKey: identity.sessionKey,
    runId: identity.runId,
    messageActionTurnCapability: capability,
    admitScheduledMessageInvocation: admit,
  });
  const message = tools.find((tool) => tool.name === "message");
  expect(message, "message tool must be registered").toBeDefined();
  return message;
}

async function withDiscordRegistry(run: () => Promise<void>) {
  const registry = captureActivePluginRegistrySnapshot();
  const plugin: ChannelPlugin = {
    ...createChannelTestPluginBase({ id: "discord" }),
    actions: { describeMessageTool: () => ({ actions: ["send", "read"] }) },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
  try {
    await run();
  } finally {
    restoreActivePluginRegistrySnapshot(registry);
  }
}

it("maps factory scheduled admission onto the message tool send", async () => {
  const capability = mintScheduledCapability();
  try {
    await withDiscordRegistry(async () => {
      const message = createMessageToolFor(capability, () => createConfig());
      await expect(
        message.execute("admitted-send", {
          channel: "discord",
          target: "channel:100000000000000001",
          action: "send",
          message: "Scheduled dry run",
          dryRun: true,
        }),
      ).resolves.toBeDefined();
    });
  } finally {
    revokeMessageActionTurnCapability(capability);
  }
});

it("fails closed on scheduled send when factory admission is absent", async () => {
  const capability = mintScheduledCapability();
  try {
    await withDiscordRegistry(async () => {
      const message = createMessageToolFor(capability);
      await expect(
        message.execute("unadmitted-send", {
          channel: "discord",
          target: "channel:100000000000000001",
          action: "send",
          message: "Should be denied",
          dryRun: true,
        }),
      ).rejects.toThrow(/requires current tool policy admission/);
    });
  } finally {
    revokeMessageActionTurnCapability(capability);
  }
});
