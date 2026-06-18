// Control UI controller resolves per-agent avatar images for the Personal card.
// The gateway /avatar/<id> route authenticates via the Authorization header only,
// so a plain <img src="/avatar/<id>"> request 401s in the browser. We authed-fetch
// the image and hand the view a blob: URL instead — the same pattern the chat-header
// avatar uses (`refreshChatAvatar` in app-chat.ts).
import { resolveControlUiAuthHeader } from "../control-ui-auth.ts";
import { normalizeBasePath } from "../navigation.ts";
import { getLocalAgentAvatarOverride } from "../storage.ts";
import type { AgentsListResult } from "../types.ts";

export type AgentAvatarHost = {
  basePath: string;
  connected: boolean;
  hello?: { auth?: { deviceToken?: string | null } | null } | null;
  settings?: { token?: string | null } | null;
  password?: string | null;
  agentsList: AgentsListResult | null;
  agentAvatarUrls: Record<string, string>;
};

// Track live object URLs per host so re-fetches can revoke the previous blob and
// avoid leaking it. Keyed by host identity, then by agent id.
const agentAvatarObjectUrls = new WeakMap<object, Map<string, string>>();
// Bump-on-refresh guard so a slow in-flight fetch cannot overwrite a newer result.
const agentAvatarRequestVersions = new WeakMap<object, number>();

function objectUrlMap(host: AgentAvatarHost): Map<string, string> {
  const key = host as object;
  let map = agentAvatarObjectUrls.get(key);
  if (!map) {
    map = new Map();
    agentAvatarObjectUrls.set(key, map);
  }
  return map;
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

function setAgentAvatarUrl(host: AgentAvatarHost, agentId: string, url: string | null) {
  const map = objectUrlMap(host);
  const previous = map.get(agentId);
  if (previous && previous !== url) {
    URL.revokeObjectURL(previous);
    map.delete(agentId);
  }
  if (url?.startsWith("blob:")) {
    map.set(agentId, url);
  }
  // Reassign the record (not mutate) so the LitElement @state triggers a render.
  const next = { ...host.agentAvatarUrls };
  if (url) {
    next[agentId] = url;
  } else {
    delete next[agentId];
  }
  host.agentAvatarUrls = next;
}

export function clearAgentAvatarCards(host: AgentAvatarHost) {
  const map = objectUrlMap(host);
  for (const url of map.values()) {
    URL.revokeObjectURL(url);
  }
  map.clear();
  host.agentAvatarUrls = {};
}

// Resolve the default agent's workspace photo into a blob URL for the Personal
// card. Only the default agent is fetched: every agent currently shares one
// workspace/IDENTITY.md, so fetching the others would just repeat the default
// agent's photo. Non-default agents fall back to their distinct emoji (or a
// browser-local override) until they are given a photo of their own.
export async function refreshAgentAvatarCards(host: AgentAvatarHost): Promise<void> {
  const defaultId = host.agentsList?.defaultId;
  if (!host.connected || !defaultId) {
    return;
  }
  const requestVersion = (agentAvatarRequestVersions.get(host as object) ?? 0) + 1;
  agentAvatarRequestVersions.set(host as object, requestVersion);
  const isCurrent = () => agentAvatarRequestVersions.get(host as object) === requestVersion;

  // A browser-local override (data URL) renders directly; drop any stale blob.
  if (getLocalAgentAvatarOverride(defaultId, defaultId)) {
    setAgentAvatarUrl(host, defaultId, null);
    return;
  }
  const authHeader = resolveControlUiAuthHeader(host);
  const headers = authHeader ? { Authorization: authHeader } : undefined;
  try {
    const metaRes = await fetch(buildAvatarMetaUrl(host.basePath, defaultId), {
      method: "GET",
      ...(headers ? { headers } : {}),
    });
    if (!isCurrent()) {
      return;
    }
    if (!metaRes.ok) {
      setAgentAvatarUrl(host, defaultId, null);
      return;
    }
    const data = (await metaRes.json()) as { avatarUrl?: unknown; avatarStatus?: unknown };
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    if (!avatarUrl) {
      setAgentAvatarUrl(host, defaultId, null);
      return;
    }
    // Remote/data URLs are safe to render directly; only local files behind the
    // gateway route need the authenticated fetch + blob.
    if (data.avatarStatus !== "local") {
      const renderable = data.avatarStatus === "remote" || data.avatarStatus === "data";
      setAgentAvatarUrl(host, defaultId, renderable ? avatarUrl : null);
      return;
    }
    const imgRes = await fetch(avatarUrl, { method: "GET", ...(headers ? { headers } : {}) });
    if (!isCurrent()) {
      return;
    }
    if (!imgRes.ok) {
      setAgentAvatarUrl(host, defaultId, null);
      return;
    }
    const blobUrl = URL.createObjectURL(await imgRes.blob());
    if (!isCurrent()) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    setAgentAvatarUrl(host, defaultId, blobUrl);
  } catch {
    if (isCurrent()) {
      setAgentAvatarUrl(host, defaultId, null);
    }
  }
}
