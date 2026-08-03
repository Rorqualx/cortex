/**
 * Schema Flattener — converts JSON-Schema tool descriptions into plain text.
 *
 * Research finding (Finding 8, 2026-08-03): schema-formatted specs weaken
 * model refusal signals. Presenting a tool's capabilities as plain text
 * instead of nested JSON-Schema helps models reason about what the tool
 * actually does, improving refusal of unsafe requests.
 *
 * The flattener is a pure function with no side effects. It walks the
 * standard JSON-Schema properties produced by Typebox (`Type.Object(...)`)
 * and emits a single-line description like:
 *
 *   "Tool: delegate_code. Description: Delegate code generation.
 *    Parameters: task (string, required), context (array of string,
 *    optional), provider (string, optional)."
 */

/** A tool definition suitable for flattening. */
export interface FlatToolSpec {
  name: string;
  description: string;
  /** JSON-Schema object (the `Type.Object(...)` value). */
  schema: unknown;
}

/** Result of flattening a tool spec. */
export interface FlattenedTool {
  /** Compact single-line text: "Tool: X. Description: Y. Parameters: ..." */
  text: string;
  /** Just the parameters portion: "task (string, required), ..." */
  paramsText: string;
}

/**
 * Walk a JSON-Schema fragment and return a human-readable type string.
 * Handles the subset Typebox emits: string, number, integer, boolean,
 * array (with items), and object (recurses one level).
 */
function describeType(schema: Record<string, unknown>): string {
  if (typeof schema !== "object" || schema === null) return "any";

  const type = schema["type"];

  // Handle union types (anyOf / oneOf)
  const union = schema["anyOf"] ?? schema["oneOf"];
  if (Array.isArray(union)) {
    return union.map((t) => describeType(t as Record<string, unknown>)).join(" | ");
  }

  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array": {
      const items = schema["items"];
      const itemType =
        items && typeof items === "object" ? describeType(items as Record<string, unknown>) : "any";
      return `array of ${itemType}`;
    }
    case "object":
      return "object";
    default:
      return typeof type === "string" ? type : "any";
  }
}

/**
 * Check whether a parameter name is in the `required` array of a JSON-Schema.
 */
function isRequired(schema: Record<string, unknown>, paramName: string): boolean {
  const required = schema["required"];
  return Array.isArray(required) && required.includes(paramName);
}

/**
 * Flatten a single parameter from its JSON-Schema fragment.
 * Output: "paramName (type, required)" or "paramName (type, optional)".
 */
function flattenParam(
  name: string,
  propSchema: Record<string, unknown>,
  parentSchema: Record<string, unknown>,
): string {
  const typeStr = describeType(propSchema);
  const req = isRequired(parentSchema, name) ? "required" : "optional";
  return `${name} (${typeStr}, ${req})`;
}

/**
 * Flatten a complete tool spec into a compact plain-text description.
 *
 * Strips all JSON-Schema nesting and produces a flat, human-readable string
 * that a model can parse as natural language — no brackets, no nesting,
 * no structural ambiguity.
 */
export function flattenToolSpec(spec: FlatToolSpec): FlattenedTool {
  const schema = spec.schema as Record<string, unknown>;
  const props = schema?.["properties"];
  const params: string[] = [];

  if (props && typeof props === "object") {
    for (const [name, propSchema] of Object.entries(props)) {
      params.push(flattenParam(name, propSchema as Record<string, unknown>, schema));
    }
  }

  const paramsText = params.length > 0 ? params.join(", ") : "(none)";
  const text = `Tool: ${spec.name}. Description: ${spec.description} Parameters: ${paramsText}.`;

  return { text, paramsText };
}

/**
 * Batch-flatten multiple tool specs into a single text block.
 * Each tool appears on its own line. Useful for presenting the full
 * delegation catalog to a safety judge in one call.
 */
export function flattenToolSpecs(specs: FlatToolSpec[]): string {
  return specs.map((s) => flattenToolSpec(s).text).join("\n");
}
