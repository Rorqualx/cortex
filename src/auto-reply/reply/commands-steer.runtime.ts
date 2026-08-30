// Runtime barrel for embedded-agent steering helpers used by auto-reply commands.
export { resolveActiveEmbeddedRunSessionId } from "../../agents/embedded-agent-runner/active-run-projections.js";
export {
  formatEmbeddedAgentQueueFailureSummary,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunHandleSessionId,
} from "../../agents/embedded-agent-runner/runs.js";
