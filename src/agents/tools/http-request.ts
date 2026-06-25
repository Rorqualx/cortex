/**
 * Egress chokepoint that brokers user-saved vault credentials into outbound API
 * calls. The model passes only a URL/method/body — it never names or sees a
 * secret. The runtime injects the bound credential ONLY when the request host
 * matches the vault entry's allowlist, then scrubs the value from the result and
 * logs. This is the single place vault values touch a network request.
 */
import { Type } from "typebox";
import { isBlockedHostnameOrIp } from "../../infra/net/ssrf.js";
import { registerDynamicSecret, scrubDynamicSecrets } from "../../logging/redact.js";
import {
  buildAuthHeaders,
  describeVaultCatalogForModel,
  getVaultEntryForHost,
  getVaultGrant,
  listVaultSecrets,
  recordVaultGrant,
  resolveVaultSecretMaterial,
  type VaultSecretEntry,
} from "../../secrets/vault/store.js";
import { stringEnum } from "../schema/string-enum.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";
import {
  type GuardedFetchFn,
  resolveLoginSession,
  type VaultSessionHeader,
} from "./vault-login.js";
import {
  fetchWithWebToolsNetworkGuard,
  WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY,
} from "./web-guarded-fetch.js";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_RESPONSE_CHARS = 100_000;

/** Reviewer decision for one secret-use prompt. */
export type SecretUseDecision = "allow-once" | "allow-always" | "deny";
/** Async approver injected by the gateway; absent in headless contexts. */
export type SecretApprover = (request: {
  name: string;
  host: string;
  signal?: AbortSignal;
}) => Promise<SecretUseDecision>;

const HttpRequestSchema = Type.Object({
  url: Type.String({ description: "Full URL to request. Use HTTPS for any authenticated call." }),
  method: Type.Optional(stringEnum(HTTP_METHODS, { description: "HTTP method.", default: "GET" })),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        "Additional request headers. Do NOT put API keys or tokens here — saved credentials are injected automatically for allowlisted hosts.",
    }),
  ),
  body: Type.Optional(Type.String({ description: "Request body for POST/PUT/PATCH/DELETE." })),
});

export type InjectionDecision = "inject" | "denied" | "no-approval-channel";

/**
 * Decide whether a bound vault credential may be injected for one request, and
 * persist any standing grant. Extracted from the tool so the grant/approval
 * logic is unit-testable without an outbound request.
 */
export async function resolveSecretInjectionDecision(params: {
  entry: VaultSecretEntry;
  host: string;
  env: NodeJS.ProcessEnv;
  approveSecretUse?: SecretApprover;
  signal?: AbortSignal;
}): Promise<InjectionDecision> {
  const { entry, host, env } = params;
  const grant = getVaultGrant(entry.name, host, { env });
  if (grant === "deny") {
    return "denied";
  }
  if (entry.approvalPolicy === "auto" || grant === "allow-always") {
    return "inject";
  }
  if (!params.approveSecretUse) {
    // Policy requires a prompt but no approval route is attached (e.g.
    // headless/cron). Fail closed rather than inject on autopilot.
    return "no-approval-channel";
  }
  const decision = await params.approveSecretUse({ name: entry.name, host, signal: params.signal });
  if (decision === "allow-always") {
    recordVaultGrant(entry.name, host, "allow-always", { env });
    return "inject";
  }
  if (decision === "deny") {
    recordVaultGrant(entry.name, host, "deny", { env });
    return "denied";
  }
  return "inject";
}

function readHeaders(params: Record<string, unknown>): Record<string, string> {
  const raw = params.headers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

/** Merge the session header onto base + injected headers (Cookie is appended). */
function withSessionHeader(
  base: Record<string, string>,
  session: VaultSessionHeader | null,
): Record<string, string> {
  if (!session) {
    return { ...base };
  }
  const out = { ...base };
  if (session.name === "Cookie" && out.Cookie) {
    out.Cookie = `${out.Cookie}; ${session.value}`;
  } else {
    out[session.name] = session.value;
  }
  return out;
}

export function createHttpRequestTool(options?: {
  env?: NodeJS.ProcessEnv;
  approveSecretUse?: SecretApprover;
  /** Force-enable even with no saved secrets (tests). */
  forceEnabled?: boolean;
  /** Guarded-fetch override (tests). */
  fetchGuarded?: GuardedFetchFn;
}): AnyAgentTool | null {
  const env = options?.env ?? process.env;
  // Opt-in by saving a credential: the powerful generic egress tool only appears
  // once the user has a vault entry it could serve. Avoids adding a config flag.
  if (!options?.forceEnabled && listVaultSecrets({ env }).length === 0) {
    return null;
  }
  const fetchGuarded = options?.fetchGuarded ?? fetchWithWebToolsNetworkGuard;

  const catalog = describeVaultCatalogForModel({ env });
  return {
    label: "HTTP Request",
    name: "http_request",
    description:
      "Make an authenticated HTTP request to an API. Saved credentials are injected automatically for allowlisted hosts — never include API keys in headers; reference the API by URL only." +
      (catalog ? `\n\n${catalog}` : ""),
    parameters: HttpRequestSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      const method = (readStringParam(params, "method") ?? "GET").toUpperCase();
      const body = readStringParam(params, "body");
      const baseHeaders = readHeaders(params);
      const notes: string[] = [];

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new Error(`http_request: invalid url "${url}".`);
      }
      const host = parsedUrl.hostname;
      const isHttps = parsedUrl.protocol === "https:";
      // A vault-allowlisted private/LAN host (e.g. a router admin panel) is the
      // user's own network and may legitimately be plain HTTP; only public hosts
      // are held to HTTPS-only credential injection. Covers private IP literals
      // and local hostnames (localhost, *.local mDNS, *.internal).
      const isPrivateHost = isBlockedHostnameOrIp(host);

      const entry = getVaultEntryForHost(host, { env });
      let secretInjected = false;
      let loginEntry: VaultSecretEntry | undefined;
      let sessionHeader: VaultSessionHeader | null = null;
      const injectedHeaders: Record<string, string> = {};

      if (entry) {
        if (!isHttps && !isPrivateHost) {
          // Refuse to put a credential on the wire in cleartext on a public host.
          notes.push(`Credential "${entry.name}" not injected: ${host} is not HTTPS.`);
        } else {
          const decision = await resolveSecretInjectionDecision({
            entry,
            host,
            env,
            approveSecretUse: options?.approveSecretUse,
            signal,
          });
          if (decision === "inject" && entry.authKind === "login") {
            sessionHeader = await resolveLoginSession({ entry, host, env, signal, fetchGuarded });
            if (sessionHeader) {
              registerDynamicSecret(sessionHeader.value);
              secretInjected = true;
              loginEntry = entry;
            } else {
              notes.push(`Credential "${entry.name}" login to ${host} failed; not injected.`);
            }
          } else if (decision === "inject") {
            const material = resolveVaultSecretMaterial(entry.name, { env });
            if (material) {
              for (const header of buildAuthHeaders(material, entry.authConfig)) {
                // Register before the request so any lower-layer logging is
                // scrubbed, and override any model-supplied header of the same name.
                registerDynamicSecret(header.value);
                injectedHeaders[header.name] = header.value;
                secretInjected = true;
              }
            }
          } else if (decision === "denied") {
            notes.push(`Credential "${entry.name}" use was denied for ${host}.`);
          } else {
            notes.push(
              `Credential "${entry.name}" requires approval but no approval channel is attached; not injected.`,
            );
          }
        }
      }

      const sendOnce = async (session: VaultSessionHeader | null) => {
        const headers = withSessionHeader({ ...baseHeaders, ...injectedHeaders }, session);
        const init: RequestInit = { method, headers };
        if (body !== undefined && method !== "GET" && method !== "HEAD") {
          init.body = body;
        }
        return fetchGuarded({
          url,
          init,
          timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
          // When a secret is on the request, require HTTPS end-to-end so a
          // redirect cannot downgrade the credential onto a cleartext hop —
          // except for a private/LAN host the user explicitly allowlisted.
          requireHttps: secretInjected && !isPrivateHost,
          // Relax private-network egress only when a credential is actually on
          // the request: the user's saved+approved secret is the opt-in for that
          // host. A denied/failed credential (secretInjected === false) keeps the
          // strict default policy so denial also withholds LAN reachability.
          ...(secretInjected
            ? { policy: WEB_TOOLS_SELF_HOSTED_NETWORK_SSRF_POLICY, useEnvProxy: true }
            : {}),
          signal,
        });
      };

      let { response, finalUrl, release } = await sendOnce(sessionHeader);
      // A cached session may have expired server-side; re-authenticate once on
      // an auth failure and retry, so the model does not see a spurious 401/403.
      if (loginEntry && (response.status === 401 || response.status === 403)) {
        const fresh = await resolveLoginSession({
          entry: loginEntry,
          host,
          env,
          signal,
          force: true,
          fetchGuarded,
        });
        if (fresh) {
          // Only discard the 401 once we have a fresh session to retry with; if
          // re-auth fails we keep the original response and surface the real 401.
          await release();
          registerDynamicSecret(fresh.value);
          ({ response, finalUrl, release } = await sendOnce(fresh));
        }
      }

      try {
        const rawBody = await response.text();
        const truncated = rawBody.length > MAX_RESPONSE_CHARS;
        const bodyText = truncated ? rawBody.slice(0, MAX_RESPONSE_CHARS) : rawBody;
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of response.headers.entries()) {
          responseHeaders[key] = value;
        }
        // Scrub any echoed credential from everything that returns to the model
        // and the transcript (the tool result IS the transcript entry).
        return jsonResult({
          status: response.status,
          statusText: response.statusText,
          finalUrl: scrubDynamicSecrets(finalUrl),
          secretInjected,
          headers: JSON.parse(scrubDynamicSecrets(JSON.stringify(responseHeaders))) as Record<
            string,
            string
          >,
          body: scrubDynamicSecrets(bodyText),
          truncated,
          ...(notes.length > 0 ? { notes } : {}),
        });
      } finally {
        await release();
      }
    },
  };
}
