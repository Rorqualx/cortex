import type { z } from "zod";
import type {
  HookMappingConfigInput,
  HooksGmailConfigInput,
  InternalHooksConfigInput,
} from "./zod-schema.hooks.js";
import type { InstallRecordBase } from "./zod-schema.installs.js";
import type { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

export type HookMappingConfig = Omit<HookMappingConfigInput, "channel"> & {
  /** Preserve channel-id autocomplete while allowing runtime plugin channels. */
  channel?: "last" | (string & {});
  /** Fork: LLM-based validation for this mapping (spawns a subagent to gate execution). */
  validateViaAgent?: boolean;
  /** Fork: agent id used for validation; falls back to the hook's target or default agent. */
  validationAgentId?: string;
  /** Fork: custom validation prompt; supports {{path}}/{{headers.*}}/{{payload.*}} template vars. */
  validationPrompt?: string;
};

export type HookSessionMode = NonNullable<HookMappingConfigInput["sessionMode"]>;
export type HooksGmailTailscaleMode = NonNullable<
  NonNullable<HooksGmailConfigInput["tailscale"]>["mode"]
>;
export type HookConfig = NonNullable<NonNullable<InternalHooksConfigInput["entries"]>[string]>;

export type HookInstallRecord = InstallRecordBase & {
  hooks?: string[];
};

type HooksSchemaInput = NonNullable<z.input<typeof OpenClawSchemaShape.hooks>>;

export type HooksConfig = Omit<HooksSchemaInput, "mappings"> & {
  mappings?: HookMappingConfig[];
};
