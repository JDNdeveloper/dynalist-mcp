#!/usr/bin/env node
/**
 * Dynalist MCP Server
 *
 * A Model Context Protocol server for Dynalist.io
 * Allows AI assistants to read and write to your Dynalist outlines.
 *
 * Usage:
 *   DYNALIST_API_TOKEN=your_token node dist/index.js
 *
 * Get your API token from: https://dynalist.io/developer
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DynalistClient } from "./dynalist-client.js";
import { registerTools } from "./tools/index.js";

// Get API token from environment
const API_TOKEN = process.env.DYNALIST_API_TOKEN;

if (!API_TOKEN) {
  console.error("Error: DYNALIST_API_TOKEN environment variable is required");
  console.error("Get your API token from: https://dynalist.io/developer");
  process.exit(1);
}

// Create Dynalist client
const dynalistClient = new DynalistClient(API_TOKEN);

// Create MCP server
const server = new McpServer({
  name: "dynalist-mcp",
  version: "1.0.0",
});

// Register all tools
registerTools(server, dynalistClient);

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with MCP protocol
  console.error("Dynalist MCP server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
