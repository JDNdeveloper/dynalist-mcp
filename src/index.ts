#!/usr/bin/env bun
/**
 * Dynalist MCP Server
 *
 * A Model Context Protocol server for Dynalist.io
 * Allows AI assistants to read and write to your Dynalist outlines.
 *
 * Usage:
 *   DYNALIST_API_TOKEN=your_token bun src/index.ts
 *
 * Get your API token from: https://dynalist.io/developer
 */

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { DynalistClient } from "./dynalist-client";
import { AccessController } from "./access-control";
import { DocumentStore } from "./document-store";
import { log, setConfigLoader } from "./config";
import { createFileConfigLoader } from "./config-file";
import { createDynalistServer } from "./server";

setConfigLoader(createFileConfigLoader());

// Get API token from environment.
const API_TOKEN = process.env.DYNALIST_API_TOKEN;

if (!API_TOKEN) {
  console.error("Error: DYNALIST_API_TOKEN environment variable is required");
  console.error("Get your API token from: https://dynalist.io/developer");
  process.exit(1);
}

// Create Dynalist client.
const dynalistClient = new DynalistClient(API_TOKEN);

// Create MCP server with all tools registered.
const server = createDynalistServer({
  client: dynalistClient,
  ac: new AccessController(dynalistClient),
  store: new DocumentStore(dynalistClient),
});

// Start server with stdio transport.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("info", "Dynalist MCP server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
