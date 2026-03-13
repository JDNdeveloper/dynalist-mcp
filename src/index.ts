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

// Server instructions injected into the LLM system prompt by MCP clients.
const INSTRUCTIONS = `\
Dynalist is an outliner for organizing information as nested bullet-point lists. \
Content is organized at two levels:

1. File tree (folders and documents): A tree of folders and documents, like a filesystem. \
Folders contain other folders and documents. Documents hold actual content.
2. Item tree (nodes within a document): Each document contains a tree of items ("nodes" \
in the API). Each node has text content, an optional note, and can have children nested \
beneath it. Each document has a single root node whose children are the top-level visible items.

## Identifiers

Three entity types:
- Folders: file ID (e.g. "abc123def456"). Organize documents but hold no content.
- Documents: file ID (same format). Hold node trees.
- Nodes (items): node ID (e.g. "a1b2c3d4e5f6"). Meaningful only within its parent document.

## URL format

- Document: https://dynalist.io/d/{fileId}
- Specific node (deep link): https://dynalist.io/d/{fileId}#z={nodeId}
- No URL for folders.
- Tools accept file_id and node_id, not URLs. Extract file_id from the /d/ path segment \
and node_id from the #z= fragment.

## Node content

Node text is short, typically one sentence. Multiline is supported but longer content \
belongs in the note field.

Node text supports a subset of Markdown for inline formatting:
- **Bold**: \`**bold**\`
- **Italic**: \`__italic__\` (single underscores/asterisks do NOT work)
- **Inline code**: \`\\\`code\\\`\`
- **Strikethrough**: \`~~strikethrough~~\`
- **Link**: \`[label](url)\` (bare URLs auto-link)
- **Image link**: \`![alt](url)\` (hover preview in UI)
- **LaTeX**: \`$equation$\` (rendered via KaTeX)
- **Code block**: triple-backtick fenced code blocks (mainly for notes)

Two non-text metadata properties:
- **Heading level**: 0 = none, 1 = H1, 2 = H2, 3 = H3.
- **Color label**: 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple.

## Size warnings

Read and search tools may return a size warning instead of content. This is not an error. \
Retry with bypass_warning: true to get actual content. Never set bypass_warning on the \
first request.

## Compositional patterns

- Parent chain / hierarchy: no ancestors tool. Use search_in_document with the node's text \
(or a unique substring) and parent_levels set to the desired depth. Each match includes a \
parents array for breadcrumb context. Fallback: read_document with just file_id, then search \
the tree for the target node_id. Use max_depth to limit output.
- Sibling context: call read_document with the parent's node_id and max_depth: 1.
- Expanding collapsed sections: if a node has collapsed: true and children_count > 0 but \
empty children, pass the node's node_id to read_document (the starting node always expands) \
or re-request with include_collapsed_children: true.
- Drilling into depth-limited nodes: if a node has depth_limited: true, call read_document \
with that node's node_id to zoom into the subtree.
- File organization: list_documents shows the folder hierarchy. Use create_*, move_*, \
rename_* tools to organize.
- File vs node management: file tools (create_document, move_document, etc.) operate on \
the file tree. Node tools (insert_nodes, edit_nodes, etc.) operate within a document. \
Do not confuse file IDs with node IDs.

## Partial inserts

Large tree inserts are batched by depth level. If a batch fails mid-way, some nodes \
may have been created but not all. The error response includes inserted_count, total_count, \
and first_node_id so you can inspect or clean up partial results.

## API limitations

- Cross-document moves: use the Dynalist web or mobile client to preserve smart links. \
Do not attempt a read-insert-delete workaround.
- Collapsed state: the API cannot change a node's collapsed state. The edit action silently \
ignores the collapsed field.
- Document and folder deletion: the API does not support deleting documents or folders. \
Use the Dynalist web or mobile UI.

## Presenting document content

Render document content as indented bullet points mirroring Dynalist's structure. Use exactly \
4 spaces per indentation level. Show checked items with strikethrough (~~Buy groceries~~). Example:

\`\`\`
- Project plan
    - Phase 1
        - Design mockups
        - ~~User research~~
    - Phase 2
        - Implementation
\`\`\`

Applies to summaries, read results, mutation previews, and confirmations.

**IMPORTANT: Indentation consistency is critical.** Siblings must share the same indent. \
Every child level adds exactly 4 spaces. Misaligned indentation is the most common mistake. \
Verify alignment before outputting.

For mutation previews/confirmations, use diff-style in a fenced code block. Prefix each line \
with \`+\` for additions, \`-\` for deletions, or a space for unchanged context. The prefix \
is a fixed 2-char column preceding the node's tree indentation. Do not let the prefix alter \
node indentation. Show edits as a \`-\`/\`+\` pair. Include only enough context to show where \
changes sit (parent and siblings). Use \`...\` at the same indent to indicate omitted siblings. \
Indentation is relative to the topmost shown node. Example:

\`\`\`
  - Grocery list
      ...
-     - Milk 2%
+     - Milk
+     - Eggs
-     - Butter
      - Bread
      ...
\`\`\`

## Version tracking

Call read_document before any write tool to obtain the document version.

If a write tool returns version_warning, a concurrent edit may have occurred. Re-read and \
verify before further edits.

## Confirmation and verification

Before any mutation, describe intended changes and wait for user confirmation.

After a mutation, read back the affected area to verify. Report any discrepancies to the user.
`;

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
