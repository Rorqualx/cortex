import { registerWorkboardCommand } from "./command.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
/**
 * Workboard module — core entry point.
 *
 * Replaces the plugin index.ts. Creates a WorkboardStore backed by SQLite,
 * registers all tools and gateway methods, and wires the dispatcher.
 */
import { WorkboardStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";
import { type WorkboardModuleConfig } from "./types.js";

export type { WorkboardCard, WorkboardBoard, WorkboardStatus, WorkboardPriority } from "./types.js";

export function createWorkboardModule(config: WorkboardModuleConfig = {}) {
  const { stateDir: customStateDir, registerTool, registerCommandHook } = config;

  // Create SQLite-backed store (reads its own workboard.db in state dir)
  const stores = createWorkboardSqliteStores();
  const store = new WorkboardStore(stores);

  // Build tool definitions
  const tools = createWorkboardTools(store);

  // Register with core tool registry
  if (registerTool) {
    for (const tool of tools) {
      registerTool(tool);
    }
  }

  // Register gateway RPC methods for UI<->store communication
  if (config.registerGatewayMethod) {
    registerWorkboardGatewayMethods(store, config.registerGatewayMethod);
  }

  // Register CLI command
  if (registerCommandHook) {
    registerWorkboardCommand(store, registerCommandHook);
  }

  return {
    store,
    tools,
  };
}

// Export tools for direct integration with tool registry
export { createWorkboardTools } from "./tools.js";
export { WorkboardStore } from "./store.js";
export { registerWorkboardGatewayMethods } from "./gateway.js";
