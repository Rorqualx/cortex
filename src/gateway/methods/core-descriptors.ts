// Core gateway method descriptors keep handler names, auth scopes, startup availability, and write policy in one table.
import type { OperatorScope } from "../operator-scopes.js";
import { isSessionProfileDependentMethod } from "../session-sharing-target-input.js";
import {
  DYNAMIC_GATEWAY_METHOD_SCOPE,
  NODE_GATEWAY_METHOD_SCOPE,
  type GatewayMethodDescriptorInput,
  type GatewayMethodHandler,
  type GatewayMethodScope,
} from "./descriptor.js";

type CoreGatewayMethodSpec = {
  name: string;
  scope: GatewayMethodScope;
  since?: string;
  advertise?: false;
  startup?: true;
  controlPlaneWrite?: true;
};

type CoreGatewayMethodMetadata = Pick<CoreGatewayMethodSpec, "name" | "scope" | "since">;

// Profile-dependence classification grafted from upstream (resync 2026-08-20 dropped it
// with the table restructure): methods reading/mutating durable user/session ownership
// require an attached authenticated profile before dispatch (registry.requiresAuthenticatedProfile
// -> authorizeAuthenticatedProfileForMethod). Keep verbatim with upstream so fork-added
// methods classify by the same prefix rules.
const PROFILE_DEPENDENT_CORE_METHODS = new Set([
  "agent.wait",
  "ui.command",
  "users.linkEmail",
  "users.setAvatar",
  "users.setDisplayName",
]);
const PROFILE_DEPENDENT_CORE_PREFIXES = [
  "artifacts.",
  "chat.",
  "conversations.",
  "controlUi.session",
  "mcp.app.",
  "openclaw.approval.",
  "openclaw.chat",
  "progressCard.",
  "projects.",
  "secrets.",
  "session.",
  "sessions.",
  "taskSuggestions.",
  "tasks.",
  "terminal.",
  "users.prefs.",
] as const;

function isCoreGatewayMethodProfileDependent(method: string): boolean {
  return (
    isSessionProfileDependentMethod(method) ||
    PROFILE_DEPENDENT_CORE_METHODS.has(method) ||
    PROFILE_DEPENDENT_CORE_PREFIXES.some((prefix) => method.startsWith(prefix))
  );
}

// This is the canonical core method policy table: every core handler must appear here so
// listing, authorization, startup availability, and write throttling stay in sync.
const CORE_GATEWAY_METHOD_SPECS: readonly CoreGatewayMethodSpec[] = [
  { name: "health", scope: "operator.read", since: "<=2026.7" },
  { name: "diagnostics.stability", scope: "operator.read", since: "<=2026.7" },
  { name: "doctor.memory.status", scope: "operator.read", since: "<=2026.7" },
  { name: "doctor.memory.dreamDiary", scope: "operator.read", since: "<=2026.7" },
  { name: "doctor.memory.backfillDreamDiary", scope: "operator.write", since: "<=2026.7" },
  { name: "doctor.memory.resetDreamDiary", scope: "operator.write", since: "<=2026.7" },
  { name: "doctor.memory.resetGroundedShortTerm", scope: "operator.write", since: "<=2026.7" },
  { name: "doctor.memory.repairDreamingArtifacts", scope: "operator.write", since: "<=2026.7" },
  { name: "doctor.memory.dedupeDreamDiary", scope: "operator.write", since: "<=2026.7" },
  { name: "doctor.memory.remHarness", scope: "operator.read", since: "<=2026.7" },
  { name: "logs.tail", scope: "operator.read", since: "<=2026.7" },
  { name: "channels.status", scope: "operator.read", since: "<=2026.7" },
  { name: "channels.start", scope: "operator.admin", since: "<=2026.7" },
  { name: "channels.stop", scope: "operator.admin", since: "<=2026.7" },
  { name: "channels.logout", scope: "operator.admin", since: "<=2026.7" },
  { name: "status", scope: "operator.read", since: "<=2026.7" },
  { name: "usage.status", scope: "operator.read", since: "<=2026.7" },
  { name: "usage.cost", scope: "operator.read", since: "<=2026.7" },
  { name: "tts.status", scope: "operator.read", since: "<=2026.7" },
  { name: "tts.providers", scope: "operator.read", since: "<=2026.7" },
  { name: "tts.personas", scope: "operator.read", since: "<=2026.7" },
  { name: "tts.enable", scope: "operator.write", since: "<=2026.7" },
  { name: "tts.disable", scope: "operator.write", since: "<=2026.7" },
  { name: "tts.convert", scope: "operator.write", since: "<=2026.7" },
  { name: "tts.setProvider", scope: "operator.write", since: "<=2026.7" },
  { name: "tts.setPersona", scope: "operator.write", since: "<=2026.7" },
  { name: "config.get", scope: "operator.read", since: "<=2026.7" },
  { name: "config.set", scope: "operator.admin", since: "<=2026.7" },
  { name: "config.apply", scope: "operator.admin", since: "<=2026.7", controlPlaneWrite: true },
  { name: "config.patch", scope: "operator.admin", since: "<=2026.7", controlPlaneWrite: true },
  { name: "config.schema", scope: "operator.read", since: "<=2026.7" },
  { name: "config.schema.lookup", scope: "operator.read", since: "<=2026.7" },
  { name: "exec.approvals.get", scope: "operator.admin", since: "<=2026.7" },
  { name: "exec.approvals.set", scope: "operator.admin", since: "<=2026.7" },
  { name: "exec.approvals.node.get", scope: "operator.admin", since: "<=2026.7" },
  { name: "exec.approvals.node.set", scope: "operator.admin", since: "<=2026.7" },
  { name: "exec.approval.get", scope: "operator.approvals", since: "<=2026.7" },
  { name: "exec.approval.list", scope: "operator.approvals", since: "<=2026.7" },
  { name: "exec.approval.request", scope: "operator.approvals", since: "<=2026.7" },
  { name: "exec.approval.waitDecision", scope: "operator.approvals", since: "<=2026.7" },
  { name: "exec.approval.resolve", scope: "operator.approvals", since: "<=2026.7" },
  { name: "question.request", scope: "operator.questions", since: "2026.7" },
  { name: "question.waitAnswer", scope: "operator.questions", since: "2026.7" },
  { name: "question.resolve", scope: "operator.questions", since: "2026.7" },
  { name: "question.get", scope: "operator.questions", since: "2026.7" },
  { name: "question.list", scope: "operator.questions", since: "2026.7" },
  { name: "plugin.approval.list", scope: "operator.approvals", since: "<=2026.7" },
  { name: "plugin.approval.request", scope: "operator.approvals", since: "<=2026.7" },
  { name: "plugin.approval.waitDecision", scope: "operator.approvals", since: "<=2026.7" },
  { name: "plugin.approval.resolve", scope: "operator.approvals", since: "<=2026.7" },
  { name: "plugins.uiDescriptors", scope: "operator.read", since: "<=2026.7" },
  { name: "plugins.sessionAction", scope: "dynamic", since: "<=2026.7" },
  { name: "openclaw.chat", scope: "operator.admin", since: "<=2026.7" },
  { name: "openclaw.chat.history", scope: "operator.admin", since: "2026.7" },
  { name: "openclaw.changes.list", scope: "operator.admin", since: "<=2026.7" },
  { name: "openclaw.approval.list", scope: "operator.approvals", since: "<=2026.7" },
  { name: "openclaw.setup.detect", scope: "operator.admin", since: "<=2026.7" },
  // Failed activation candidates are non-mutating probes. Keep this admin-only
  // without the shared three-write budget so the automatic ladder can finish.
  { name: "openclaw.setup.activate", scope: "operator.admin", since: "<=2026.7" },
  { name: "openclaw.setup.auth.start", scope: "operator.admin", since: "<=2026.7" },
  { name: "openclaw.setup.prepare.start", scope: "operator.admin", since: "<=2026.7" },
  { name: "wizard.start", scope: "operator.admin", since: "<=2026.7" },
  { name: "wizard.next", scope: "operator.admin", since: "<=2026.7" },
  { name: "wizard.cancel", scope: "operator.admin", since: "<=2026.7" },
  { name: "wizard.status", scope: "operator.admin", since: "<=2026.7" },
  { name: "talk.catalog", scope: "operator.read", since: "<=2026.7" },
  // Params-aware: reading redacted config needs read; includeSecrets also needs talk secrets.
  { name: "talk.config", scope: "dynamic", since: "<=2026.7" },
  { name: "talk.client.create", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.client.transcript", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.client.close", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.client.toolCall", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.client.steer", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.create", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.join", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.appendAudio", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.startTurn", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.endTurn", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.cancelTurn", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.cancelOutput", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.acknowledgeMark", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.submitToolResult", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.steer", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.session.close", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.speak", scope: "operator.talk", since: "<=2026.7" },
  { name: "talk.mode", scope: "operator.talk", since: "<=2026.7" },
  { name: "commands.list", scope: "operator.read", since: "<=2026.7" },
  { name: "models.list", scope: "operator.read", since: "<=2026.7", startup: true },
  { name: "models.authStatus", scope: "operator.read", since: "<=2026.7" },
  {
    name: "models.authLogout",
    scope: "operator.admin",
    since: "<=2026.7",
    controlPlaneWrite: true,
  },
  { name: "tools.catalog", scope: "operator.read", since: "<=2026.7" },
  { name: "tools.effective", scope: "operator.read", since: "<=2026.7", startup: true },
  { name: "tools.invoke", scope: "operator.write", since: "<=2026.7" },
  { name: "mcp.app.view", scope: "operator.read", since: "<=2026.7" },
  { name: "mcp.app.listTools", scope: "operator.read", since: "<=2026.7" },
  { name: "mcp.app.listResources", scope: "operator.read", since: "<=2026.7" },
  { name: "mcp.app.listResourceTemplates", scope: "operator.read", since: "<=2026.7" },
  { name: "mcp.app.readResource", scope: "operator.read", since: "<=2026.7" },
  { name: "mcp.app.callTool", scope: "operator.write", since: "<=2026.7" },
  { name: "mcp.app.updateModelContext", scope: "operator.write", since: "<=2026.7" },
  { name: "board.get", scope: "operator.read", since: "<=2026.7" },
  { name: "board.update", scope: "operator.write", since: "<=2026.7" },
  { name: "board.widget.put", scope: "operator.write", since: "<=2026.7" },
  { name: "board.widget.grant", scope: "operator.approvals", since: "<=2026.7" },
  { name: "board.widget.appView", scope: "operator.read", since: "2026.7" },
  { name: "board.event", scope: "operator.write", since: "<=2026.7" },
  { name: "audit.list", scope: "operator.read", since: "2026.7" },
  { name: "audit.activity.list", scope: "operator.read", since: "2026.7" },
  { name: "users.list", scope: "operator.read", since: "<=2026.7" },
  { name: "users.self", scope: "operator.write", since: "<=2026.7" },
  { name: "users.linkEmail", scope: "operator.admin", since: "<=2026.7" },
  { name: "users.setDisplayName", scope: "operator.write", since: "<=2026.7" },
  { name: "users.setAvatar", scope: "operator.write", since: "<=2026.7" },
  { name: "tasks.list", scope: "operator.read", since: "<=2026.7" },
  { name: "tasks.get", scope: "operator.read", since: "<=2026.7" },
  { name: "tasks.cancel", scope: "operator.write", since: "<=2026.7" },
  { name: "taskSuggestions.list", scope: "operator.read", since: "<=2026.7" },
  { name: "taskSuggestions.create", scope: "operator.write", since: "<=2026.7" },
  { name: "taskSuggestions.accept", scope: "operator.admin", since: "<=2026.7" },
  { name: "taskSuggestions.dismiss", scope: "operator.write", since: "<=2026.7" },
  { name: "environments.list", scope: "operator.read", since: "2026.7" },
  { name: "environments.status", scope: "operator.read", since: "2026.7" },
  { name: "worktrees.list", scope: "operator.read", since: "2026.7" },
  // Read-only git probe, but it accepts arbitrary host paths; keep it at the
  // same bar as starting worktree sessions instead of plain read scope.
  { name: "worktrees.branches", scope: "operator.write", since: "2026.7" },
  // Params-aware: Gateway-local directory listing stays write-scoped, but a nodeId
  // targets an arbitrary paired host and raises the bar to admin. Policy lives in
  // method-scopes.ts (resolveDynamicLeastPrivilegeOperatorScopesForMethod).
  { name: "fs.listDir", scope: "dynamic", since: "<=2026.7" },
  { name: "worktrees.create", scope: "operator.write", since: "2026.7", controlPlaneWrite: true },
  { name: "worktrees.remove", scope: "operator.admin", since: "2026.7", controlPlaneWrite: true },
  { name: "worktrees.restore", scope: "operator.admin", since: "2026.7", controlPlaneWrite: true },
  { name: "worktrees.gc", scope: "operator.admin", since: "2026.7", controlPlaneWrite: true },
  { name: "agents.list", scope: "operator.read", since: "<=2026.7" },
  { name: "agents.create", scope: "operator.admin", since: "<=2026.7" },
  { name: "agents.update", scope: "operator.admin", since: "<=2026.7" },
  { name: "agents.delete", scope: "operator.admin", since: "<=2026.7" },
  { name: "agents.files.list", scope: "operator.read", since: "<=2026.7" },
  { name: "agents.files.get", scope: "operator.read", since: "<=2026.7" },
  { name: "agents.files.set", scope: "operator.admin", since: "<=2026.7" },
  { name: "sessions.files.list", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.files.get", scope: "operator.read", since: "<=2026.7" },
  // Workspace file writes require the same admin scope as agents.files.set.
  { name: "sessions.files.set", scope: "operator.admin", since: "<=2026.7" },
  { name: "sessions.files.reveal", scope: "operator.admin", since: "<=2026.7" },
  { name: "artifacts.list", scope: "operator.read", since: "<=2026.7" },
  { name: "artifacts.get", scope: "operator.read", since: "<=2026.7" },
  { name: "artifacts.download", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.status", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.search", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.detail", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.securityVerdicts", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.skillCard", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.bins", scope: "node", since: "<=2026.7" },
  { name: "skills.upload.begin", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.upload.chunk", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.upload.commit", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.install", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.update", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.curator.status", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.curator.pin", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.curator.unpin", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.curator.restore", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.proposals.list", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.proposals.inspect", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.proposals.historyStatus", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.proposals.historyScan", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.proposals.create", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.proposals.update", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.proposals.revise", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.proposals.requestRevision", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.proposals.apply", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.proposals.reject", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.proposals.quarantine", scope: "operator.admin", since: "<=2026.7" },
  { name: "update.status", scope: "operator.admin", since: "<=2026.7" },
  { name: "update.run", scope: "operator.admin", controlPlaneWrite: true, since: "<=2026.7" },
  { name: "voicewake.get", scope: "operator.read", since: "<=2026.7" },
  { name: "voicewake.set", scope: "operator.write", since: "<=2026.7" },
  { name: "secrets.reload", scope: "operator.admin", since: "<=2026.7" },
  { name: "secrets.resolve", scope: "operator.admin", since: "<=2026.7" },
  { name: "voicewake.routing.get", scope: "operator.read", since: "<=2026.7" },
  { name: "voicewake.routing.set", scope: "operator.write", since: "<=2026.7" },
  { name: "sessions.list", scope: "operator.read", startup: true, since: "<=2026.7" },
  { name: "sessions.subscribe", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.unsubscribe", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.messages.subscribe", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.messages.unsubscribe", scope: "operator.read", since: "<=2026.7" },
  {
    name: "sessions.viewers.set",
    scope: "operator.read",
    since: "2026.7",
  },
  { name: "sessions.preview", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.describe", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.compaction.list", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.compaction.get", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.compaction.branch", scope: "operator.write", since: "<=2026.7" },
  { name: "sessions.compaction.restore", scope: "operator.admin", since: "<=2026.7" },
  { name: "sessions.branches.list", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.branches.switch", scope: "operator.admin", since: "<=2026.7" },
  { name: "sessions.rewind", scope: "operator.admin", since: "<=2026.7" },
  { name: "sessions.fork", scope: "operator.write", since: "<=2026.7" },
  // Params-aware: explicit cwd can point at any host checkout and requires admin.
  { name: "sessions.create", scope: "dynamic", since: "<=2026.7", startup: true },
  { name: "sessions.send", scope: "operator.write", since: "<=2026.7", startup: true },
  { name: "sessions.abort", scope: "operator.write", since: "<=2026.7", startup: true },
  // Params-aware: write scope may mutate chat-organization fields
  // (label/category/icon/pinned/archived/unread); every other patch field stays
  // admin-only. Policy lives in method-scopes.ts.
  { name: "sessions.patch", scope: "dynamic", since: "<=2026.7" },
  { name: "sessions.pluginPatch", scope: "operator.admin", since: "<=2026.7" },
  { name: "sessions.cleanup", scope: "operator.admin", since: "<=2026.7" },
  { name: "sessions.reset", scope: "operator.admin", since: "<=2026.7" },
  // State-aware: write scope may delete already-archived sessions
  // (archive-then-delete); the handler enforces the archived requirement and
  // admin keeps unrestricted delete. Policy in method-scopes.ts + handler.
  { name: "sessions.delete", scope: "dynamic", since: "<=2026.7" },
  { name: "sessions.compact", scope: "operator.admin", since: "<=2026.7" },
  { name: "sessions.groups.list", scope: "operator.read", since: "<=2026.7" },
  { name: "sessions.groups.defaults", scope: "operator.write", since: "2026.8" },
  { name: "sessions.groups.put", scope: "operator.write", since: "<=2026.7" },
  { name: "sessions.groups.rename", scope: "operator.write", since: "<=2026.7" },
  { name: "sessions.groups.update", scope: "operator.write", since: "2026.8" },
  { name: "sessions.groups.delete", scope: "operator.write", since: "<=2026.7" },
  { name: "last-heartbeat", scope: "operator.read", since: "<=2026.7" },
  { name: "set-heartbeats", scope: "operator.admin", since: "<=2026.7" },
  { name: "wake", scope: "operator.write", since: "<=2026.7" },
  { name: "node.pair.list", scope: "operator.pairing", since: "<=2026.7" },
  { name: "node.pair.approve", scope: "operator.pairing", since: "<=2026.7" },
  { name: "node.pair.reject", scope: "operator.pairing", since: "<=2026.7" },
  { name: "node.pair.remove", scope: "operator.pairing", since: "<=2026.7" },
  { name: "device.pair.list", scope: "operator.pairing", since: "<=2026.7" },
  { name: "device.pair.approve", scope: "operator.pairing", since: "<=2026.7" },
  { name: "device.pair.reject", scope: "operator.pairing", since: "<=2026.7" },
  { name: "device.pair.remove", scope: "operator.pairing", since: "<=2026.7" },
  { name: "device.pair.rename", scope: "operator.pairing", since: "2026.7" },
  { name: "device.token.rotate", scope: "operator.pairing", since: "<=2026.7" },
  { name: "device.token.revoke", scope: "operator.pairing", since: "<=2026.7" },
  { name: "device.pair.setupCode", scope: "operator.admin", since: "<=2026.7", advertise: false },
  { name: "node.rename", scope: "operator.pairing", since: "<=2026.7" },
  { name: "node.list", scope: "operator.read", since: "<=2026.7" },
  { name: "node.describe", scope: "operator.read", since: "<=2026.7" },
  { name: "node.pluginSurface.refresh", scope: "node", since: "<=2026.7" },
  { name: "node.pluginTools.update", scope: "node", since: "<=2026.7" },
  { name: "node.skills.update", scope: "node", since: "<=2026.7" },
  // Hidden node protocol feature publication; advertise:false keeps it out of the
  // client method list while still classifying the handler in nodes.read.ts.
  { name: "node.runnerInventory.update", scope: "node", since: "2026.8", advertise: false },
  { name: "node.pending.drain", scope: "node", since: "<=2026.7" },
  { name: "node.pending.enqueue", scope: "operator.write", since: "<=2026.7" },
  // Params-aware: host-sensitive commands raise direct invocation from write to admin.
  { name: "node.invoke", scope: "dynamic", since: "<=2026.7" },
  { name: "node.pending.pull", scope: "node", since: "<=2026.7" },
  { name: "node.pending.ack", scope: "node", since: "<=2026.7" },
  { name: "node.invoke.progress", scope: "node", since: "<=2026.7" },
  { name: "node.invoke.result", scope: "node", since: "<=2026.7" },
  { name: "node.event", scope: "node", since: "<=2026.7" },
  { name: "cron.get", scope: "operator.read", since: "<=2026.7" },
  { name: "cron.list", scope: "operator.read", since: "<=2026.7" },
  { name: "cron.status", scope: "operator.read", since: "<=2026.7" },
  { name: "cron.scratch.get", scope: "operator.admin", since: "2026.7" },
  { name: "cron.scratch.set", scope: "operator.admin", since: "2026.7" },
  { name: "cron.add", scope: "operator.admin", since: "<=2026.7" },
  { name: "cron.update", scope: "operator.admin", since: "<=2026.7" },
  { name: "cron.remove", scope: "operator.admin", since: "<=2026.7" },
  { name: "cron.run", scope: "operator.admin", since: "<=2026.7" },
  { name: "cron.runs", scope: "operator.read", since: "<=2026.7" },
  { name: "gateway.identity.get", scope: "operator.read", since: "<=2026.7" },
  { name: "gateway.restart.preflight", scope: "operator.read", since: "<=2026.7" },
  {
    name: "gateway.restart.request",
    scope: "operator.admin",
    since: "<=2026.7",
    controlPlaneWrite: true,
  },
  { name: "system-presence", scope: "operator.read", since: "<=2026.7" },
  { name: "system-event", scope: "operator.admin", since: "<=2026.7" },
  { name: "message.action", scope: "operator.write", since: "<=2026.7" },
  { name: "conversations.send", scope: "operator.admin", since: "<=2026.7" },
  { name: "conversations.turn", scope: "operator.admin", since: "<=2026.7" },
  { name: "conversations.turn.cancel", scope: "operator.admin", since: "<=2026.7" },
  { name: "send", scope: "operator.write", since: "<=2026.7" },
  // Params-aware: ordinary turns need write; /new and /reset mutate lifecycle state as admin.
  { name: "agent", scope: "dynamic", since: "<=2026.7", startup: true },
  { name: "agent.identity.get", scope: "operator.read", since: "<=2026.7" },
  { name: "agent.wait", scope: "operator.write", since: "<=2026.7", startup: true },
  { name: "chat.history", scope: "operator.read", since: "<=2026.7", startup: true },
  { name: "chat.startup", scope: "operator.read", since: "<=2026.7", startup: true },
  { name: "chat.metadata", scope: "operator.read", since: "<=2026.7", startup: true },
  { name: "chat.message.get", scope: "operator.read", since: "<=2026.7", startup: true },
  { name: "chat.abort", scope: "operator.write", since: "<=2026.7" },
  { name: "chat.send", scope: "operator.write", since: "<=2026.7", startup: true },
  // Operator terminal: admin-only PTY surface. Appended to the advertised block
  // so existing advertised method indices stay stable for older clients.
  { name: "terminal.open", scope: "operator.admin", since: "2026.7" },
  { name: "terminal.input", scope: "operator.admin", since: "2026.7" },
  { name: "terminal.resize", scope: "operator.admin", since: "2026.7" },
  { name: "terminal.close", scope: "operator.admin", since: "2026.7" },
  // DM pairing is additive to the advertised method list. Keep it appended so
  // older clients retain every pre-existing advertised method index.
  { name: "channels.pairing.list", scope: "operator.pairing", since: "2026.7" },
  { name: "channels.pairing.approve", scope: "dynamic", since: "2026.7" },
  { name: "channels.pairing.dismiss", scope: "operator.pairing", since: "2026.7" },
  { name: "assistant.media.get", scope: "operator.read", since: "<=2026.7", advertise: false },
  { name: "sessions.get", scope: "operator.read", since: "<=2026.7", advertise: false },
  { name: "sessions.resolve", scope: "operator.read", since: "<=2026.7", advertise: false },
  { name: "sessions.usage", scope: "operator.read", since: "<=2026.7", advertise: false },
  {
    name: "sessions.usage.timeseries",
    scope: "operator.read",
    since: "<=2026.7",
    advertise: false,
  },
  { name: "sessions.usage.logs", scope: "operator.read", since: "<=2026.7", advertise: false },
  { name: "poll", scope: "operator.write", since: "<=2026.7", advertise: false },
  { name: "sessions.steer", scope: "operator.write", since: "<=2026.7", advertise: false },
  { name: "push.test", scope: "operator.write", since: "<=2026.7", advertise: false },
  { name: "attach.grant", scope: "operator.admin", since: "<=2026.7", controlPlaneWrite: true },
  { name: "attach.revoke", scope: "operator.admin", since: "<=2026.7" },
  { name: "push.web.vapidPublicKey", scope: "operator.write", since: "<=2026.7", advertise: false },
  { name: "push.web.subscribe", scope: "operator.write", since: "<=2026.7", advertise: false },
  { name: "push.web.unsubscribe", scope: "operator.write", since: "<=2026.7", advertise: false },
  { name: "push.web.test", scope: "operator.write", since: "<=2026.7", advertise: false },
  { name: "config.openFile", scope: "operator.admin", since: "<=2026.7", advertise: false },
  { name: "connect", scope: "operator.admin", since: "<=2026.7", advertise: false },
  { name: "chat.inject", scope: "operator.admin", since: "<=2026.7", advertise: false },
  { name: "nativeHook.invoke", scope: "operator.admin", since: "<=2026.7", advertise: false },
  { name: "web.login.start", scope: "operator.admin", since: "<=2026.7", advertise: false },
  { name: "web.login.wait", scope: "operator.admin", since: "<=2026.7", advertise: false },
  // Terminal detach/reattach surface. Kept together near the end so previously
  // advertised method indices stay stable for older clients; new methods append.
  { name: "terminal.attach", scope: "operator.admin", since: "2026.7" },
  { name: "terminal.list", scope: "operator.admin", since: "2026.7" },
  { name: "terminal.text", scope: "operator.admin", since: "2026.7" },
  { name: "controlUi.githubPreview", scope: "operator.read", since: "<=2026.7" },
  // Additive discovery methods append here so older clients keep stable indices.
  { name: "system.info", scope: "operator.read", since: "<=2026.7" },
  // Workspace contents stay in the documented trusted operator domain, like session and log
  // reads. Strong user/tenant isolation requires separate Gateways; see operator-scopes.md.
  { name: "agents.workspace.list", scope: "operator.read", since: "2026.7" },
  { name: "agents.workspace.get", scope: "operator.read", since: "2026.7" },
  { name: "tts.speak", scope: "operator.write", since: "2026.7" },
  { name: "plugins.list", scope: "operator.read", since: "<=2026.7" },
  { name: "plugins.search", scope: "operator.read", since: "<=2026.7" },
  { name: "plugins.install", scope: "operator.admin", since: "<=2026.7", controlPlaneWrite: true },
  {
    name: "plugins.setEnabled",
    scope: "operator.admin",
    since: "<=2026.7",
    controlPlaneWrite: true,
  },
  {
    name: "plugins.uninstall",
    scope: "operator.admin",
    since: "<=2026.7",
    controlPlaneWrite: true,
  },
  { name: "plugins.refresh", scope: "operator.admin", since: "<=2026.7", controlPlaneWrite: true },
  // Session PR chips read the session's own checkout metadata, matching the
  // sessions.files.* trusted-operator read domain.
  {
    name: "controlUi.sessionPullRequests.subscribe",
    scope: "operator.read",
    since: "2026.7",
  },
  {
    name: "gateway.suspend.prepare",
    scope: "operator.admin",
    since: "2026.7",
    startup: true,
    controlPlaneWrite: true,
  },
  { name: "gateway.suspend.status", scope: "operator.read", since: "2026.7" },
  // Resume is the safety escape hatch and must not sit behind write-rate limiting.
  { name: "gateway.suspend.resume", scope: "operator.admin", since: "2026.7" },
  // Spends utility-model tokens on cache misses when the opt-in is enabled, so
  // it needs write scope despite being a read-shaped lookup.
  { name: "chat.toolTitles", scope: "operator.write", since: "<=2026.7" },
  // Session checkout diff reads the session's own git worktree, matching the
  // sessions.files.* trusted-operator read domain.
  { name: "sessions.diff", scope: "operator.read", since: "<=2026.7" },
  // Additive protocol methods append here to preserve existing advertised indices.
  { name: "openclaw.setup.verify", scope: "operator.admin", since: "<=2026.7" },
  // Cloud-worker mutations depend on the loaded provider registry and owned
  // reconciler, so advertise them early but gate dispatch until sidecars are ready.
  {
    name: "environments.create",
    scope: "operator.admin",
    since: "2026.7",
    startup: true,
    controlPlaneWrite: true,
  },
  {
    name: "environments.destroy",
    scope: "operator.admin",
    since: "2026.7",
    startup: true,
    controlPlaneWrite: true,
  },
  { name: "sessions.catalog.list", scope: "operator.read", since: "2026.7" },
  { name: "sessions.catalog.read", scope: "operator.read", since: "2026.7" },
  { name: "terminal.upload", scope: "operator.admin", since: "2026.7" },
  { name: "sessions.catalog.continue", scope: "operator.write", since: "2026.7" },
  { name: "sessions.catalog.archive", scope: "operator.write", since: "2026.7" },
  { name: "approval.get", scope: "operator.approvals", since: "2026.7" },
  { name: "approval.resolve", scope: "operator.approvals", since: "2026.7" },
  { name: "sessions.search", scope: "operator.read", since: "<=2026.7" },
  // Target-aware placement scope: the handler resolves the operator scope from the
  // dispatch target (shared/session-method-scopes.ts), so this stays dynamic.
  {
    name: "sessions.dispatch",
    scope: "dynamic",
    since: "2026.7",
    startup: true,
    controlPlaneWrite: true,
  },
  {
    name: "sessions.reclaim",
    scope: "operator.write",
    since: "2026.7",
    startup: true,
    controlPlaneWrite: true,
  },
  { name: "models.probe", scope: "operator.admin", since: "<=2026.7" },
  // Memory migration reads host assistant state and writes agent workspaces.
  { name: "migrations.memory.plan", scope: "operator.admin", since: "2026.7" },
  {
    name: "migrations.memory.apply",
    scope: "operator.admin",
    since: "2026.7",
    controlPlaneWrite: true,
  },
  { name: "ui.command", scope: "operator.write", since: "2026.7" },
  { name: "approval.history", scope: "operator.approvals", since: "2026.7" },
  { name: "plugin.surface.refresh", scope: "operator.read", since: "<=2026.7" },
  { name: "conversations.list", scope: "operator.admin", since: "<=2026.7" },
  { name: "session.discussion.info", scope: "operator.read", since: "2026.7" },
  { name: "session.discussion.open", scope: "operator.write", since: "2026.7" },
  { name: "board.prompt.authorize", scope: "operator.read", since: "2026.7" },
  { name: "board.data.read", scope: "operator.read", since: "2026.7" },
  { name: "board.action", scope: "operator.write", since: "2026.7" },
  { name: "sessions.observer.visibility", scope: "operator.read", since: "2026.7" },
  // Additive phase-2 collaboration methods append so older advertised indices stay stable.
  { name: "session.visibility.set", scope: "operator.write", since: "2026.7" },
  { name: "session.members.list", scope: "operator.read", since: "2026.7" },
  { name: "session.members.add", scope: "operator.write", since: "2026.7" },
  { name: "session.members.remove", scope: "operator.write", since: "2026.7" },
  { name: "session.suggestions.add", scope: "operator.write", since: "2026.7" },
  { name: "session.suggestions.list", scope: "operator.read", since: "2026.7" },
  { name: "session.suggestions.resolve", scope: "operator.write", since: "2026.7" },
  { name: "session.typing", scope: "operator.write", since: "2026.7" },
  // Companion state is process-local and its runner is hard-restricted to
  // read-only workspace and exact-session tools.
  { name: "sessions.companion.ask", scope: "operator.read", since: "2026.7" },
  { name: "sessions.companion.state", scope: "operator.read", since: "2026.7" },
  {
    name: "sessions.companion.reset",
    scope: "operator.write",
    since: "2026.7",
    controlPlaneWrite: true,
  },
  { name: "memory.search", scope: "operator.read", since: "2026.7" },
  // Fork handler groups whose descriptors AND lazy registrations were dropped by
  // the 2026-07 resync: the modules survived and type-checked, so every lane
  // stayed green while the dispatcher answered "unknown method" at runtime.
  // Appended rather than restored to their old slots so no existing advertised
  // index shifts (see the legacy-order guard in server-methods-list.test.ts).
  // Scopes are the pre-resync values, verified against 07315d7a613.
  { name: "activity.list", scope: "operator.read", since: "<=2026.7" },
  { name: "activity.subscribe", scope: "operator.read", since: "<=2026.7" },
  { name: "activity.unsubscribe", scope: "operator.read", since: "<=2026.7" },
  { name: "vault.list", scope: "operator.read", since: "<=2026.7" },
  { name: "vault.save", scope: "operator.admin", since: "<=2026.7" },
  { name: "vault.delete", scope: "operator.admin", since: "<=2026.7" },
  { name: "chat.branch", scope: "operator.write", since: "<=2026.7", startup: true },
  { name: "chat.branches", scope: "operator.read", since: "<=2026.7", startup: true },
  { name: "doctor.memory.l3Layers", scope: "operator.read", since: "<=2026.7" },
  // Workboard lost only its descriptors, not its registrations, so the four groups
  // above (found by diffing registrations) did not surface it: the handlers stayed
  // registered and fell through to the aux bucket's ADMIN_SCOPE default. That breaks
  // both ends at once — the server starts demanding operator.admin for reads, and
  // resolveLeastPrivilegeOperatorScopesForMethod default-denies unclassified methods,
  // so agent/cron callers present no scope at all. Restoring the specs fixes both.
  { name: "workboard.cards.list", scope: "operator.read", since: "<=2026.7" },
  { name: "workboard.cards.read", scope: "operator.read", since: "<=2026.7" },
  { name: "workboard.cards.stats", scope: "operator.read", since: "<=2026.7" },
  { name: "workboard.cards.runs", scope: "operator.read", since: "<=2026.7" },
  { name: "workboard.cards.create", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.update", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.move", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.delete", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.specify", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.decompose", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.claim", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.release", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.heartbeat", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.complete", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.block", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.unblock", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.promote", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.reassign", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.reclaim", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.cards.dispatch", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.boards.list", scope: "operator.read", since: "<=2026.7" },
  { name: "workboard.boards.create", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.boards.archive", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.boards.delete", scope: "operator.write", since: "<=2026.7" },
  // research.* never had specs (the fork shipped 24 against 26 registered methods),
  // so these were admin-defaulted from the day the Improvement Lab pipeline landed.
  { name: "workboard.research.reports", scope: "operator.read", since: "<=2026.7" },
  { name: "workboard.research.sync", scope: "operator.write", since: "<=2026.7" },
  { name: "workboard.research.stage", scope: "operator.write", since: "<=2026.7" },
  // Additive upstream 2026.7 proposal methods. Upstream moved these two out of the
  // skills block to the tail so older advertised indices stay stable; the fork
  // matches that ordering here (handlers stay wired via SKILLS_GATEWAY_METHOD_NAMES).
  { name: "skills.proposals.events.list", scope: "operator.read", since: "2026.7" },
  {
    name: "skills.proposals.evaluate",
    scope: "operator.admin",
    controlPlaneWrite: true,
    since: "2026.7",
  },
  // Upstream 2026.7 handlers (server-methods/{hooks-status,tasks}.ts). This file is
  // merge=ours, so their upstream descriptors were dropped by the nightly merge while
  // the handlers came in — and an unclassified handler makes
  // createCoreGatewayMethodDescriptors throw at startup. Appended last so older
  // advertised method indices stay stable.
  { name: "hooks.status", scope: "operator.read", since: "2026.7" },
  { name: "tasks.retry", scope: "operator.write", since: "2026.7" },
  { name: "tasks.dismiss", scope: "operator.write", since: "2026.7" },
  // Upstream #118232 methods (2026.7/2026.8) whose upstream descriptors were dropped
  // by the merge=ours resync while their handlers came in. Grafted into the fork's
  // object-literal table in upstream's registration order so advertised indices stay
  // stable and the dispatcher stops answering "unknown method". Scopes/flags mirror
  // upstream/main:src/gateway/methods/core-descriptors.ts.
  { name: "audit.run.inspect", scope: "operator.read", since: "2026.7" },
  { name: "sessions.patchMany", scope: "dynamic", since: "2026.8" },
  { name: "update.hold", scope: "operator.admin", since: "2026.8", controlPlaneWrite: true },
  { name: "sessions.catalog.startTerminal", scope: "operator.admin", since: "2026.8" },
  { name: "worker.desktop.observe", scope: "operator.admin", since: "2026.8", startup: true },
  { name: "projects.list", scope: "operator.read", since: "2026.8" },
  { name: "projects.register", scope: "operator.admin", since: "2026.8" },
  { name: "projects.remove", scope: "operator.admin", since: "2026.8" },
  { name: "worker.desktop.launch", scope: "operator.admin", since: "2026.8", startup: true },
  // Store CRUD is served by the auxiliary secrets surface (server-aux-methods.ts),
  // so these carry descriptors only; their handlers are injected at server construction.
  { name: "secrets.store.list", scope: "operator.admin", since: "2026.8" },
  { name: "secrets.store.set", scope: "operator.admin", since: "2026.8", controlPlaneWrite: true },
  {
    name: "secrets.store.delete",
    scope: "operator.admin",
    since: "2026.8",
    controlPlaneWrite: true,
  },
  { name: "users.prefs.get", scope: "operator.read", since: "2026.8" },
  { name: "users.prefs.set", scope: "operator.write", since: "2026.8" },
  { name: "projects.add", scope: "operator.write", since: "2026.8", controlPlaneWrite: true },
  { name: "projects.searchRemote", scope: "operator.read", since: "2026.8" },
  { name: "desktop.observe", scope: "operator.admin", since: "2026.8", startup: true },
  { name: "desktop.launch", scope: "operator.admin", since: "2026.8", startup: true },
  { name: "device.scopes.requestUpgrade", scope: "operator.read", since: "2026.8" },
  { name: "device.scopes.waitUpgrade", scope: "operator.read", since: "2026.8" },
  { name: "portal.list", scope: "operator.read", since: "2026.8" },
  { name: "portal.open", scope: "operator.write", since: "2026.8", controlPlaneWrite: true },
  { name: "portal.close", scope: "operator.write", since: "2026.8", controlPlaneWrite: true },
  // Target-aware placement scope resolved from the move target, like sessions.dispatch.
  {
    name: "sessions.move",
    scope: "dynamic",
    since: "2026.8",
    startup: true,
    controlPlaneWrite: true,
  },
  { name: "sessions.assignOwner", scope: "operator.write", since: "2026.8" },
  { name: "progressCard.get", scope: "operator.read", since: "2026.8" },
  { name: "progressCard.put", scope: "operator.write", since: "2026.8" },
  { name: "tools.github.status", scope: "operator.read", since: "2026.8" },
  {
    name: "tools.github.configure",
    scope: "operator.admin",
    since: "2026.8",
    controlPlaneWrite: true,
  },
  {
    name: "tools.github.authorize.start",
    scope: "operator.admin",
    since: "2026.8",
    controlPlaneWrite: true,
  },
  {
    name: "tools.github.authorize.poll",
    scope: "operator.admin",
    since: "2026.8",
    controlPlaneWrite: true,
  },
  {
    name: "tools.github.authorize.cancel",
    scope: "operator.admin",
    since: "2026.8",
    controlPlaneWrite: true,
  },
  {
    name: "sessions.github.publish",
    scope: "operator.write",
    since: "2026.8",
    controlPlaneWrite: true,
  },
  { name: "diagnostics.lanes", scope: "operator.read", since: "2026.8" },
  // Fork SkillForge control surface. Handlers live in server-methods/skills.ts and
  // wire through SKILLS_GATEWAY_METHOD_NAMES; their descriptors were absent from this
  // table so listing/authorization never classified them. Appended at the tail so no
  // existing advertised method index shifts. status/telemetry are read-only probes;
  // run/promote/retire mutate the forge and require admin.
  { name: "skills.forge.status", scope: "operator.read", since: "<=2026.7" },
  { name: "skills.forge.run", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.forge.promote", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.forge.retire", scope: "operator.admin", since: "<=2026.7" },
  { name: "skills.forge.telemetry", scope: "operator.read", since: "<=2026.7" },
  // Upstream 2026.8 methods the merge=ours resync dropped from this table while
  // grafting their siblings back; their handlers already ship in the merged tree
  // (sessions-recover.ts, control-ui.ts, device-pair-setup.ts). Re-appended at the
  // tail so no existing advertised method index shifts. setupStatus stays
  // unadvertised to match its setupCode sibling.
  { name: "sessions.recover", scope: "operator.write", since: "2026.8", startup: true },
  { name: "controlUi.sessionPreview", scope: "operator.read", since: "2026.8" },
  { name: "device.pair.setupStatus", scope: "operator.admin", since: "2026.8", advertise: false },
] as const;

const CORE_GATEWAY_METHOD_SPEC_BY_NAME: ReadonlyMap<string, CoreGatewayMethodSpec> = new Map(
  CORE_GATEWAY_METHOD_SPECS.map((spec) => [spec.name, spec]),
);

/** Core methods that are listed early but return retryable unavailable until sidecars are ready. */
export const STARTUP_UNAVAILABLE_GATEWAY_METHODS = CORE_GATEWAY_METHOD_SPECS.filter(
  (spec) => spec.startup === true,
).map((spec) => spec.name);

/** Returns the core methods that should be advertised to external gateway clients. */
export function listCoreAdvertisedGatewayMethodNames(): string[] {
  return CORE_GATEWAY_METHOD_SPECS.filter((spec) => spec.advertise !== false).map(
    (spec) => spec.name,
  );
}

/** Returns all registered core method names, including hidden/internal compatibility methods. */
export function listCoreGatewayMethodNames(): string[] {
  return listCoreGatewayMethodMetadata().map((spec) => spec.name);
}

/** Returns the public metadata emitted for every core gateway method. */
export function listCoreGatewayMethodMetadata(): readonly CoreGatewayMethodMetadata[] {
  return CORE_GATEWAY_METHOD_SPECS.map(({ name, scope, since }) => ({ name, scope, since }));
}

/** Looks up the raw core method scope, including node and dynamic sentinel scopes. */
function resolveCoreGatewayMethodScope(method: string): GatewayMethodScope | undefined {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.get(method)?.scope;
}

/** Looks up an operator-only core method scope, excluding node and dynamic methods. */
export function resolveCoreOperatorGatewayMethodScope(method: string): OperatorScope | undefined {
  const scope = resolveCoreGatewayMethodScope(method);
  return scope === NODE_GATEWAY_METHOD_SCOPE || scope === DYNAMIC_GATEWAY_METHOD_SCOPE
    ? undefined
    : scope;
}

/** Returns true for core methods reserved for authenticated node clients. */
export function isCoreNodeGatewayMethod(method: string): boolean {
  return resolveCoreGatewayMethodScope(method) === NODE_GATEWAY_METHOD_SCOPE;
}

/** Returns true for core methods whose required operator scope is resolved by the handler. */
export function isDynamicOperatorGatewayMethod(method: string): boolean {
  return resolveCoreGatewayMethodScope(method) === DYNAMIC_GATEWAY_METHOD_SCOPE;
}

/** Returns true when a method name has an explicit core policy entry. */
export function isCoreGatewayMethodClassified(method: string): boolean {
  return CORE_GATEWAY_METHOD_SPEC_BY_NAME.has(method);
}

/** Creates dispatch descriptors for core handlers and fails if any handler lacks policy. */
export function createCoreGatewayMethodDescriptors(
  handlers: Record<string, GatewayMethodHandler>,
): GatewayMethodDescriptorInput[] {
  const descriptors: GatewayMethodDescriptorInput[] = [];
  const specNames = new Set<string>();
  for (const spec of CORE_GATEWAY_METHOD_SPECS) {
    specNames.add(spec.name);
    const handler = handlers[spec.name];
    if (!handler) {
      // A spec with no handler is normal, not a dropped registration: callers pass
      // coreGatewayHandlers plus runtime-injected extraHandlers, and 47 of these
      // 389 specs are satisfied only that way (workboard via the plugin,
      // approval/question/secrets/exec.approval via sidecars). A gateway running
      // without the workboard plugin must still start, so this cannot be made
      // symmetric with the throw below, and the two directions are not the same
      // invariant. Loss of a spec AND its registration together is a merge-drift
      // problem — see scripts/check-upstream-merge-delta.mjs — not one this
      // self-consistency check can see.
      continue;
    }
    descriptors.push({
      name: spec.name,
      handler,
      owner: { kind: "core", area: "gateway" },
      scope: spec.scope,
      // Registry defaults core methods to "independent"; profile-dependent methods must
      // say "required" so dispatch waits for immutable profile attachment (pending-profile
      // authorization tests enforce this fail-closed).
      ...(isCoreGatewayMethodProfileDependent(spec.name) ? { profileAccess: "required" } : {}),
      ...(spec.since ? { since: spec.since } : {}),
      ...(spec.advertise === false ? { advertise: false } : {}),
      ...(spec.startup === true ? { startup: "unavailable-until-sidecars" } : {}),
      ...(spec.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
    });
  }
  for (const name of Object.keys(handlers)) {
    if (!specNames.has(name)) {
      // Unclassified core handlers would bypass scope/startup/write metadata, so fail before the
      // dispatcher can expose a method with missing policy.
      throw new Error(`gateway method handler is missing a descriptor: ${name}`);
    }
  }
  return descriptors;
}
