/**
 * Stateful login flow for the vault 'login' auth kind. The gateway POSTs the
 * saved credentials to a configured login endpoint, captures the returned
 * session token/cookie, caches it (encrypted, with a TTL), and replays it on
 * subsequent allowlisted requests. The model never sees the credentials or the
 * token — both are registered for redaction and only ever touch the wire here.
 */
import { isBlockedHostnameOrIp } from "../../infra/net/ssrf.js";
import { registerDynamicSecret } from "../../logging/redact.js";
import {
  DEFAULT_VAULT_SESSION_TTL_SECONDS,
  deleteVaultSession,
  encodeBasicAuth,
  getVaultSession,
  hostMatchesAllowlist,
  resolveVaultSecretMaterial,
  saveVaultSession,
  type VaultLoginConfig,
  type VaultLoginTokenPlacement,
  type VaultSecretEntry,
} from "../../secrets/vault/store.js";
import {
  fetchWithWebToolsNetworkGuard,
  WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY,
} from "./web-guarded-fetch.js";

export type GuardedFetchFn = typeof fetchWithWebToolsNetworkGuard;

/** A single header to add to the real request to carry the session. */
export type VaultSessionHeader = { name: string; value: string };

const LOGIN_TIMEOUT_SECONDS = 20;

/** Fill a login body template with the (secret) credential material. */
function renderLoginBody(template: string, username: string, password: string): string {
  return template
    .split("{{username}}")
    .join(username)
    .split("{{password}}")
    .join(password)
    .split("{{basicRaw}}")
    .join(`${username}:${password}`)
    .split("{{basic}}")
    .join(encodeBasicAuth(username, password));
}

/** Read a named cookie out of a response's Set-Cookie header(s). */
function readSetCookie(response: Response, cookieName: string): string | undefined {
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : (() => {
          const raw = response.headers.get("set-cookie");
          return raw ? [raw] : [];
        })();
  for (const cookie of cookies) {
    const first = cookie.split(";", 1)[0] ?? "";
    const eq = first.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (first.slice(0, eq).trim() === cookieName) {
      return first.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** Walk a dotted path into a parsed JSON body, returning a string leaf. */
function readJsonPath(body: string, path: string): string | undefined {
  let current: unknown;
  try {
    current = JSON.parse(body);
  } catch {
    return undefined;
  }
  for (const key of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (typeof current === "string") {
    return current;
  }
  return typeof current === "number" ? String(current) : undefined;
}

/** Build the header that carries the session token onto a real request. */
function placeToken(place: VaultLoginTokenPlacement, token: string): VaultSessionHeader {
  if (place.as === "cookie") {
    return { name: "Cookie", value: `${place.cookieName}=${token}` };
  }
  const colon = place.template.indexOf(":");
  const name =
    colon === -1 ? "Authorization" : place.template.slice(0, colon).trim() || "Authorization";
  const valueTemplate = colon === -1 ? place.template : place.template.slice(colon + 1).trim();
  return { name, value: valueTemplate.split("{{token}}").join(token) };
}

/** Perform the login request and return the freshly captured token, or null. */
async function performLogin(params: {
  entry: VaultSecretEntry;
  cfg: VaultLoginConfig;
  host: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  fetchGuarded: GuardedFetchFn;
  now: number;
}): Promise<string | null> {
  const { entry, cfg, host, env, signal, fetchGuarded, now } = params;
  let loginHost: string;
  try {
    loginHost = new URL(cfg.loginUrl).hostname;
  } catch {
    return null;
  }
  // The login endpoint must itself be allowlisted, so a saved credential can
  // never be POSTed to an arbitrary host.
  if (!hostMatchesAllowlist(loginHost, entry.hostAllowlist)) {
    return null;
  }
  const material = resolveVaultSecretMaterial(entry.name, { env });
  if (!material || material.kind !== "login") {
    return null;
  }
  const body = renderLoginBody(cfg.bodyTemplate, material.username, material.password);
  // Register the secret substrings before the request so any lower-layer log
  // line is scrubbed. The rendered body's only secret part is the password /
  // basic credential already registered here, so it needs no separate entry.
  registerDynamicSecret(material.password);
  registerDynamicSecret(encodeBasicAuth(material.username, material.password));

  const headers: Record<string, string> = {
    "Content-Type": cfg.contentType ?? "application/x-www-form-urlencoded",
    ...cfg.extraHeaders,
  };
  const method = cfg.method ?? "POST";
  const init: RequestInit = { method, headers };
  if (method !== "GET") {
    init.body = body;
  }
  const loginIsPrivate = isBlockedHostnameOrIp(loginHost);
  const { response, finalUrl, release } = await fetchGuarded({
    url: cfg.loginUrl,
    init,
    timeoutSeconds: LOGIN_TIMEOUT_SECONDS,
    // Public login endpoints must stay HTTPS end-to-end; a LAN device may be
    // plain HTTP. Either way private-network egress is allowed because the host
    // is explicitly vault-allowlisted.
    requireHttps: !loginIsPrivate,
    policy: WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY,
    useEnvProxy: true,
    signal,
  });
  try {
    // A redirect must not carry the login response to a non-allowlisted host.
    let finalHost: string;
    try {
      finalHost = new URL(finalUrl).hostname;
    } catch {
      return null;
    }
    if (!hostMatchesAllowlist(finalHost, entry.hostAllowlist)) {
      return null;
    }
    const token =
      cfg.extract.from === "set-cookie"
        ? readSetCookie(response, cfg.extract.cookieName)
        : cfg.extract.from === "header"
          ? (response.headers.get(cfg.extract.header) ?? undefined)
          : readJsonPath(await response.text(), cfg.extract.path);
    if (!token) {
      return null;
    }
    registerDynamicSecret(token);
    const ttlMs = (cfg.ttlSeconds ?? DEFAULT_VAULT_SESSION_TTL_SECONDS) * 1000;
    saveVaultSession(entry.name, host, token, now + ttlMs, { env });
    return token;
  } finally {
    await release();
  }
}

/**
 * Resolve the session header for a 'login' entry, logging in if no valid cached
 * session exists (or if `force` is set after a 401). Returns null when login is
 * not possible, so the caller proceeds without a credential.
 */
export async function resolveLoginSession(params: {
  entry: VaultSecretEntry;
  host: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  force?: boolean;
  now?: number;
  fetchGuarded?: GuardedFetchFn;
}): Promise<VaultSessionHeader | null> {
  const { entry, host, env, signal } = params;
  if (entry.authConfig.kind !== "login") {
    return null;
  }
  const cfg = entry.authConfig.login;
  // The login config is decrypted from SQLite and only shape-checked loosely on
  // read; a corrupted/missing object fails closed (no injection) instead of
  // throwing mid-request like the other failure paths here.
  if (!cfg || typeof cfg.loginUrl !== "string" || !cfg.loginUrl) {
    return null;
  }
  const now = params.now ?? Date.now();
  const fetchGuarded = params.fetchGuarded ?? fetchWithWebToolsNetworkGuard;

  if (params.force) {
    deleteVaultSession(entry.name, host, { env });
  } else {
    const cached = getVaultSession(entry.name, host, { env, now });
    if (cached) {
      registerDynamicSecret(cached);
      return placeToken(cfg.place, cached);
    }
  }

  const token = await performLogin({ entry, cfg, host, env, signal, fetchGuarded, now });
  return token ? placeToken(cfg.place, token) : null;
}
