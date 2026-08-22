// Local structural result keeps this package independent of core session types.
export type SessionsPatchResult = {
  ok: true;
  path: string;
  key: string;
  entry: Record<string, unknown>;
  resolved?: {
    modelProvider?: string;
    model?: string;
    // Fork keeps GatewayAgentRuntime in session-row.ts (upstream relocated it to
    // agents-models-skills.ts); contextWindow(s) grafted from upstream #127951 so
    // this result stays a superset for any merged producer that populates them.
    agentRuntime?: import("./schema/session-row.js").GatewayAgentRuntime;
    contextWindow?: string;
    contextWindows?: Array<{ id: string; label: string; contextWindow: number }>;
    thinkingLevel?: string;
    thinkingLevels?: Array<{ id: string; label: string }>;
  };
};
