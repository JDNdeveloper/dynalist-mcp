/**
 * Dynalist MCP Tools
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, buildNodeMap, findRootNodeId, findNodeParent } from "../dynalist-client.js";
import { parseDynalistUrl, buildDynalistUrl } from "../utils/url-parser.js";
import { nodeToMarkdown, documentToMarkdown } from "../utils/node-to-markdown.js";
import { parseMarkdownBullets, groupByLevel } from "../utils/markdown-parser.js";

/**
 * Register all Dynalist tools with the MCP server
 */
export function registerTools(server: McpServer, client: DynalistClient): void {
  // ═══════════════════════════════════════════════════════════════════
  // TOOL: list_documents
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "list_documents",
    "List all documents and folders in your Dynalist account",
    {},
    async () => {
      const response = await client.listFiles();

      const documents = response.files
        .filter((f) => f.type === "document")
        .map((f) => ({
          id: f.id,
          title: f.title,
          url: buildDynalistUrl(f.id),
          permission: getPermissionLabel(f.permission),
        }));

      const folders = response.files
        .filter((f) => f.type === "folder")
        .map((f) => ({
          id: f.id,
          title: f.title,
          children: f.children,
        }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ documents, folders, root_file_id: response.root_file_id }, null, 2),
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: read_node_as_markdown ⭐ PRINCIPAL
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "read_node_as_markdown",
    "Read a Dynalist document or specific node and return it as Markdown. Provide either a URL (with optional #z=nodeId deep link) or file_id + node_id.",
    {
      url: z.string().optional().describe("Dynalist URL (e.g., https://dynalist.io/d/xxx#z=yyy)"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      node_id: z.string().optional().describe("Node ID to start from (optional, reads entire doc if not provided)"),
      max_depth: z.number().optional().describe("Maximum depth to traverse (optional, unlimited if not set)"),
      include_notes: z.boolean().optional().default(true).describe("Include notes as sub-bullets"),
      include_checked: z.boolean().optional().default(true).describe("Include checked/completed items"),
    },
    async ({ url, file_id, node_id, max_depth, include_notes, include_checked }) => {
      // Parse URL if provided
      let documentId = file_id;
      let nodeId = node_id;

      if (url) {
        const parsed = parseDynalistUrl(url);
        documentId = parsed.documentId;
        nodeId = nodeId || parsed.nodeId;
      }

      if (!documentId) {
        return {
          content: [{ type: "text", text: "Error: Either 'url' or 'file_id' must be provided" }],
          isError: true,
        };
      }

      // Fetch document
      const doc = await client.readDocument(documentId);
      const nodeMap = buildNodeMap(doc.nodes);

      const options = {
        maxDepth: max_depth,
        includeNotes: include_notes,
        includeChecked: include_checked,
      };

      let markdown: string;
      let targetNode: string | undefined;

      if (nodeId) {
        // Render from specific node
        if (!nodeMap.has(nodeId)) {
          return {
            content: [{ type: "text", text: `Error: Node '${nodeId}' not found in document` }],
            isError: true,
          };
        }
        markdown = nodeToMarkdown(doc.nodes, nodeId, options);
        targetNode = nodeId;
      } else {
        // Render entire document
        markdown = documentToMarkdown(doc.nodes, options);
        targetNode = findRootNodeId(doc.nodes);
      }

      return {
        content: [
          {
            type: "text",
            text: markdown.trim(),
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: send_to_inbox
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "send_to_inbox",
    "Send a new item to your Dynalist inbox",
    {
      content: z.string().describe("The text content of the item"),
      note: z.string().optional().describe("Optional note for the item"),
      checkbox: z.boolean().optional().default(false).describe("Whether to add a checkbox"),
      checked: z.boolean().optional().default(false).describe("Whether the checkbox is checked"),
    },
    async ({ content, note, checkbox, checked }) => {
      const response = await client.sendToInbox({
        content,
        note,
        checkbox,
        checked,
      });

      return {
        content: [
          {
            type: "text",
            text: `Item added to inbox successfully!\nDocument: ${response.file_id}\nNode ID: ${response.node_id}\nPosition: ${response.index}`,
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: edit_node
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "edit_node",
    "Edit an existing node in a Dynalist document",
    {
      url: z.string().optional().describe("Dynalist URL with node deep link"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      node_id: z.string().describe("Node ID to edit"),
      content: z.string().optional().describe("New content text"),
      note: z.string().optional().describe("New note text"),
      checked: z.boolean().optional().describe("Checked status"),
      checkbox: z.boolean().optional().describe("Whether to show checkbox"),
      heading: z.number().min(0).max(3).optional().describe("Heading level (0-3)"),
      color: z.number().min(0).max(6).optional().describe("Color label (0-6)"),
    },
    async ({ url, file_id, node_id, content, note, checked, checkbox, heading, color }) => {
      let documentId = file_id;

      if (url) {
        const parsed = parseDynalistUrl(url);
        documentId = parsed.documentId;
      }

      if (!documentId) {
        return {
          content: [{ type: "text", text: "Error: Either 'url' or 'file_id' must be provided" }],
          isError: true,
        };
      }

      const change: Record<string, unknown> = {
        action: "edit",
        node_id,
      };

      // Only include fields that are explicitly set
      if (content !== undefined) change.content = content;
      if (note !== undefined) change.note = note;
      if (checked !== undefined) change.checked = checked;
      if (checkbox !== undefined) change.checkbox = checkbox;
      if (heading !== undefined) change.heading = heading;
      if (color !== undefined) change.color = color;

      const response = await client.editDocument(documentId, [change as any]);

      return {
        content: [
          {
            type: "text",
            text: `Node edited successfully!\nDocument: ${documentId}\nNode: ${node_id}`,
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: insert_node
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "insert_node",
    "Insert a new node into a Dynalist document",
    {
      url: z.string().optional().describe("Dynalist URL (document or with parent node deep link)"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      parent_id: z.string().describe("Parent node ID to insert under"),
      content: z.string().describe("Content text for the new node"),
      note: z.string().optional().describe("Note text for the new node"),
      index: z.number().optional().default(-1).describe("Position under parent (-1 = end, 0 = top)"),
      checkbox: z.boolean().optional().default(false).describe("Whether to add a checkbox"),
      heading: z.number().min(0).max(3).optional().describe("Heading level (0-3)"),
    },
    async ({ url, file_id, parent_id, content, note, index, checkbox, heading }) => {
      let documentId = file_id;

      if (url) {
        const parsed = parseDynalistUrl(url);
        documentId = parsed.documentId;
      }

      if (!documentId) {
        return {
          content: [{ type: "text", text: "Error: Either 'url' or 'file_id' must be provided" }],
          isError: true,
        };
      }

      const change: Record<string, unknown> = {
        action: "insert",
        parent_id,
        index,
        content,
      };

      if (note) change.note = note;
      if (checkbox) change.checkbox = checkbox;
      if (heading) change.heading = heading;

      const response = await client.editDocument(documentId, [change as any]);

      const newNodeId = response.new_node_ids?.[0];

      return {
        content: [
          {
            type: "text",
            text: `Node inserted successfully!\nDocument: ${documentId}\nParent: ${parent_id}\nNew Node ID: ${newNodeId || "unknown"}\nURL: ${buildDynalistUrl(documentId, newNodeId)}`,
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: search_in_document
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "search_in_document",
    "Search for text in a Dynalist document and return matching nodes with their URLs",
    {
      url: z.string().optional().describe("Dynalist URL"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      query: z.string().describe("Text to search for (case-insensitive)"),
      search_notes: z.boolean().optional().default(true).describe("Also search in notes"),
    },
    async ({ url, file_id, query, search_notes }) => {
      let documentId = file_id;

      if (url) {
        const parsed = parseDynalistUrl(url);
        documentId = parsed.documentId;
      }

      if (!documentId) {
        return {
          content: [{ type: "text", text: "Error: Either 'url' or 'file_id' must be provided" }],
          isError: true,
        };
      }

      const doc = await client.readDocument(documentId);
      const queryLower = query.toLowerCase();

      const matches = doc.nodes
        .filter((node) => {
          const contentMatch = node.content?.toLowerCase().includes(queryLower);
          const noteMatch = search_notes && node.note?.toLowerCase().includes(queryLower);
          return contentMatch || noteMatch;
        })
        .map((node) => ({
          id: node.id,
          content: node.content,
          note: node.note || undefined,
          url: buildDynalistUrl(documentId!, node.id),
        }));

      return {
        content: [
          {
            type: "text",
            text: matches.length > 0
              ? JSON.stringify(matches, null, 2)
              : `No matches found for "${query}"`,
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: delete_node
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "delete_node",
    "Delete a node from a Dynalist document",
    {
      url: z.string().optional().describe("Dynalist URL with node deep link"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      node_id: z.string().describe("Node ID to delete"),
    },
    async ({ url, file_id, node_id }) => {
      let documentId = file_id;

      if (url) {
        const parsed = parseDynalistUrl(url);
        documentId = parsed.documentId;
      }

      if (!documentId) {
        return {
          content: [{ type: "text", text: "Error: Either 'url' or 'file_id' must be provided" }],
          isError: true,
        };
      }

      await client.editDocument(documentId, [
        { action: "delete", node_id }
      ]);

      return {
        content: [
          {
            type: "text",
            text: `Node deleted successfully!\nDocument: ${documentId}\nDeleted Node: ${node_id}`,
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: move_node
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "move_node",
    "Move a node to a different location in a Dynalist document",
    {
      url: z.string().optional().describe("Dynalist URL"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      node_id: z.string().describe("Node ID to move"),
      parent_id: z.string().describe("New parent node ID"),
      index: z.number().optional().default(-1).describe("Position under new parent (-1 = end, 0 = top)"),
    },
    async ({ url, file_id, node_id, parent_id, index }) => {
      let documentId = file_id;

      if (url) {
        const parsed = parseDynalistUrl(url);
        documentId = parsed.documentId;
      }

      if (!documentId) {
        return {
          content: [{ type: "text", text: "Error: Either 'url' or 'file_id' must be provided" }],
          isError: true,
        };
      }

      await client.editDocument(documentId, [
        { action: "move", node_id, parent_id, index }
      ]);

      return {
        content: [
          {
            type: "text",
            text: `Node moved successfully!\nDocument: ${documentId}\nNode: ${node_id}\nNew Parent: ${parent_id}\nNew URL: ${buildDynalistUrl(documentId, node_id)}`,
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: move_node_after (intuitive move with relative positioning)
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "move_node_after",
    "Move a node relative to another node (after, before, or as child). The node and all its children are moved together.",
    {
      source_url: z.string().describe("URL of the node to move (with deep link #z=nodeId)"),
      reference_url: z.string().describe("URL of the reference node"),
      position: z.enum(["after", "before", "as_first_child", "as_last_child"]).describe(
        "Where to place relative to reference: 'after' = same level after reference, 'before' = same level before reference, 'as_first_child' = first child of reference, 'as_last_child' = last child of reference"
      ),
    },
    async ({ source_url, reference_url, position }) => {
      // Parse URLs
      const sourceParsed = parseDynalistUrl(source_url);
      const refParsed = parseDynalistUrl(reference_url);

      if (!sourceParsed.nodeId) {
        return {
          content: [{ type: "text", text: "Error: source_url must include a node deep link (#z=nodeId)" }],
          isError: true,
        };
      }

      if (!refParsed.nodeId) {
        return {
          content: [{ type: "text", text: "Error: reference_url must include a node deep link (#z=nodeId)" }],
          isError: true,
        };
      }

      if (sourceParsed.documentId !== refParsed.documentId) {
        return {
          content: [{ type: "text", text: "Error: Both nodes must be in the same document" }],
          isError: true,
        };
      }

      const documentId = sourceParsed.documentId;
      const sourceNodeId = sourceParsed.nodeId;
      const refNodeId = refParsed.nodeId;

      // Fetch document to find parent/index
      const doc = await client.readDocument(documentId);

      let targetParentId: string;
      let targetIndex: number;

      if (position === "as_first_child") {
        targetParentId = refNodeId;
        targetIndex = 0;
      } else if (position === "as_last_child") {
        targetParentId = refNodeId;
        targetIndex = -1;
      } else {
        // "after" or "before" - find the parent of the reference node
        const refParentInfo = findNodeParent(doc.nodes, refNodeId);
        if (!refParentInfo) {
          return {
            content: [{ type: "text", text: "Error: Could not find parent of reference node" }],
            isError: true,
          };
        }

        targetParentId = refParentInfo.parentId;
        targetIndex = position === "after" ? refParentInfo.index + 1 : refParentInfo.index;
      }

      // Execute move
      await client.editDocument(documentId, [
        { action: "move", node_id: sourceNodeId, parent_id: targetParentId, index: targetIndex }
      ]);

      return {
        content: [
          {
            type: "text",
            text: `Node moved successfully!\nSource: ${sourceNodeId}\nPosition: ${position} reference node\nNew Parent: ${targetParentId}\nNew URL: ${buildDynalistUrl(documentId, sourceNodeId)}`,
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: insert_nodes_from_markdown (bulk import of indented bullets)
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "insert_nodes_from_markdown",
    "Insert multiple nodes from indented markdown/text. Supports both '- bullet' format and plain indented text. Preserves hierarchy.",
    {
      url: z.string().describe("Dynalist URL - document or node (with #z=nodeId) to insert under"),
      content: z.string().describe("Indented text with bullets. Supports '- text' or plain indented text."),
      position: z.enum(["as_first_child", "as_last_child"]).optional().default("as_last_child")
        .describe("Where to insert under the parent node"),
    },
    async ({ url, content, position }) => {
      const parsed = parseDynalistUrl(url);
      const documentId = parsed.documentId;
      let parentNodeId = parsed.nodeId;

      // If no node specified, get root node
      if (!parentNodeId) {
        const doc = await client.readDocument(documentId);
        parentNodeId = findRootNodeId(doc.nodes);
      }

      // Parse the markdown content into a tree
      const tree = parseMarkdownBullets(content);
      if (tree.length === 0) {
        return {
          content: [{ type: "text", text: "No content to insert (empty or invalid format)" }],
          isError: true,
        };
      }

      // Group nodes by level for batch insertion
      const levels = groupByLevel(tree);
      let totalCreated = 0;
      let firstNodeUrl = "";

      // Track created IDs per level
      let previousLevelIds: string[] = [];

      // Insert level by level (batch insert per level = fewer HTTP requests)
      for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
        const level = levels[levelIdx];

        // Build batch changes for this level
        const changes: { action: string; parent_id: string; index: number; content: string }[] = [];

        // Track how many children we've added per parent (for explicit index)
        const childCountPerParent = new Map<string, number>();

        for (const node of level) {
          // Determine parent_id
          let nodeParentId: string;
          if (node.parentLevelIndex === -1) {
            // Root node - parent is the target from URL
            nodeParentId = parentNodeId;
          } else {
            // Child node - parent is from previous level
            nodeParentId = previousLevelIds[node.parentLevelIndex];
          }

          // Use explicit index to preserve order when multiple children go under same parent
          // For level 0, first node respects position setting
          let insertIndex: number;
          if (levelIdx === 0 && position === "as_first_child") {
            // Insert at beginning, use explicit index
            const count = childCountPerParent.get(nodeParentId) || 0;
            insertIndex = count;
            childCountPerParent.set(nodeParentId, count + 1);
          } else {
            // For level > 0, parents were just created so they're empty
            // Use explicit index starting from 0 to preserve order
            const count = childCountPerParent.get(nodeParentId) || 0;
            insertIndex = count;
            childCountPerParent.set(nodeParentId, count + 1);
          }

          changes.push({
            action: "insert",
            parent_id: nodeParentId,
            index: insertIndex,
            content: node.content,
          });
        }

        // Execute batch insert for this level
        const response = await client.editDocument(documentId, changes as any);
        const newIds = response.new_node_ids || [];

        // Track first node URL
        if (levelIdx === 0 && newIds.length > 0) {
          firstNodeUrl = buildDynalistUrl(documentId, newIds[0]);
        }

        totalCreated += newIds.length;
        previousLevelIds = newIds;
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully inserted ${totalCreated} nodes in ${levels.length} batch(es)!\nFirst node: ${firstNodeUrl}`,
          },
        ],
      };
    }
  );
}

/**
 * Convert permission number to readable label
 */
function getPermissionLabel(permission: number): string {
  switch (permission) {
    case 0:
      return "none";
    case 1:
      return "read";
    case 2:
      return "edit";
    case 3:
      return "manage";
    case 4:
      return "owner";
    default:
      return "unknown";
  }
}
