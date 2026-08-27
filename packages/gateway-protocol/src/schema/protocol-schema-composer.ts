import type { TSchema } from "typebox";

type ProtocolSchemaFragment = Readonly<Record<string, TSchema>>;
type UnionToIntersection<Value> = (Value extends unknown ? (value: Value) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

/**
 * Named alias for the composed registry type. Fork note (2026-08-26 upstream
 * resync): the cortex fork registers extra fragments (board, progress-card,
 * fork plugin-approval events, portals) upstream does not ship, and upstream's
 * approval-scope additions pushed the inferred `ProtocolSchemas` const over the
 * dts serializer's size limit (TS7056, build-red/tsgo-green). Declaring the
 * composed type through this named alias lets the .d.ts emit reference it by
 * name instead of inlining the full structural intersection.
 */
export type ComposedProtocolSchemas<Fragments extends readonly ProtocolSchemaFragment[]> =
  UnionToIntersection<Fragments[number]>;

/** Compose explicitly ordered owner fragments without replacing their schema objects. */
export function composeProtocolSchemaFragments<
  const Fragments extends readonly ProtocolSchemaFragment[],
>(fragments: Fragments): ComposedProtocolSchemas<Fragments> {
  const registry: Record<string, TSchema> = {};
  for (const fragment of fragments) {
    for (const [key, schema] of Object.entries(fragment)) {
      if (Object.hasOwn(registry, key)) {
        throw new Error(`Duplicate protocol schema key: ${key}`);
      }
      registry[key] = schema;
    }
  }
  return registry as ComposedProtocolSchemas<Fragments>;
}
