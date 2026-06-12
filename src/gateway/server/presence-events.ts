// Presence event helpers broadcast system presence snapshots with synchronized gateway state versions.
import type { PresenceEvent } from "../../../packages/gateway-protocol/src/index.js";
import { listSystemPresence } from "../../infra/system-presence.js";
import type { GatewayBroadcastFn } from "../server-broadcast-types.js";

/**
 * Presence snapshot broadcaster for gateway clients.
 */
export function broadcastPresenceSnapshot(params: {
  broadcast: GatewayBroadcastFn;
  incrementPresenceVersion: () => number;
  getHealthVersion: () => number;
}): number {
  const presenceVersion = params.incrementPresenceVersion();
  params.broadcast(
    "presence",
    // satisfies pins the emit payload to the wire-contract PresenceEventSchema so
    // server presence fields cannot drift from what gateway clients parse.
    { presence: listSystemPresence() } satisfies PresenceEvent,
    {
      dropIfSlow: true,
      stateVersion: {
        presence: presenceVersion,
        health: params.getHealthVersion(),
      },
    },
  );
  return presenceVersion;
}
