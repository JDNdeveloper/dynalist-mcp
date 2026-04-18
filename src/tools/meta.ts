/**
 * Meta tools: get_instructions.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeResponse, wrapToolHandler } from "../utils/dynalist-helpers";
import { INSTRUCTIONS } from "../instructions";

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    "get_instructions",
    {
      description:
        "Get additional instructions for working with this MCP server. " +
        "You MUST call this before using any other tools.",
      inputSchema: {},
      outputSchema: {
        instructions: z.string().describe("Full MCP server instructions."),
      },
    },
    wrapToolHandler(async () => {
      return makeResponse({ instructions: INSTRUCTIONS });
    })
  );
}
