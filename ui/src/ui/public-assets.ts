// Control UI module implements public assets behavior.
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-contract.js";
import { inferBasePathFromPathname, normalizeBasePath } from "./navigation.ts";

export type ControlUiPublicAsset =
  | "apple-touch-icon.png"
  | "favicon-32.png"
  | "favicon.ico"
  | "favicon.svg"
  | "manifest.webmanifest"
  | "sw.js"
  | `provider-icons/ProviderIcon-${string}.svg`
  | `plugin-art/${string}.webp`
  | `app-art/${string}.webp`;

type WindowWithControlUiBasePath = Window &
  typeof globalThis & {
    [key: string]: unknown;
  };

export function resolveControlUiBasePath(pathname: string): string {
  if (typeof window !== "undefined") {
    const windowValue = (window as WindowWithControlUiBasePath)[
      "__OPENCLAW_CONTROL_UI_BASE_PATH__"
    ];
    if (typeof windowValue === "string") {
      return normalizeBasePath(windowValue);
    }
  }
  if (typeof document !== "undefined") {
    const documentValue = document.documentElement.getAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
    if (documentValue !== null) {
      return normalizeBasePath(documentValue);
    }
  }
  return inferBasePathFromPathname(pathname);
}

export function controlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  basePath: string | null | undefined,
): string {
  const base = normalizeBasePath(basePath ?? "");
  return base ? `${base}/${asset}` : `/${asset}`;
}

export function inferControlUiPublicAssetPath(
  asset: ControlUiPublicAsset,
  params?: {
    basePath?: string | null;
    pathname?: string;
  },
): string {
  const basePath =
    params?.basePath ??
    (params?.pathname === undefined
      ? resolveControlUiBasePath(currentPathname())
      : inferBasePathFromPathname(params.pathname));
  return controlUiPublicAssetPath(asset, basePath);
}

function currentPathname(): string {
  if (typeof window === "undefined") {
    return "/";
  }
  return window.location.pathname;
}
