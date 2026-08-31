// Gateway operator-approvals client helper.
// Connects a backend Gateway client scoped to operator approval events.
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadGatewayTlsServerRuntime } from "../infra/tls/gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGatewayClientBootstrap } from "./client-bootstrap.js";
import { startGatewayClientWhenEventLoopReady } from "./client-start-readiness.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { getOperatorApprovalRuntimeToken } from "./operator-approval-runtime-token.js";

function shouldSendApprovalRuntimeToken(urlSource: string): boolean {
  // This token is process-local authority; loopback alone may be a tunnel or another gateway.
  return (
    urlSource === "local loopback" || urlSource === "missing gateway.remote.url (fallback local)"
  );
}

function shouldOmitApprovalRuntimeDeviceIdentity(params: {
  sendsApprovalRuntimeToken: boolean;
}): boolean {
  return params.sendsApprovalRuntimeToken;
}

/** Create a Gateway client authorized for operator approval event handling. */
export async function createOperatorApprovalsGatewayClient(
  params: Pick<
    GatewayClientOptions,
    | "clientDisplayName"
    | "onClose"
    | "onConnectError"
    | "onEvent"
    | "onHelloOk"
    | "onReconnectPaused"
  > & {
    config: OpenClawConfig;
    gatewayUrl?: string;
  },
): Promise<GatewayClient> {
  const bootstrap = await resolveGatewayClientBootstrap({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    env: process.env,
  });
  const sendsApprovalRuntimeToken = shouldSendApprovalRuntimeToken(bootstrap.urlSource);
  // The loopback gateway serves a locally generated self-signed cert; pin it by
  // fingerprint like the CLI path (gateway/call.ts resolveGatewayTlsFingerprint).
  // Without the pin Node rejects the cert and the native approval handler retries
  // forever (approval-handler-bootstrap). Only the local loopback connection trusts
  // this cert, so gate on the same loopback signal as the runtime token; guard on
  // tlsRuntime.enabled because loadGatewayTlsServerRuntime returns it false (fingerprint
  // undefined) when cert generation/parse fails.
  const localLoopbackTls =
    sendsApprovalRuntimeToken &&
    params.config.gateway?.tls?.enabled === true &&
    bootstrap.url.startsWith("wss://");
  const tlsRuntime = localLoopbackTls
    ? await loadGatewayTlsServerRuntime(params.config.gateway?.tls)
    : undefined;
  const tlsFingerprint = tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : undefined;

  return new GatewayClient({
    url: bootstrap.url,
    token: bootstrap.auth.token,
    password: bootstrap.auth.password,
    ...(sendsApprovalRuntimeToken
      ? { approvalRuntimeToken: getOperatorApprovalRuntimeToken() }
      : {}),
    preauthHandshakeTimeoutMs: bootstrap.preauthHandshakeTimeoutMs,
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: params.clientDisplayName,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
    scopes: ["operator.approvals"],
    deviceIdentity: shouldOmitApprovalRuntimeDeviceIdentity({
      sendsApprovalRuntimeToken,
    })
      ? null
      : undefined,
    onEvent: params.onEvent,
    onHelloOk: params.onHelloOk,
    onConnectError: params.onConnectError,
    onReconnectPaused: params.onReconnectPaused,
    onClose: params.onClose,
  });
}

/** Run a callback with a started operator-approvals Gateway client and close it after. */
export async function withOperatorApprovalsGatewayClient<T>(
  params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
  },
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  const ready = createDeferredCore();

  const gatewayClient = await createOperatorApprovalsGatewayClient({
    config: params.config,
    gatewayUrl: params.gatewayUrl,
    clientDisplayName: params.clientDisplayName,
    onHelloOk: () => {
      ready.resolve();
    },
    onConnectError: (err) => {
      ready.reject(err);
    },
    onClose: (code, reason) => {
      ready.reject(new Error(`gateway closed (${code}): ${reason}`));
    },
  });

  try {
    const readiness = await startGatewayClientWhenEventLoopReady(gatewayClient, {
      clientOptions: {},
    });
    if (!readiness.ready) {
      throw new Error(
        readiness.aborted
          ? "gateway approval client start aborted before readiness"
          : "gateway readiness unavailable before approval client start",
      );
    }
    await ready.promise;
    return await run(gatewayClient);
  } finally {
    await gatewayClient.stopAndWait().catch(() => {
      gatewayClient.stop();
    });
  }
}
