// Gateway event payload constants shared by server broadcasts and UI clients.
import type { UpdateAvailableEvent } from "../../packages/gateway-protocol/src/index.js";

/** Event name emitted when a newer OpenClaw version is available. */
export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

/**
 * Gateway event payload for update availability broadcasts. Derived from the
 * wire-contract UpdateAvailableEventSchema so emit and UI parse cannot drift.
 */
export type GatewayUpdateAvailableEventPayload = UpdateAvailableEvent;

/** Version metadata included in update-available gateway events. */
export type UpdateAvailableEventData = NonNullable<UpdateAvailableEvent["updateAvailable"]>;
