import { ContextProvider } from "@lit/context";
import type { RouteId } from "../ui/app-route-paths.ts";
import { applicationContext, type ApplicationContext } from "../ui/app-context.ts";

export function createApplicationContextProvider(context: ApplicationContext<RouteId>) {
  const host = document.createElement("div");
  const provider = new ContextProvider(host, {
    context: applicationContext,
    initialValue: context,
  });
  return Object.assign(host, {
    setContext: (value: ApplicationContext<RouteId>) => provider.setValue(value),
  });
}

export type ApplicationContextProvider = ReturnType<typeof createApplicationContextProvider>;
