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

## Node content

Node text is short -- typically one sentence, occasionally a few. Nodes are generally single-line, \
though multiline text is technically supported. Longer content spanning multiple lines or paragraphs \
belongs in the node's note field, not the text field.

Node text supports a subset of Markdown for inline formatting:
- **Bold**: \`**bold**\`
- **Italic**: \`__italic__\` (note: single underscores and single asterisks do NOT work)
- **Inline code**: \`\\\`code\\\`\`
- **Strikethrough**: \`~~strikethrough~~\`
- **Link**: \`[label](url)\` (bare URLs with a protocol are also auto-linked)
- **Image link**: \`![alt](url)\` (renders a hover preview in the Dynalist UI)
- **LaTeX**: \`$equation$\` (rendered via KaTeX)
- **Code block**: triple-backtick fenced code blocks (usually used in notes rather than node text)

Nodes also support two non-text metadata properties:
- **Heading level**: 0 = none, 1 = H1, 2 = H2, 3 = H3.
- **Color label**: 0 = none, 1 = red, 2 = orange, 3 = yellow, 4 = green, 5 = blue, 6 = purple.


## Size warnings

Read and search tools may return a warning instead of content when results exceed a token \
threshold. This is deliberate, not an error. Retry the same request with bypass_warning: \
true to get the actual content. bypass_warning should never be set on the first request.

## Compositional patterns

- Parent chain / hierarchy: there is no "get ancestors" tool. The best way to find a \
node's ancestors is search_in_document with the node's text (or a unique substring) and \
parent_levels set to the desired depth. Each match includes a parents array with the \
ancestor chain, so a single call gives you the breadcrumb context. If the node's text is \
not unique or not known, fall back to calling read_document with just the file_id (omit \
node_id) and searching the returned tree for the target node_id. Use max_depth to limit \
output.
- Sibling context: to see a node's siblings, call read_document with the parent's node_id \
and max_depth: 1.
- Expanding collapsed sections: if a node has collapsed: true and children_count > 0 but \
empty children, either pass the node's node_id directly to read_document (the starting node \
always expands, so no extra flags needed) or re-request with include_collapsed_children: true \
to expand all collapsed nodes in the response.
- Drilling into depth-limited nodes: if a node has depth_limited: true, call read_document \
with that node's node_id as the starting point. This zooms into the subtree using the same \
max_depth budget.
- File organization: use list_documents to see the folder hierarchy, then use \
create_document, create_folder, move_document, move_folder, rename_document, and rename_folder \
to organize the file tree.
- File vs node management: tools like create_document, rename_folder, and move_document \
operate on the file tree. Tools like insert_nodes, edit_nodes, and move_node operate on \
nodes within a single document. Do not confuse file IDs with node IDs.

## Presenting document content

When showing document content to the user, render nodes as indented bullet points to mirror \
Dynalist's visual structure. Use exactly 4 spaces per indentation level. Show checked/completed \
items with strikethrough (e.g. ~~Buy groceries~~). Example:

\`\`\`
- Project plan
    - Phase 1
        - Design mockups
        - ~~User research~~
    - Phase 2
        - Implementation
\`\`\`

This applies when summarizing a document, showing what was read, previewing changes before a \
mutation, or confirming what was changed after a mutation.

**IMPORTANT: Indentation consistency is critical.** Sibling nodes must always be at the exact \
same indentation level. Every child level adds exactly 4 spaces. Misaligned indentation is \
the single most common rendering mistake. Before outputting node trees, verify that siblings \
share the same indent and children are exactly 4 spaces deeper than their parent.

When presenting a mutation preview or confirmation, use a diff-style format inside a fenced \
code block. Prefix each line with \`+\` for additions, \`-\` for deletions, or a space for \
unchanged context. The prefix is a fixed 2-character column (\`- \`, \`+ \`, or two spaces) \
that precedes the node's normal tree indentation. Do not let the prefix displace or alter the \
node indentation. Show edits as a \`-\`/\`+\` pair (delete the old value, add the new one). \
Only include enough unchanged nodes to show where the changes sit (typically the immediate \
parent and siblings). Use \`...\` at the same indentation level to indicate omitted siblings \
before or after the shown nodes. Indentation is relative to the topmost node shown, so the \
first node always starts at the root indent level. Example:

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

Write tools (\`edit_nodes\`, \`insert_nodes\`, \`delete_node\`, \`move_node\`) accept an optional \
\`expected_version\` parameter. Pass the \`version\` from your most recent \`read_document\` \
response. If the document has been modified since that read, the tool will abort with a \
\`VersionMismatch\` error and ask you to re-read.

If a write tool returns a \`version_warning\` field, another edit may have occurred concurrently \
during the write. Re-read the document and verify the changes before making further edits.

## Confirmation and verification

Before calling any mutating tool (insert, edit, delete, move, rename, create, send_to_inbox), \
describe the intended changes to the user and wait for confirmation. Do not modify Dynalist \
data without the user's explicit approval.

After a mutation, read back the affected document or node to verify the changes were applied \
correctly. Report any discrepancies to the user.
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
