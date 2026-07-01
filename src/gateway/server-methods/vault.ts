// Gateway methods for the egress secret vault: list, save, delete.
//
// Save accepts the secret material once (UI -> gateway) and encrypts it in the
// store immediately. List returns metadata only — values never leave the host.
import {
  ErrorCodes,
  errorShape,
  validateVaultDeleteParams,
  validateVaultSaveParams,
  type VaultSaveParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerDynamicSecret } from "../../logging/redact.js";
import {
  deleteVaultSecret,
  listVaultSecrets,
  saveVaultSecret,
  type VaultLoginConfig,
  type VaultSecretInput,
} from "../../secrets/vault/store.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Register every secret field so an incidental later log line is scrubbed. */
function registerSaveSecrets(params: VaultSaveParams): void {
  switch (params.authKind) {
    case "bearer":
      registerDynamicSecret(params.token);
      return;
    case "basic":
    case "login":
      registerDynamicSecret(params.password);
      return;
    case "header":
      for (const header of params.headers) {
        registerDynamicSecret(header.value);
      }
      return;
    case "ssh":
      if (params.password) registerDynamicSecret(params.password);
      if (params.privateKey) registerDynamicSecret(params.privateKey);
      if (params.passphrase) registerDynamicSecret(params.passphrase);
      return;
  }
}

/** Map the validated protocol params to the store's input union. */
function toVaultSecretInput(params: VaultSaveParams): VaultSecretInput {
  const common = {
    name: params.name,
    hostAllowlist: params.hostAllowlist,
    ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
    ...(params.description ? { description: params.description } : {}),
  };
  switch (params.authKind) {
    case "bearer":
      return { ...common, authKind: "bearer", token: params.token };
    case "basic":
      return { ...common, authKind: "basic", username: params.username, password: params.password };
    case "header":
      return { ...common, authKind: "header", headers: params.headers };
    case "login":
      return {
        ...common,
        authKind: "login",
        username: params.username,
        password: params.password,
        login: params.login as VaultLoginConfig,
      };
    case "ssh": {
      const input: Extract<VaultSecretInput, { authKind: "ssh" }> = {
        ...common,
        authKind: "ssh",
      };
      if (params.username) input.username = params.username;
      if (params.password) input.password = params.password;
      if (params.privateKey) input.privateKey = params.privateKey;
      if (params.passphrase) input.passphrase = params.passphrase;
      if (params.port !== undefined) input.port = params.port;
      if (!input.password && !input.privateKey) {
        throw new Error("SSH vault entry requires at least one of password or privateKey.");
      }
      return input;
    }
    default: {
      const exhaustive: never = params;
      return exhaustive;
    }
  }
}

export const vaultHandlers: GatewayRequestHandlers = {
  "vault.list": async ({ respond }) => {
    respond(true, { entries: listVaultSecrets() });
  },
  "vault.save": async ({ params, respond }) => {
    if (!validateVaultSaveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid vault.save params"),
      );
      return;
    }
    registerSaveSecrets(params);
    saveVaultSecret(toVaultSecretInput(params));
    respond(true, { ok: true });
  },
  "vault.delete": async ({ params, respond }) => {
    if (!validateVaultDeleteParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid vault.delete params"),
      );
      return;
    }
    deleteVaultSecret(params.name);
    respond(true, { ok: true });
  },
};
