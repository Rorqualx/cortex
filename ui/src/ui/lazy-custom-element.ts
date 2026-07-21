type CustomElementModuleLoader = () => Promise<unknown>;

const pendingLoads = new Map<string, Promise<void>>();

/** Load a custom-element module once and verify that it registered its tag. */
export function ensureCustomElementDefined(
  tagName: string,
  loadModule: CustomElementModuleLoader,
): Promise<void> {
  if (customElements.get(tagName)) {
    return Promise.resolve();
  }
  const pending = pendingLoads.get(tagName);
  if (pending) {
    return pending;
  }
  const load = Promise.resolve()
    .then(loadModule)
    .then(() => {
      if (!customElements.get(tagName)) {
        throw new Error(`Custom element module did not define ${tagName}`);
      }
    })
    .finally(() => {
      pendingLoads.delete(tagName);
    });
  pendingLoads.set(tagName, load);
  return load;
}

export type OptionalCustomElement = {
  tagName: string;
  label: string;
  loadModule: () => Promise<unknown>;
};

type UpdatingHost = {
  requestUpdate: () => unknown;
};

// Note: upstream's COMMAND_PALETTE_ELEMENT and TERMINAL_PANEL_ELEMENT loaders
// are not carried in this fork — their element modules (components/command-palette,
// components/terminal/terminal-panel) are un-adopted upstream architecture and no
// fork code references those loaders.
export const BROWSER_PANEL_ELEMENT = {
  tagName: "openclaw-browser-panel",
  label: "browser panel",
  loadModule: () => import("./views/browser/browser-panel.ts"),
} satisfies OptionalCustomElement;

// Loaded only for approval document URLs: the approval page pulls the protocol
// validators (typebox runtime) and must stay out of the normal startup graph.
export const APPROVAL_PAGE_ELEMENT = {
  tagName: "openclaw-approval-page",
  label: "approval page",
  loadModule: () => import("./approval/approval-page-registration.ts"),
} satisfies OptionalCustomElement;

// The card is in the chat graph, but modal-only queue controls stay off the
// startup path until an approval is actually pending.
const EXEC_APPROVAL_TAG = "openclaw-exec-approval";

export const EXEC_APPROVAL_ELEMENT = {
  tagName: EXEC_APPROVAL_TAG,
  // This diagnostic uses the tag rather than user-facing copy.
  label: EXEC_APPROVAL_TAG,
  loadModule: () => import("./views/exec-approval.ts"),
} satisfies OptionalCustomElement;

const hostElementLoads = new WeakMap<UpdatingHost, Map<string, Promise<void>>>();

export function isOptionalElementDefined(element: OptionalCustomElement): boolean {
  return customElements.get(element.tagName) !== undefined;
}

export function ensureOptionalElementForHost(
  host: UpdatingHost,
  element: OptionalCustomElement,
): Promise<void> {
  if (isOptionalElementDefined(element)) {
    host.requestUpdate();
    return Promise.resolve();
  }
  const existingLoads = hostElementLoads.get(host);
  const loads = existingLoads ?? new Map<string, Promise<void>>();
  if (!existingLoads) {
    hostElementLoads.set(host, loads);
  }
  const pending = loads.get(element.tagName);
  if (pending) {
    return pending;
  }
  const load = ensureCustomElementDefined(element.tagName, element.loadModule)
    .then(() => {
      host.requestUpdate();
    })
    .catch((error: unknown) => {
      console.error(`[openclaw] failed to load ${element.label}`, error);
      throw error;
    })
    .finally(() => {
      loads.delete(element.tagName);
    });
  loads.set(element.tagName, load);
  return load;
}

export function preloadOptionalElement(host: UpdatingHost, element: OptionalCustomElement): void {
  if (isOptionalElementDefined(element)) {
    return;
  }
  void ensureOptionalElementForHost(host, element).catch(() => undefined);
}
