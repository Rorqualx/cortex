// Harness Guardrails plugin entrypoint: opt-in verify/plan guardrails for
// autonomous agent turns, built on existing agent hooks. See src/plugin.ts.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createGuardrailsConfigSchema } from "./src/config.js";
import { registerGuardrails } from "./src/plugin.js";

export default definePluginEntry({
  id: "harness-guardrails",
  name: "Harness Guardrails",
  description: "Opt-in finalize quality gate and plan-first nudge for autonomous agent turns.",
  configSchema: createGuardrailsConfigSchema(),
  register: registerGuardrails,
});
