import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { flattenToolSpec, flattenToolSpecs, type FlatToolSpec } from "./schema-flattener.js";

describe("flattenToolSpec", () => {
  it("flattens a simple tool schema with one required parameter", () => {
    const spec: FlatToolSpec = {
      name: "delegate_code",
      description: "Delegate code generation.",
      schema: Type.Object({
        task: Type.String({ description: "The instruction / prompt." }),
      }),
    };
    const result = flattenToolSpec(spec);
    expect(result.text).toBe(
      "Tool: delegate_code. Description: Delegate code generation. Parameters: task (string, required).",
    );
    expect(result.paramsText).toBe("task (string, required)");
  });

  it("flattens required + optional parameters", () => {
    const spec: FlatToolSpec = {
      name: "delegate_vision",
      description: "Analyze image(s) and answer the task.",
      schema: Type.Object({
        task: Type.String({ description: "The task." }),
        images: Type.Optional(
          Type.Array(Type.String(), { description: "Image URLs or data-URLs to analyze." }),
        ),
        provider: Type.Optional(Type.String({ description: "Provider override." })),
      }),
    };
    const result = flattenToolSpec(spec);
    expect(result.paramsText).toContain("task (string, required)");
    expect(result.paramsText).toContain("images (array of string, optional)");
    expect(result.paramsText).toContain("provider (string, optional)");
  });

  it("handles array of string types", () => {
    const spec: FlatToolSpec = {
      name: "test_tool",
      description: "Test.",
      schema: Type.Object({
        context: Type.Optional(Type.Array(Type.String())),
      }),
    };
    const result = flattenToolSpec(spec);
    expect(result.paramsText).toContain("context (array of string, optional)");
  });

  it("handles number and boolean types", () => {
    const spec: FlatToolSpec = {
      name: "test_tool",
      description: "Test.",
      schema: Type.Object({
        count: Type.Number(),
        flag: Type.Boolean(),
      }),
    };
    const result = flattenToolSpec(spec);
    expect(result.paramsText).toContain("count (number, required)");
    expect(result.paramsText).toContain("flag (boolean, required)");
  });

  it("handles empty parameters", () => {
    const spec: FlatToolSpec = {
      name: "no_params_tool",
      description: "No parameters.",
      schema: Type.Object({}),
    };
    const result = flattenToolSpec(spec);
    expect(result.paramsText).toBe("(none)");
    expect(result.text).toContain("Parameters: (none).");
  });

  it("produces well-formed full text", () => {
    const spec: FlatToolSpec = {
      name: "delegate_research",
      description: "Read-and-synthesize-with-citations.",
      schema: Type.Object({
        task: Type.String({ description: "The instruction." }),
        context: Type.Optional(Type.Array(Type.String())),
      }),
    };
    const result = flattenToolSpec(spec);
    expect(result.text).toMatch(/^Tool: delegate_research\./);
    expect(result.text).toMatch(/Description: Read-and-synthesize/);
    expect(result.text).toMatch(
      /Parameters: task \(string, required\), context \(array of string, optional\)\.$/,
    );
  });

  it("handles unknown types gracefully", () => {
    const spec: FlatToolSpec = {
      name: "test_tool",
      description: "Test.",
      schema: {
        type: "object",
        properties: {
          weird: { type: "custom_type" as unknown as string },
        },
        required: ["weird"],
      },
    };
    const result = flattenToolSpec(spec);
    expect(result.paramsText).toContain("weird (custom_type, required)");
  });
});

describe("flattenToolSpecs (batch)", () => {
  it("joins multiple tool specs with newlines", () => {
    const specs: FlatToolSpec[] = [
      {
        name: "tool_a",
        description: "First tool.",
        schema: Type.Object({ task: Type.String() }),
      },
      {
        name: "tool_b",
        description: "Second tool.",
        schema: Type.Object({ query: Type.String() }),
      },
    ];
    const text = flattenToolSpecs(specs);
    expect(text).toContain("Tool: tool_a.");
    expect(text).toContain("Tool: tool_b.");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("handles empty array", () => {
    expect(flattenToolSpecs([])).toBe("");
  });
});
