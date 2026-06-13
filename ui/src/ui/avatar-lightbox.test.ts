/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import { AvatarChangeEvent, AvatarLightbox } from "./avatar-lightbox.ts";
import {
  loadLocalAssistantIdentity,
  loadLocalUserIdentity,
  saveLocalUserIdentity,
} from "./storage.ts";

const DATA_URL = "data:image/png;base64,AAAA";

// saveCrop/cropUrl are private; reach them directly to drive the save path
// without staging a full crop gesture.
type LightboxInternals = AvatarLightbox & { cropUrl: string | null; saveCrop(): void };

function makeLightbox(target: "user" | "assistant"): LightboxInternals {
  const el = new AvatarLightbox() as LightboxInternals;
  el.target = target;
  el.cropUrl = DATA_URL;
  return el;
}

beforeEach(() => {
  // getSafeStorage ignores jsdom's getter-based localStorage under VITEST; a
  // plain stubbed value is what the storage helpers actually read/write.
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("avatar lightbox target routing", () => {
  it("saves an assistant crop to the assistant store, never the user's", () => {
    const events: AvatarChangeEvent[] = [];
    const listener = (e: Event) => events.push(e as AvatarChangeEvent);
    document.addEventListener(AvatarChangeEvent.eventName, listener);
    try {
      makeLightbox("assistant").saveCrop();
    } finally {
      document.removeEventListener(AvatarChangeEvent.eventName, listener);
    }

    expect(loadLocalAssistantIdentity().avatar).toBe(DATA_URL);
    expect(loadLocalUserIdentity().avatar).toBeNull();
    expect(events.at(-1)?.detail).toEqual({ avatar: DATA_URL, target: "assistant" });
  });

  it("saves a user crop to the user store, preserving the existing name", () => {
    saveLocalUserIdentity({ name: "Iris", avatar: null });

    makeLightbox("user").saveCrop();

    expect(loadLocalUserIdentity().avatar).toBe(DATA_URL);
    expect(loadLocalUserIdentity().name).toBe("Iris");
    expect(loadLocalAssistantIdentity().avatar).toBeNull();
  });
});
