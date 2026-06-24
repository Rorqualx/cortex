// Activity feed gateway methods: paged history (`activity.list`) and live
// subscription (`activity.subscribe`/`unsubscribe`) for the cross-agent Control
// UI Activity view. History is read from the shared-state activity_events store
// the recorder writes to; live updates arrive via the `activity.event`
// broadcast gated behind subscription.
import {
  type ActivityListResult,
  validateActivityListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { queryActivityEvents } from "../../state/activity-events-store.js";
import { toProtocolActivityEvent } from "../server-activity-recorder.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const activityHandlers: GatewayRequestHandlers = {
  "activity.list": ({ params, respond }) => {
    if (!assertValidParams(params, validateActivityListParams, "activity.list", respond)) {
      return;
    }
    const page = queryActivityEvents({
      agentIds: params.agentIds,
      kinds: params.kinds,
      statuses: params.statuses,
      since: params.since,
      search: params.search,
      limit: params.limit,
      cursorTs: params.cursor?.ts,
      cursorId: params.cursor?.id,
    });
    const result: ActivityListResult = {
      events: page.events.map(toProtocolActivityEvent),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
    respond(true, result, undefined);
  },
  "activity.subscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.subscribeActivityEvents(connId);
    }
    respond(true, { subscribed: Boolean(connId) }, undefined);
  },
  "activity.unsubscribe": ({ client, context, respond }) => {
    const connId = client?.connId?.trim();
    if (connId) {
      context.unsubscribeActivityEvents(connId);
    }
    respond(true, { subscribed: false }, undefined);
  },
};
