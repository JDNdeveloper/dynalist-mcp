/**
 * Shared MCP server factory. Both the stdio entry point and the
 * Cloudflare Worker build their servers here, so tool registration,
 * instructions, and server identity are identical across transports.
 */

import { McpServer } from "@modelcontextprotocol/server";
import type { DynalistClient } from "./dynalist-client";
import type { AccessController } from "./access-control";
import type { DocumentStore } from "./document-store";
import { registerTools } from "./tools/index";
import { SERVER_INSTRUCTIONS } from "./instructions";
import pkg from "../package.json";

/**
 * Long-lived state shared by every server built from it. The Worker
 * builds a fresh McpServer per request from one long-lived instance of
 * each, so caches and batch state persist across requests.
 */
export interface DynalistServerDependencies {
  client: DynalistClient;
  ac: AccessController;
  store: DocumentStore;
}

/**
 * Build an McpServer with the Dynalist identity, instructions, and all
 * tools registered.
 */
export function createDynalistServer({ client, ac, store }: DynalistServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: "dynalist-mcp",
      version: pkg.version,
      title: "Dynalist",
      description: "Read, write, search, and organize content in Dynalist documents.",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerTools(server, client, ac, store);
  return server;
}
