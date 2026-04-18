/**
 * Tool registration aggregator.
 * Imports all tool modules and registers them with the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient } from "../dynalist-client";
import { DocumentStore } from "../document-store";
import { AccessController } from "../access-control";
import { registerReadTools } from "./read";
import { registerWriteTools } from "./write";
import { registerStructureTools } from "./structure";
import { registerFileTools } from "./files";
import { registerMetaTools } from "./meta";

/**
 * Register all Dynalist tools with the MCP server.
 */
export function registerTools(server: McpServer, client: DynalistClient): void {
  const ac = new AccessController(client);
  const store = new DocumentStore(client);
  registerMetaTools(server);
  registerReadTools(server, client, ac, store);
  registerWriteTools(server, client, ac, store);
  registerStructureTools(server, client, ac, store);
  registerFileTools(server, client, ac);
}
