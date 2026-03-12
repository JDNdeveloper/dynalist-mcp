/**
 * Tool registration aggregator.
 * Imports all tool modules and registers them with the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient } from "../dynalist-client";
import { AccessController } from "../access-control";
import { registerReadTools } from "./read";
import { registerWriteTools } from "./write";
import { registerStructureTools } from "./structure";
import { registerFileTools } from "./files";

/**
 * Register all Dynalist tools with the MCP server.
 */
export function registerTools(server: McpServer, client: DynalistClient): void {
  const ac = new AccessController(client);
  registerReadTools(server, client, ac);
  registerWriteTools(server, client, ac);
  registerStructureTools(server, client, ac);
  registerFileTools(server, client, ac);
}
