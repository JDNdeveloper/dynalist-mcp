/**
 * Tool registration aggregator.
 * Imports all tool modules and registers them with the MCP server.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { DynalistClient } from "../dynalist-client";
import type { DocumentStore } from "../document-store";
import type { AccessController } from "../access-control";
import { registerReadTools } from "./read";
import { registerWriteTools } from "./write";
import { registerStructureTools } from "./structure";
import { registerFileTools } from "./files";
import { registerMetaTools } from "./meta";

/**
 * Register all Dynalist tools with the MCP server. The access controller
 * and document store are passed in so callers can share them across
 * several servers.
 */
export function registerTools(
  server: McpServer,
  client: DynalistClient,
  ac: AccessController,
  store: DocumentStore,
): void {
  registerMetaTools(server);
  registerReadTools(server, client, ac, store);
  registerWriteTools(server, client, ac, store);
  registerStructureTools(server, client, ac, store);
  registerFileTools(server, client, ac);
}
