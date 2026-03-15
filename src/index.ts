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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DynalistClient } from "./dynalist-client";
import { log } from "./config";
import { registerTools } from "./tools/index";
import { INSTRUCTIONS } from "./instructions";
import pkg from "../package.json";

// Get API token from environment.
const API_TOKEN = process.env.DYNALIST_API_TOKEN;

if (!API_TOKEN) {
  console.error("Error: DYNALIST_API_TOKEN environment variable is required");
  console.error("Get your API token from: https://dynalist.io/developer");
  process.exit(1);
}

// Create Dynalist client.
const dynalistClient = new DynalistClient(API_TOKEN);

// Create MCP server.
const server = new McpServer(
  {
    name: "dynalist-mcp",
    version: pkg.version,
    title: "Dynalist",
    description: "Read, write, search, and organize content in Dynalist documents.",
  },
  {
    instructions: INSTRUCTIONS,
  },
);

// Register all tools.
registerTools(server, dynalistClient);

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
