/**
 * Meta tools: get_instructions.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { makeResponse, wrapToolHandler } from "../utils/dynalist-helpers";
import { INSTRUCTIONS } from "../instructions";

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    "get_instructions",
    {
      description:
        "Get additional instructions for working with this MCP server. " +
        "You MUST call this before using any other tools.",
      annotations: {
        title: "Get Instructions",
        readOnlyHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        instructions: z.string().describe("Full MCP server instructions."),
      }).strict(),
    },
    wrapToolHandler(async () => {
      return makeResponse({ instructions: INSTRUCTIONS });
    })
  );
}
