import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolRegistry, type ToolDefinition } from "./registry";
import { createToolSearchTool } from "./tool-search";

test("createToolSearchTool returns matching tool definitions without execute handlers", async () => {
  const registry = new ToolRegistry();
  const deferredTool: ToolDefinition = {
    name: "mcp__github__list_issues",
    description: "[MCP:github] List issues",
    parameters: {
      type: "object",
      properties: { state: { type: "string" } },
    },
    shouldDefer: true,
    execute: async () => "unused",
  };

  registry.register(deferredTool);

  const toolSearch = createToolSearchTool(registry);
  const result = await toolSearch.execute({
    query: "mcp__github__list_issues",
  });

  assert.deepEqual(result, [
    {
      name: "mcp__github__list_issues",
      description: "[MCP:github] List issues",
      parameters: {
        type: "object",
        properties: { state: { type: "string" } },
      },
    },
  ]);
});
