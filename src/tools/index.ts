/**
 * Dynalist MCP Tools
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, buildNodeMap, findRootNodeId, findNodeParent } from "../dynalist-client.js";
import { parseDynalistUrl, buildDynalistUrl } from "../utils/url-parser.js";
import { nodeToMarkdown, documentToMarkdown } from "../utils/node-to-markdown.js";
import { parseMarkdownBullets, groupByLevel, ParsedNode } from "../utils/markdown-parser.js";

/**
 * Helper: Count words in a string
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Helper: Check content size and return warning if too large
 * Returns null if content is OK, or warning message if too large
 */
function checkContentSize(
  content: string,
  bypassWarning: boolean,
  recommendations: string[]
): { warning: string; canBypass: boolean } | null {
  const wordCount = countWords(content);

  if (wordCount <= 3000 || bypassWarning) {
    return null; // OK to return content
  }

  const canBypass = wordCount <= 20000;

  let warning = `⚠️ LARGE RESULT WARNING\n`;
  warning += `This query would return ~${wordCount.toLocaleString()} words which may fill your context.\n\n`;
  warning += `Recommendations:\n`;
  for (const rec of recommendations) {
    warning += `- ${rec}\n`;
  }

  if (canBypass) {
    warning += `\nTo receive the full result anyway (${wordCount.toLocaleString()} words), repeat the request with bypass_warning: true`;
  } else {
    warning += `\n❌ Result too large (>${20000} words). Please reduce the scope using the recommendations above.`;
  }

  return { warning, canBypass };
}

/**
 * Helper: Get ancestor nodes (parents) up to N levels
 * Returns array with nearest parent first
 */
function getAncestors(
  nodes: import("../dynalist-client.js").DynalistNode[],
  nodeId: string,
  levels: number
): { id: string; content: string }[] {
  if (levels <= 0) return [];

  const ancestors: { id: string; content: string }[] = [];
  let currentId = nodeId;

  for (let i = 0; i < levels; i++) {
    const parentInfo = findNodeParent(nodes, currentId);
    if (!parentInfo) break; // Reached root or node not found

    const parentNode = nodes.find(n => n.id === parentInfo.parentId);
    if (!parentNode) break;

    ancestors.push({ id: parentNode.id, content: parentNode.content });
    currentId = parentNode.id;
  }

  return ancestors;
}

/**
 * Helper: Insert a tree of nodes under a parent, level by level
 * Returns total nodes created and array of created node IDs for level 0
 */
async function insertTreeUnderParent(
  client: DynalistClient,
  fileId: string,
  parentId: string,
  tree: ParsedNode[],
  options: { startIndex?: number; checkbox?: boolean } = {}
): Promise<{ totalCreated: number; rootNodeIds: string[] }> {
  if (tree.length === 0) {
    return { totalCreated: 0, rootNodeIds: [] };
  }

  const levels = groupByLevel(tree);
  let totalCreated = 0;
  let rootNodeIds: string[] = [];
  let previousLevelIds: string[] = [];

  for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
    const level = levels[levelIdx];
    const changes: { action: string; parent_id: string; index: number; content: string; checkbox?: boolean }[] = [];
    const childCountPerParent = new Map<string, number>();

    for (const node of level) {
      const nodeParentId = node.parentLevelIndex === -1
        ? parentId
        : previousLevelIds[node.parentLevelIndex];

      const baseIndex = (levelIdx === 0 && options.startIndex !== undefined)
        ? options.startIndex
        : 0;
      const count = childCountPerParent.get(nodeParentId) || 0;

      changes.push({
        action: "insert",
        parent_id: nodeParentId,
        index: baseIndex + count,
        content: node.content,
        checkbox: options.checkbox || undefined,
      });
      childCountPerParent.set(nodeParentId, count + 1);
    }

    const response = await client.editDocument(fileId, changes as any);
    const newIds = response.new_node_ids || [];

    if (levelIdx === 0) {
      rootNodeIds = newIds;
    }

    totalCreated += newIds.length;
    previousLevelIds = newIds;
  }

  return { totalCreated, rootNodeIds };
}

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
  // TOOL: search_documents
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "search_documents",
    "Search for documents and folders by name. Returns matching items with their ID, title, URL, and type.",
    {
      query: z.string().describe("Text to search for in document/folder names (case-insensitive)"),
      type: z.enum(["all", "document", "folder"]).optional().default("all").describe("Filter by type: 'document', 'folder', or 'all'"),
    },
    async ({ query, type }) => {
      const response = await client.listFiles();
      const queryLower = query.toLowerCase();

      const matches = response.files
        .filter((f) => {
          const nameMatch = f.title?.toLowerCase().includes(queryLower);
          const typeMatch = type === "all" || f.type === type;
          return nameMatch && typeMatch;
        })
        .map((f) => ({
          id: f.id,
          title: f.title,
          type: f.type,
          url: f.type === "document" ? buildDynalistUrl(f.id) : undefined,
          permission: f.type === "document" ? getPermissionLabel(f.permission) : undefined,
          children: f.type === "folder" ? f.children : undefined,
        }));

      return {
        content: [
          {
            type: "text",
            text: matches.length > 0
              ? JSON.stringify(matches, null, 2)
              : `No ${type === "all" ? "documents or folders" : type + "s"} found matching "${query}"`,
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
    "Read a Dynalist document or specific node and return it as Markdown. Provide either a URL (with optional #z=nodeId deep link) or file_id + node_id. WARNING: Large documents may return many words - use max_depth to limit.",
    {
      url: z.string().optional().describe("Dynalist URL (e.g., https://dynalist.io/d/xxx#z=yyy)"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      node_id: z.string().optional().describe("Node ID to start from (optional, reads entire doc if not provided)"),
      max_depth: z.number().optional().describe("Maximum depth to traverse (optional, unlimited if not set) - USE THIS TO LIMIT OUTPUT SIZE"),
      include_notes: z.boolean().optional().default(true).describe("Include notes as sub-bullets"),
      include_checked: z.boolean().optional().default(true).describe("Include checked/completed items"),
      bypass_warning: z.boolean().optional().default(false).describe("Set to true to receive large results (3000-20000 words) without warning"),
    },
    async ({ url, file_id, node_id, max_depth, include_notes, include_checked, bypass_warning }) => {
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

      if (nodeId) {
        // Render from specific node
        if (!nodeMap.has(nodeId)) {
          return {
            content: [{ type: "text", text: `Error: Node '${nodeId}' not found in document` }],
            isError: true,
          };
        }
        markdown = nodeToMarkdown(doc.nodes, nodeId, options);
      } else {
        // Render entire document
        markdown = documentToMarkdown(doc.nodes, options);
      }

      // Check content size
      const sizeCheck = checkContentSize(markdown, bypass_warning || false, [
        "Use max_depth to limit traversal depth (e.g., max_depth: 2)",
        "Target a specific node_id instead of entire document",
        "Use include_notes: false to reduce output",
      ]);

      if (sizeCheck) {
        return {
          content: [{ type: "text", text: sizeCheck.warning }],
        };
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
    "Send items to your Dynalist inbox. Supports indented markdown/bullets for hierarchical content.",
    {
      content: z.string().describe("The text content - can be single line or indented markdown with '- bullets'"),
      note: z.string().optional().describe("Optional note for the first/root item"),
      checkbox: z.boolean().optional().default(false).describe("Whether to add checkboxes to items"),
    },
    async ({ content, note, checkbox }) => {
      // Parse content as markdown to detect hierarchy
      const tree = parseMarkdownBullets(content);

      if (tree.length === 0) {
        return {
          content: [{ type: "text", text: "No content to add (empty input)" }],
          isError: true,
        };
      }

      // Step 1: Add first top-level item via inbox API (to get inbox file_id)
      const firstResponse = await client.sendToInbox({
        content: tree[0].content,
        note,
        checkbox,
      });

      const inboxFileId = firstResponse.file_id;
      const firstNodeId = firstResponse.node_id;
      let totalCreated = 1;

      // Step 2: Insert children of first node (if any)
      if (tree[0].children.length > 0) {
        const result = await insertTreeUnderParent(client, inboxFileId, firstNodeId, tree[0].children, { checkbox });
        totalCreated += result.totalCreated;
      }

      // Step 3: Insert remaining top-level items with their children
      if (tree.length > 1) {
        const inboxDoc = await client.readDocument(inboxFileId);
        const inboxRootId = findRootNodeId(inboxDoc.nodes);
        const rootNode = inboxDoc.nodes.find(n => n.id === inboxRootId);
        const firstNodeIndex = rootNode?.children?.indexOf(firstNodeId) ?? -1;

        // Remaining top-level items (without their children first)
        const remainingTopLevel: ParsedNode[] = tree.slice(1).map(n => ({ content: n.content, children: [] }));
        const topResult = await insertTreeUnderParent(client, inboxFileId, inboxRootId, remainingTopLevel, {
          startIndex: firstNodeIndex + 1,
          checkbox,
        });
        totalCreated += topResult.totalCreated;

        // Now insert children of each remaining top-level node
        for (let i = 0; i < topResult.rootNodeIds.length; i++) {
          const parentId = topResult.rootNodeIds[i];
          const children = tree[i + 1].children;
          if (children.length > 0) {
            const childResult = await insertTreeUnderParent(client, inboxFileId, parentId, children, { checkbox });
            totalCreated += childResult.totalCreated;
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully added ${totalCreated} items to inbox!\nDocument: ${inboxFileId}\nFirst node: ${buildDynalistUrl(inboxFileId, firstNodeId)}`,
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
    "Search for text in a Dynalist document. Returns matching nodes with optional parent context and children. WARNING: Many matches with parents/children can return many words.",
    {
      url: z.string().optional().describe("Dynalist URL"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      query: z.string().describe("Text to search for (case-insensitive)"),
      search_notes: z.boolean().optional().default(true).describe("Also search in notes"),
      parent_levels: z.number().optional().default(1).describe("How many parent levels to include (0 = none, 1 = direct parent, 2+ = ancestors)"),
      include_children: z.boolean().optional().default(false).describe("Include direct children (level 1) of each match"),
      bypass_warning: z.boolean().optional().default(false).describe("Set to true to receive large results (3000-20000 words) without warning"),
    },
    async ({ url, file_id, query, search_notes, parent_levels, include_children, bypass_warning }) => {
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
      const nodeMap = buildNodeMap(doc.nodes);
      const queryLower = query.toLowerCase();

      const matches = doc.nodes
        .filter((node) => {
          const contentMatch = node.content?.toLowerCase().includes(queryLower);
          const noteMatch = search_notes && node.note?.toLowerCase().includes(queryLower);
          return contentMatch || noteMatch;
        })
        .map((node) => {
          const result: {
            id: string;
            content: string;
            note?: string;
            url: string;
            parents?: { id: string; content: string }[];
            children?: { id: string; content: string }[];
          } = {
            id: node.id,
            content: node.content,
            note: node.note || undefined,
            url: buildDynalistUrl(documentId!, node.id),
          };

          // Add parents if requested
          if (parent_levels > 0) {
            const parents = getAncestors(doc.nodes, node.id, parent_levels);
            if (parents.length > 0) {
              result.parents = parents;
            }
          }

          // Add children if requested
          if (include_children && node.children && node.children.length > 0) {
            result.children = node.children
              .map(childId => {
                const childNode = nodeMap.get(childId);
                return childNode ? { id: childNode.id, content: childNode.content } : null;
              })
              .filter((c): c is { id: string; content: string } => c !== null);
          }

          return result;
        });

      const resultText = matches.length > 0
        ? JSON.stringify(matches, null, 2)
        : `No matches found for "${query}"`;

      // Check content size
      const sizeCheck = checkContentSize(resultText, bypass_warning || false, [
        "Use a more specific query to reduce matches",
        "Use parent_levels: 0 to exclude parent context",
        "Use include_children: false to exclude children",
      ]);

      if (sizeCheck) {
        return {
          content: [{ type: "text", text: sizeCheck.warning }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: resultText,
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // TOOL: get_recent_changes
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "get_recent_changes",
    "Get nodes created or modified within a time period. WARNING: Long time periods with active documents can return many words.",
    {
      url: z.string().optional().describe("Dynalist URL"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      since: z.union([z.string(), z.number()]).describe("Start date - ISO string (e.g. '2024-01-15') or timestamp in milliseconds"),
      until: z.union([z.string(), z.number()]).optional().describe("End date - ISO string or timestamp (default: now)"),
      type: z.enum(["created", "modified", "both"]).optional().default("modified").describe("Filter by change type"),
      parent_levels: z.number().optional().default(1).describe("How many parent levels to include for context"),
      sort: z.enum(["newest_first", "oldest_first"]).optional().default("newest_first").describe("Sort order by timestamp"),
      bypass_warning: z.boolean().optional().default(false).describe("Set to true to receive large results (3000-20000 words) without warning"),
    },
    async ({ url, file_id, since, until, type, parent_levels, sort, bypass_warning }) => {
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

      // Parse timestamps
      const parseTimestamp = (val: string | number): number => {
        if (typeof val === "number") return val;
        const date = new Date(val);
        return date.getTime();
      };

      const sinceTs = parseTimestamp(since);
      const untilTs = until ? parseTimestamp(until) : Date.now();

      if (isNaN(sinceTs)) {
        return {
          content: [{ type: "text", text: "Error: Invalid 'since' date format" }],
          isError: true,
        };
      }

      const doc = await client.readDocument(documentId);

      // Filter nodes by time range and type
      const matches = doc.nodes
        .filter((node) => {
          const createdInRange = node.created >= sinceTs && node.created <= untilTs;
          const modifiedInRange = node.modified >= sinceTs && node.modified <= untilTs;

          if (type === "created") return createdInRange;
          if (type === "modified") return modifiedInRange && !createdInRange; // Modified but not newly created
          // "both" - either created or modified in range
          return createdInRange || modifiedInRange;
        })
        .map((node) => {
          const createdInRange = node.created >= sinceTs && node.created <= untilTs;

          const result: {
            id: string;
            content: string;
            created: number;
            modified: number;
            url: string;
            change_type: string;
            parents?: { id: string; content: string }[];
          } = {
            id: node.id,
            content: node.content,
            created: node.created,
            modified: node.modified,
            url: buildDynalistUrl(documentId!, node.id),
            change_type: createdInRange ? "created" : "modified",
          };

          // Add parents if requested
          if (parent_levels > 0) {
            const parents = getAncestors(doc.nodes, node.id, parent_levels);
            if (parents.length > 0) {
              result.parents = parents;
            }
          }

          return result;
        });

      // Sort
      matches.sort((a, b) => {
        const aTime = a.change_type === "created" ? a.created : a.modified;
        const bTime = b.change_type === "created" ? b.created : b.modified;
        return sort === "newest_first" ? bTime - aTime : aTime - bTime;
      });

      const resultText = matches.length > 0
        ? JSON.stringify(matches, null, 2)
        : `No changes found in the specified time period`;

      // Check content size
      const sizeCheck = checkContentSize(resultText, bypass_warning || false, [
        "Use a shorter time period (narrower since/until range)",
        "Use parent_levels: 0 to exclude parent context",
        "Filter by type: 'created' or 'modified' instead of 'both'",
      ]);

      if (sizeCheck) {
        return {
          content: [{ type: "text", text: sizeCheck.warning }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: resultText,
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
    "Delete a node from a Dynalist document. By default, only the node is deleted and its children move up to the parent. Use include_children=true to delete the node AND all its descendants.",
    {
      url: z.string().optional().describe("Dynalist URL with node deep link"),
      file_id: z.string().optional().describe("Document ID (alternative to URL)"),
      node_id: z.string().describe("Node ID to delete"),
      include_children: z.boolean().optional().default(false).describe("If true, delete the node AND all its children/descendants. If false (default), only delete the node (children move up to parent)."),
    },
    async ({ url, file_id, node_id, include_children }) => {
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

      let deletedCount = 1;

      if (include_children) {
        // Read document to find all descendants
        const doc = await client.readDocument(documentId);
        const nodeMap = buildNodeMap(doc.nodes);

        // Collect all descendant IDs recursively
        const nodesToDelete: string[] = [];
        function collectDescendants(id: string) {
          nodesToDelete.push(id);
          const node = nodeMap.get(id);
          if (node?.children) {
            for (const childId of node.children) {
              collectDescendants(childId);
            }
          }
        }
        collectDescendants(node_id);

        // Delete all nodes (children first, then parents - reverse order)
        const changes = nodesToDelete.reverse().map(id => ({ action: "delete" as const, node_id: id }));
        await client.editDocument(documentId, changes);
        deletedCount = nodesToDelete.length;
      } else {
        // Delete only the node itself
        await client.editDocument(documentId, [
          { action: "delete", node_id }
        ]);
      }

      return {
        content: [
          {
            type: "text",
            text: `Deleted ${deletedCount} node(s) successfully!\nDocument: ${documentId}${include_children ? " (including all children)" : " (children moved to parent)"}`,
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
  // TOOL: move_node_relative (intuitive move with relative positioning)
  // ═══════════════════════════════════════════════════════════════════
  server.tool(
    "move_node_relative",
    "Move a node (and all its children) to a new position relative to a reference node. This is the intuitive way to reorganize your outline - just specify where you want the node to go.",
    {
      source_url: z.string().describe("URL of the node to move (with deep link #z=nodeId). The entire subtree (node + all descendants) will be moved."),
      reference_url: z.string().describe("URL of the reference node that determines the target location"),
      position: z.enum(["after", "before", "as_first_child", "as_last_child"]).describe(
        "Where to place the node relative to the reference: " +
        "'after' = immediately after the reference (same parent, same level), " +
        "'before' = immediately before the reference (same parent, same level), " +
        "'as_first_child' = as the first child inside the reference node, " +
        "'as_last_child' = as the last child inside the reference node"
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

      // Use helper to insert tree
      const result = await insertTreeUnderParent(client, documentId, parentNodeId, tree, {
        startIndex: position === "as_first_child" ? 0 : undefined,
      });

      const firstNodeUrl = result.rootNodeIds.length > 0
        ? buildDynalistUrl(documentId, result.rootNodeIds[0])
        : "";

      return {
        content: [
          {
            type: "text",
            text: `Successfully inserted ${result.totalCreated} nodes!\nFirst node: ${firstNodeUrl}`,
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
