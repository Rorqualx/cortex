// Control UI controller manages skill workshop gateway state.
import type { GatewayBrowserClient } from "../gateway.ts";
import type {
  SkillForgeAction,
  SkillForgeActionNotice,
  SkillForgeMode,
  SkillForgeProposal,
  SkillForgeStatusFilter,
} from "../views/skill-forge.ts";

const SKILL_WORKSHOP_NOTICE_MS = 2800;

type SkillProposalStatus = "pending" | "applied" | "rejected" | "quarantined" | "stale";
type SkillProposalKind = "create" | "update";
type SkillProposalScanState = "pending" | "clean" | "failed" | "quarantined";

type SkillProposalManifestEntry = {
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  title: string;
  description: string;
  skillName: string;
  skillKey: string;
  createdAt: string;
  updatedAt: string;
  scanState: SkillProposalScanState;
};

type SkillProposalManifest = {
  schema: "openclaw.skill-forge.proposals-manifest.v1";
  updatedAt: string;
  proposals: SkillProposalManifestEntry[];
};

type SkillProposalSupportFileRecord = {
  path: string;
  sizeBytes: number;
};

type SkillProposalOrigin = {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
};

type SkillProposalRecord = {
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  proposedVersion: string;
  origin?: SkillProposalOrigin;
  supportFiles?: SkillProposalSupportFileRecord[];
  target: {
    skillName: string;
    skillKey: string;
  };
};

type SkillProposalSupportFile = {
  path: string;
  content: string;
};

type SkillProposalInspectResult = {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: SkillProposalSupportFile[];
};

export type SkillForgeState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  skillForgeLoading: boolean;
  skillForgeLoaded: boolean;
  skillForgeError: string | null;
  skillForgeInspectingKey: string | null;
  skillForgeProposals: SkillForgeProposal[];
  skillForgeSelectedKey: string | null;
  skillForgeActionBusy: { key: string; action: SkillForgeAction } | null;
  skillForgeActionNotice: SkillForgeActionNotice | null;
  skillForgeActionNoticeTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  skillForgeRevisionKey: string | null;
  skillForgeRevisionDraft: string;
  skillForgeStatusFilter: SkillForgeStatusFilter;
  skillForgeQuery: string;
  skillForgeFilePreviewKey: string | null;
  skillForgeFilePreviewQuery: string;
  skillForgeQueueWidth: number;
  skillForgeMode: SkillForgeMode;
  skillForgeUseCurrentChatForRevisions: boolean;
};

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseDateMs(value: string | undefined): number {
  if (!value) {
    return Date.now();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function recencyGroup(ms: number): SkillForgeProposal["recencyGroup"] {
  const today = startOfLocalDay(Date.now());
  const day = startOfLocalDay(ms);
  if (day === today) {
    return "today";
  }
  if (day === today - 24 * 60 * 60 * 1000) {
    return "yesterday";
  }
  return "earlier";
}

function compactAgeLabel(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) {
    return "now";
  }
  if (min < 60) {
    return `${min}m`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr}h`;
  }
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

function proposedVersionNumber(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? "").replace(/^v/i, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function stripProposalFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function supportFilesFromInspect(
  result: SkillProposalInspectResult,
): SkillForgeProposal["supportFiles"] {
  const sizes = new Map(
    (result.record.supportFiles ?? []).map((file) => [file.path, file.sizeBytes]),
  );
  return (result.supportFiles ?? []).map((file) => ({
    path: file.path,
    size: formatBytes(sizes.get(file.path) ?? byteLength(file.content)),
    contents: file.content,
  }));
}

function proposalFromManifest(
  entry: SkillProposalManifestEntry,
  previous: SkillForgeProposal | undefined,
): SkillForgeProposal {
  const updatedAt = parseDateMs(entry.updatedAt);
  const createdAt = parseDateMs(entry.createdAt);
  const previousIsCurrent = previous?.updatedAt === updatedAt;
  return {
    key: entry.id,
    slug: entry.skillKey,
    name: entry.title || entry.skillName,
    oneLine: entry.description,
    body: previousIsCurrent ? previous.body : "",
    status: entry.status,
    ...(previousIsCurrent && previous.origin ? { origin: previous.origin } : {}),
    version: previousIsCurrent ? previous.version : 1,
    createdAt,
    updatedAt,
    recencyGroup: recencyGroup(updatedAt || createdAt),
    ageLabel: compactAgeLabel(updatedAt || createdAt),
    supportFiles: previousIsCurrent ? previous.supportFiles : [],
    isNew: previous?.isNew ?? false,
  };
}

function proposalFromInspect(
  result: SkillProposalInspectResult,
  previous: SkillForgeProposal | undefined,
): SkillForgeProposal {
  const record = result.record;
  const updatedAt = parseDateMs(record.updatedAt);
  const createdAt = parseDateMs(record.createdAt);
  return {
    key: record.id,
    slug: record.target.skillKey,
    name: record.title || record.target.skillName,
    oneLine: record.description,
    body: stripProposalFrontmatter(result.content),
    status: record.status,
    ...(record.origin ? { origin: record.origin } : {}),
    version: proposedVersionNumber(record.proposedVersion),
    createdAt,
    updatedAt,
    recencyGroup: recencyGroup(updatedAt || createdAt),
    ageLabel: compactAgeLabel(updatedAt || createdAt),
    supportFiles: supportFilesFromInspect(result),
    isNew: previous?.isNew ?? false,
  };
}

function mergeProposal(state: SkillForgeState, proposal: SkillForgeProposal): void {
  const proposals = state.skillForgeProposals;
  const index = proposals.findIndex((item) => item.key === proposal.key);
  if (index < 0) {
    state.skillForgeProposals = [proposal, ...proposals];
    return;
  }
  state.skillForgeProposals = [
    ...proposals.slice(0, index),
    proposal,
    ...proposals.slice(index + 1),
  ];
}

function clearActionNoticeTimer(state: SkillForgeState): void {
  if (state.skillForgeActionNoticeTimer) {
    globalThis.clearTimeout(state.skillForgeActionNoticeTimer);
    state.skillForgeActionNoticeTimer = null;
  }
}

function showActionNotice(
  state: SkillForgeState,
  proposal: SkillForgeProposal | undefined,
  label: string,
): void {
  if (!proposal) {
    return;
  }
  clearActionNoticeTimer(state);
  state.skillForgeActionNotice = {
    key: proposal.key,
    label,
    slug: proposal.slug || proposal.name,
  };
  state.skillForgeActionNoticeTimer = globalThis.setTimeout(() => {
    if (state.skillForgeActionNotice?.key === proposal.key) {
      state.skillForgeActionNotice = null;
    }
    state.skillForgeActionNoticeTimer = null;
  }, SKILL_WORKSHOP_NOTICE_MS);
}

export function countSkillForgeProposals(
  proposals: SkillForgeProposal[],
): Record<"all" | SkillProposalStatus, number> {
  return proposals.reduce(
    (counts, proposal) => {
      counts.all += 1;
      counts[proposal.status] += 1;
      return counts;
    },
    { all: 0, pending: 0, applied: 0, rejected: 0, quarantined: 0, stale: 0 },
  );
}

export async function loadSkillForgeProposals(
  state: SkillForgeState,
  options?: { force?: boolean },
): Promise<void> {
  if (!state.client || !state.connected || state.skillForgeLoading) {
    return;
  }
  if (state.skillForgeLoaded && !options?.force) {
    return;
  }
  state.skillForgeLoading = true;
  state.skillForgeError = null;
  try {
    const result = await state.client.request<SkillProposalManifest>("skills.proposals.list", {});
    const previousByKey = new Map(
      state.skillForgeProposals.map((proposal) => [proposal.key, proposal]),
    );
    const proposals = (result.proposals ?? [])
      .toSorted((a, b) => parseDateMs(b.updatedAt) - parseDateMs(a.updatedAt))
      .map((entry) => proposalFromManifest(entry, previousByKey.get(entry.id)));
    state.skillForgeProposals = proposals;
    state.skillForgeLoaded = true;
    if (!proposals.some((proposal) => proposal.key === state.skillForgeSelectedKey)) {
      state.skillForgeSelectedKey = proposals[0]?.key ?? null;
    }
    if (state.skillForgeSelectedKey) {
      await loadSkillForgeProposalDetail(state, state.skillForgeSelectedKey);
    }
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
  } finally {
    state.skillForgeLoading = false;
  }
}

export async function loadSkillForgeProposalDetail(
  state: SkillForgeState,
  proposalId: string,
  options?: { force?: boolean },
): Promise<void> {
  if (!state.client || !state.connected || state.skillForgeInspectingKey === proposalId) {
    return;
  }
  const existing = state.skillForgeProposals.find((proposal) => proposal.key === proposalId);
  if (existing?.body && !options?.force) {
    return;
  }
  state.skillForgeInspectingKey = proposalId;
  state.skillForgeError = null;
  try {
    const result = await state.client.request<SkillProposalInspectResult>(
      "skills.proposals.inspect",
      {
        proposalId,
      },
    );
    mergeProposal(state, proposalFromInspect(result, existing));
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
  } finally {
    if (state.skillForgeInspectingKey === proposalId) {
      state.skillForgeInspectingKey = null;
    }
  }
}

export function selectSkillForgeProposal(state: SkillForgeState, proposalId: string): void {
  state.skillForgeSelectedKey = proposalId;
  void loadSkillForgeProposalDetail(state, proposalId);
}

async function refreshAfterMutation(state: SkillForgeState, proposalId: string): Promise<void> {
  state.skillForgeLoaded = false;
  await loadSkillForgeProposals(state, { force: true });
  await loadSkillForgeProposalDetail(state, proposalId, { force: true });
}

export async function runSkillForgeLifecycleAction(
  state: SkillForgeState,
  action: Extract<SkillForgeAction, "apply" | "reject">,
  proposalId: string,
): Promise<void> {
  if (!state.client || !state.connected || state.skillForgeActionBusy) {
    return;
  }
  const previous = state.skillForgeProposals.find((proposal) => proposal.key === proposalId);
  state.skillForgeActionBusy = { key: proposalId, action };
  state.skillForgeActionNotice = null;
  state.skillForgeError = null;
  try {
    const method = action === "apply" ? "skills.proposals.apply" : "skills.proposals.reject";
    await state.client.request(method, { proposalId });
    await refreshAfterMutation(state, proposalId);
    const updated = state.skillForgeProposals.find((proposal) => proposal.key === proposalId);
    showActionNotice(state, updated ?? previous, action === "apply" ? "Applied" : "Rejected");
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
  } finally {
    if (
      state.skillForgeActionBusy?.key === proposalId &&
      state.skillForgeActionBusy.action === action
    ) {
      state.skillForgeActionBusy = null;
    }
  }
}

export async function requestSkillForgeRevision(
  state: SkillForgeState,
  proposalId: string,
  sendRevisionRequest: (instructions: string, proposal: SkillForgeProposal) => Promise<void>,
): Promise<boolean> {
  if (state.skillForgeActionBusy) {
    return false;
  }
  const proposal = state.skillForgeProposals.find((item) => item.key === proposalId);
  const instructions = state.skillForgeRevisionDraft.trim();
  if (!proposal || !instructions) {
    return false;
  }
  state.skillForgeActionBusy = { key: proposalId, action: "revise" };
  state.skillForgeActionNotice = null;
  state.skillForgeError = null;
  try {
    await loadSkillForgeProposalDetail(state, proposalId);
    const currentProposal =
      state.skillForgeProposals.find((item) => item.key === proposalId) ?? proposal;
    await sendRevisionRequest(instructions, currentProposal);
    state.skillForgeRevisionKey = null;
    state.skillForgeRevisionDraft = "";
    showActionNotice(state, proposal, "Revision requested");
    return true;
  } catch (err) {
    state.skillForgeError = getErrorMessage(err);
    return false;
  } finally {
    if (
      state.skillForgeActionBusy?.key === proposalId &&
      state.skillForgeActionBusy.action === "revise"
    ) {
      state.skillForgeActionBusy = null;
    }
  }
}
