import {
  composeProtocolSchemaFragments,
  type ComposedProtocolSchemas,
} from "./protocol-schema-composer.js";
import { AgentControlProtocolSchemas } from "./protocol-schema-fragment-agent-control.js";
import { AgentSkillProtocolSchemas } from "./protocol-schema-fragment-agents-skills.js";
import { ApprovalProtocolSchemas } from "./protocol-schema-fragment-approvals.js";
import { BoardProtocolSchemas } from "./protocol-schema-fragment-board.js";
import { ChannelProtocolSchemas } from "./protocol-schema-fragment-channels.js";
import { ForkProtocolSchemas } from "./protocol-schema-fragment-fork.js";
import { IntegrationProtocolSchemas } from "./protocol-schema-fragment-integrations.js";
import { NodeProtocolSchemas } from "./protocol-schema-fragment-nodes.js";
import { OperationsProtocolSchemas } from "./protocol-schema-fragment-operations.js";
import { PluginLifecycleProtocolSchemas } from "./protocol-schema-fragment-plugins-lifecycle.js";
import { PortalProtocolSchemas } from "./protocol-schema-fragment-portals.js";
import { ProgressCardProtocolSchemas } from "./protocol-schema-fragment-progress-card.js";
import { SchedulerProtocolSchemas } from "./protocol-schema-fragment-scheduler.js";
import { SessionCollaborationProtocolSchemas } from "./protocol-schema-fragment-sessions-collaboration.js";
import { SessionCoreProtocolSchemas } from "./protocol-schema-fragment-sessions-core.js";
import { SessionLifecycleProtocolSchemas } from "./protocol-schema-fragment-sessions-lifecycle.js";
import { TransportProtocolSchemas } from "./protocol-schema-fragment-transport.js";

/** Ordered owner fragments; single source for both the registry value and its named type. */
type ProtocolSchemaFragmentList = readonly [
  typeof BoardProtocolSchemas,
  typeof ProgressCardProtocolSchemas,
  typeof TransportProtocolSchemas,
  typeof AgentControlProtocolSchemas,
  typeof NodeProtocolSchemas,
  typeof IntegrationProtocolSchemas,
  typeof SessionCoreProtocolSchemas,
  typeof SessionCollaborationProtocolSchemas,
  typeof SessionLifecycleProtocolSchemas,
  typeof OperationsProtocolSchemas,
  typeof ChannelProtocolSchemas,
  typeof AgentSkillProtocolSchemas,
  typeof SchedulerProtocolSchemas,
  typeof ApprovalProtocolSchemas,
  typeof PluginLifecycleProtocolSchemas,
  typeof ForkProtocolSchemas,
  typeof PortalProtocolSchemas,
];
const PROTOCOL_SCHEMA_FRAGMENTS: ProtocolSchemaFragmentList = [
  BoardProtocolSchemas,
  ProgressCardProtocolSchemas,
  TransportProtocolSchemas,
  AgentControlProtocolSchemas,
  NodeProtocolSchemas,
  IntegrationProtocolSchemas,
  SessionCoreProtocolSchemas,
  SessionCollaborationProtocolSchemas,
  SessionLifecycleProtocolSchemas,
  OperationsProtocolSchemas,
  ChannelProtocolSchemas,
  AgentSkillProtocolSchemas,
  SchedulerProtocolSchemas,
  ApprovalProtocolSchemas,
  PluginLifecycleProtocolSchemas,
  ForkProtocolSchemas,
  PortalProtocolSchemas,
];

/**
 * Public schema registry keyed by stable protocol schema name. Fork note: the
 * explicit annotations route dts serialization through named tuple/alias types —
 * inferred forms trip TS7056 now that the fork's fragment set plus upstream's
 * approval-scope schemas exceeds the serializer's size limit.
 */
export type ProtocolSchemasRegistry = ComposedProtocolSchemas<ProtocolSchemaFragmentList>;
export const ProtocolSchemas: ProtocolSchemasRegistry =
  composeProtocolSchemaFragments(PROTOCOL_SCHEMA_FRAGMENTS);

export {
  MIN_CLIENT_PROTOCOL_VERSION,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../version.js";
