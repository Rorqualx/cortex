/**
 * Gateway-side Workboard dispatch driver.
 *
 * Wires the pure dispatcher pass (src/workboard/dispatcher.ts) to the gateway's
 * in-process `agent` method so worker/orchestrator subagents actually start. Run
 * on the maintenance interval; a no-op for boards that have not opted into
 * autonomous orchestration.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWorkboardDispatchPass } from "../workboard/dispatcher.js";
import { getWorkboardStore } from "./server-aux-handlers.js";
import { dispatchGatewayMethodInProcess } from "./server-plugins.js";

const WORKBOARD_DISPATCH_OWNER_ID = "workboard";
const log = createSubsystemLogger("workboard-dispatch");

/** Run one gateway dispatch pass, starting subagents via the in-process agent method. */
export async function runGatewayWorkboardDispatchPass(): Promise<void> {
  const store = await getWorkboardStore();
  await runWorkboardDispatchPass({
    store,
    log: (message) => log.info(message),
    spawn: async ({ sessionKey, message, lane, idempotencyKey }) => {
      // Backend subagent run: synthetic operator client (no request scope on the
      // maintenance loop), hidden from operator chat, owned by "workboard".
      const payload = await dispatchGatewayMethodInProcess<{ runId?: string }>(
        "agent",
        {
          sessionKey,
          message,
          deliver: false,
          lane,
          bootstrapContextMode: "lightweight",
          idempotencyKey,
        },
        {
          forceSyntheticClient: true,
          agentRunTracking: "plugin_subagent",
          pluginRuntimeOwnerId: WORKBOARD_DISPATCH_OWNER_ID,
        },
      );
      if (!payload?.runId) {
        throw new Error("gateway agent method returned no runId");
      }
      return { runId: payload.runId };
    },
  });
}
