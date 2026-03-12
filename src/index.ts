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
import { registerTools } from "./tools/index";
import { CHECKED_GUIDANCE, CHECKBOX_GUIDANCE } from "./tools/descriptions";
import pkg from "../package.json";

// Get API token from environment
const API_TOKEN = process.env.DYNALIST_API_TOKEN;

if (!API_TOKEN) {
  console.error("Error: DYNALIST_API_TOKEN environment variable is required");
  console.error("Get your API token from: https://dynalist.io/developer");
  process.exit(1);
}

// Create Dynalist client
const dynalistClient = new DynalistClient(API_TOKEN);

// Server instructions injected into the LLM system prompt by MCP clients.
const INSTRUCTIONS = `\
Dynalist is an outliner application, a tool for organizing information as nested, \
hierarchical bullet-point lists. Content is organized at two levels:

1. File tree (folders and documents): The top level is a tree of folders and documents, \
similar to a filesystem. Folders contain other folders and documents. Documents are the \
leaf containers that hold actual content.
2. Item tree (nodes within a document): Each document contains a tree of items (called \
"nodes" in the API). Every node has text content, an optional note, and can have child \
nodes nested beneath it, forming an arbitrarily deep hierarchy. Each document has a single \
root node whose children are the top-level items visible in the document.

## Identifiers

There are three entity types, each with its own ID:
- Folders: identified by a file ID (e.g. "abc123def456"). Folders organize documents but \
contain no content of their own.
- Documents: identified by a file ID (same format as folders). Documents hold node trees.
- Nodes (items): identified by a node ID (e.g. "a1b2c3d4e5f6"). Nodes exist within a \
specific document. A node ID is only meaningful in the context of its parent document.

## URL format

- Document: https://dynalist.io/d/{fileId}
- Specific node (deep link): https://dynalist.io/d/{fileId}#z={nodeId}
- There is no URL format for folders.
- Tools accept file_id and node_id parameters directly, not URLs. If the user provides a \
Dynalist URL, extract the file_id from the path segment after /d/ and the node_id from \
the #z= fragment (if present).

## Controlling output size (read_document)

read_document has two independent mechanisms for controlling output size:
1. max_depth (default 5): limits how many levels deep the tree is traversed. Set to null \
for unlimited depth.
2. include_collapsed_children (default false): controls whether children of collapsed nodes \
are included. When false, collapsed nodes show children_count but children is empty.

These are independent and both apply simultaneously. Setting a high max_depth does NOT \
expand collapsed nodes. Setting include_collapsed_children: true does NOT bypass the depth \
limit.

When children are hidden, two distinct signals indicate the cause (do not confuse these):
- depth_limited: true means the max_depth limit cut off traversal. The node is NOT \
collapsed. Fix: call read_document with this node's node_id as the starting point to zoom \
into the subtree without re-fetching the entire document.
- collapsed: true with children_count > 0 but empty children means the user collapsed this \
node in the Dynalist UI. Fix: re-request with include_collapsed_children: true.

## Size warnings

Read and search tools may return a warning instead of content when results exceed a token \
threshold. This is deliberate, not an error. Retry the same request with bypass_warning: \
true to get the actual content. bypass_warning should never be set on the first request.

## Compositional patterns

- Parent chain / hierarchy: there is no "get ancestors" tool. To see where a node sits in \
the document tree, call read_document with just the file_id (omit node_id) and search the \
returned tree for the target node_id. Use max_depth to limit output.
- Breadcrumb context: search_in_document returns parents for each match, which gives the \
ancestor chain without a separate read.
- Sibling context: to see a node's siblings, call read_document with the parent's node_id \
and max_depth: 1.
- Expanding collapsed sections: if a node has collapsed: true and children_count > 0 but \
empty children, re-request with include_collapsed_children: true (optionally scoped to the \
specific node via node_id).
- Drilling into depth-limited nodes: if a node has depth_limited: true, call read_document \
with that node's node_id as the starting point. This zooms into the subtree using the same \
max_depth budget.
- File organization: use list_documents to see the folder hierarchy, then use \
create_document, create_folder, move_file, rename_document, and rename_folder to organize \
the file tree.

## Tool behavior notes

- Bulk insert: insert_nodes should be preferred over insert_node for anything beyond a \
single flat node. It parses indented markdown and creates the full hierarchy in batch.
- Delete behavior: delete_node promotes children up to the parent by default (the node is \
removed but its children survive). Use include_children: true to delete the entire subtree.
- Move: move_node uses relative positioning. Specify a reference node and a position \
(after, before, first_child, last_child).
- Inbox target: send_to_inbox sends to whatever document the user configured as their \
inbox in Dynalist settings. For inserting into a specific document, use insert_node or \
insert_nodes.
- File vs node management: tools like create_document, rename_folder, and move_file \
operate on the file tree. Tools like insert_node, edit_node, and move_node operate on \
nodes within a single document. Do not confuse file IDs with node IDs.
- Version checking: use check_document_versions to check if documents have changed before \
doing expensive reads.
- edit_node: omitted fields are left unchanged, not reset to defaults.
- Checking items off: to mark an item as completed, set checked: true. ${CHECKED_GUIDANCE}
- Checkbox usage: ${CHECKBOX_GUIDANCE}
`;

// Create MCP server
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

// Register all tools
registerTools(server, dynalistClient);

// Start server with stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't interfere with MCP protocol.
  console.error("Dynalist MCP server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
