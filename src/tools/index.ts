/**
 * Tool registration aggregator.
 * Imports all tool modules and registers them with the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient } from "../dynalist-client";
import { registerReadTools } from "./read";
import { registerWriteTools } from "./write";
import { registerStructureTools } from "./structure";
import { registerFileTools } from "./files";

/**
 * Register all Dynalist tools with the MCP server.
 */
export function registerTools(server: McpServer, client: DynalistClient): void {
  registerReadTools(server, client);
  registerWriteTools(server, client);
  registerStructureTools(server, client);
  registerFileTools(server, client);
}
