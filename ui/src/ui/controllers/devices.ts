// Control UI controller manages devices gateway state.
import { clearDeviceAuthToken, storeDeviceAuthToken } from "../device-auth.ts";
import { loadOrCreateDeviceIdentity } from "../device-identity.ts";
import type { GatewayBrowserClient } from "../gateway.ts";

export type DeviceTokenSummary = {
  role: string;
  scopes?: string[];
  createdAtMs?: number;
  rotatedAtMs?: number;
  revokedAtMs?: number;
  lastUsedAtMs?: number;
};

// Device-type metadata the gateway forwards from the pairing handshake
// (redactPairedDevice spreads these through). platform/clientId are reliably
// populated; deviceFamily is often absent depending on the paired client.
export type DeviceTypeMeta = {
  platform?: string;
  deviceFamily?: string;
  clientId?: string;
  clientMode?: string;
};

export type PendingDevice = DeviceTypeMeta & {
  requestId: string;
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  role?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  isRepair?: boolean;
  ts?: number;
};

export type PairedDevice = DeviceTypeMeta & {
  deviceId: string;
  publicKey?: string;
  displayName?: string;
  roles?: string[];
  scopes?: string[];
  remoteIp?: string;
  tokens?: DeviceTokenSummary[];
  createdAtMs?: number;
  approvedAtMs?: number;
};

export type DevicePairingList = {
  pending: PendingDevice[];
  paired: PairedDevice[];
};

export type DevicesState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
};

export async function loadDevices(state: DevicesState, opts?: { quiet?: boolean }) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.devicesLoading) {
    return;
  }
  state.devicesLoading = true;
  if (!opts?.quiet) {
    state.devicesError = null;
  }
  try {
    const res = await state.client.request<{
      pending?: Array<PendingDevice>;
      paired?: Array<PairedDevice>;
    }>("device.pair.list", {});
    state.devicesList = {
      pending: Array.isArray(res?.pending) ? res.pending : [],
      paired: Array.isArray(res?.paired) ? res.paired : [],
    };
  } catch (err) {
    if (!opts?.quiet) {
      state.devicesError = String(err);
    }
  } finally {
    state.devicesLoading = false;
  }
}

export async function approveDevicePairing(state: DevicesState, requestId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    await state.client.request("device.pair.approve", { requestId });
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

export async function rejectDevicePairing(state: DevicesState, requestId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const confirmed = window.confirm("Reject this device pairing request?");
  if (!confirmed) {
    return;
  }
  try {
    await state.client.request("device.pair.reject", { requestId });
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

export async function removePairedDeviceEntry(state: DevicesState, deviceId: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const identity = await loadOrCreateDeviceIdentity();
  const isSelf = deviceId === identity.deviceId;
  const message = isSelf
    ? "This is the device you're using now. Removing it will sign you out. Continue?"
    : `Remove paired device ${deviceId.slice(0, 8)}? It must pair again to reconnect.`;
  if (!window.confirm(message)) {
    return;
  }
  try {
    await state.client.request("device.pair.remove", { deviceId });
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

// Bulk cleanup: drop every paired device except the one in use, so a long tail
// of stale browser/CLI pairings can be cleared without signing out the operator.
export async function removeOtherPairedDevices(state: DevicesState) {
  if (!state.client || !state.connected) {
    return;
  }
  const paired = state.devicesList?.paired ?? [];
  const identity = await loadOrCreateDeviceIdentity();
  const targets = paired.filter((device) => device.deviceId !== identity.deviceId);
  if (targets.length === 0) {
    window.alert("No other paired devices to remove.");
    return;
  }
  const plural = targets.length === 1 ? "" : "s";
  const confirmed = window.confirm(
    `Remove ${targets.length} other paired device${plural}? They must pair again to reconnect. This device stays signed in.`,
  );
  if (!confirmed) {
    return;
  }
  try {
    for (const device of targets) {
      await state.client.request("device.pair.remove", { deviceId: device.deviceId });
    }
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
    // Some targets may have been removed before the failure; refresh quietly so
    // the list reflects the real server state without clearing the error.
    await loadDevices(state, { quiet: true });
  }
}

export async function rotateDeviceToken(
  state: DevicesState,
  params: { deviceId: string; role: string; scopes?: string[] },
) {
  if (!state.client || !state.connected) {
    return;
  }
  try {
    const res = await state.client.request<{
      token?: string;
      role?: string;
      deviceId?: string;
      scopes?: Array<string>;
    }>("device.token.rotate", params);
    if (res?.token) {
      const identity = await loadOrCreateDeviceIdentity();
      const role = res.role ?? params.role;
      if (res.deviceId === identity.deviceId || params.deviceId === identity.deviceId) {
        storeDeviceAuthToken({
          deviceId: identity.deviceId,
          role,
          token: res.token,
          scopes: res.scopes ?? params.scopes ?? [],
        });
      }
      window.prompt("New device token (copy and store securely):", res.token);
    }
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}

export async function revokeDeviceToken(
  state: DevicesState,
  params: { deviceId: string; role: string },
) {
  if (!state.client || !state.connected) {
    return;
  }
  const confirmed = window.confirm(`Revoke token for ${params.deviceId} (${params.role})?`);
  if (!confirmed) {
    return;
  }
  try {
    await state.client.request("device.token.revoke", params);
    const identity = await loadOrCreateDeviceIdentity();
    if (params.deviceId === identity.deviceId) {
      clearDeviceAuthToken({ deviceId: identity.deviceId, role: params.role });
    }
    await loadDevices(state);
  } catch (err) {
    state.devicesError = String(err);
  }
}
