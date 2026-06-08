/**
 * Workboard module — core entry point.
 *
 * Creates a WorkboardStore backed by the core DatabaseSync (gateway.db),
 * registers all tools and gateway methods, and wires the dispatcher.
 */
import type { DatabaseSync } from "node:sqlite";
import { registerWorkboardCommand } from "./command.js";
import { createWorkboardCoreDbStores } from "./core-db-store.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardTools } from "./tools.js";
import { type WorkboardModuleConfig } from "./types.js";

export type { WorkboardCard, WorkboardBoard, WorkboardStatus, WorkboardPriority } from "./types.js";

export interface CreateWorkboardModuleParams {
  db: DatabaseSync;
  registerTool?: (tool: unknown) => void;
  registerCommand?: (cmd: unknown) => void;
  registerGatewayMethod?: (
    method: string,
    handler: (params: Record<string, unknown>) => unknown,
  ) => void;
}

export function createWorkboardModule(params: CreateWorkboardModuleParams) {
  const { db, registerTool, registerCommand, registerGatewayMethod } = params;

  const stores = createWorkboardCoreDbStores(db);
  const store = new WorkboardStore(stores.cards, {
    boards: stores.boards,
    subscriptions: stores.subscriptions,
    attachments: stores.attachments,
  });

  const tools = createWorkboardTools(store);

  if (registerTool) {
    for (const tool of tools) {
      registerTool(tool);
    }
  }

  if (registerGatewayMethod) {
    registerWorkboardGatewayMethods(store, registerGatewayMethod);
  }

  if (registerCommand) {
    registerWorkboardCommand(store, registerCommand);
  }

  return { store, tools };
}

export { createWorkboardTools } from "./tools.js";
export { WorkboardStore } from "./store.js";
export { registerWorkboardGatewayMethods } from "./gateway.js";
