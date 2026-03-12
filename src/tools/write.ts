/**
 * Write tools: send_to_inbox, edit_node, insert_node, insert_nodes.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, EditDocumentChange, findRootNodeId } from "../dynalist-client";
import { buildDynalistUrl } from "../utils/url-parser";
import { parseMarkdownBullets } from "../utils/markdown-parser";
import { getConfig } from "../config";
import { AccessController, requireAccess } from "../access-control";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
  insertTreeUnderParent,
} from "../utils/dynalist-helpers";

export function registerWriteTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: send_to_inbox
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "send_to_inbox",
    {
      description: "Send items to your Dynalist inbox. Supports indented markdown/bullets for hierarchical content.",
      inputSchema: {
        content: z.string().describe("The text content - can be single line or indented markdown with '- bullets'"),
        note: z.string().optional().describe("Optional note for the first/root item"),
        checkbox: z.boolean().optional().describe("Whether to add checkboxes to items (default from config)"),
      },
      outputSchema: {
        file_id: z.string().describe("Inbox document ID"),
        node_id: z.string().describe("ID of the first created node"),
        url: z.string().describe("Dynalist URL for the first created node"),
        total_created: z.number().describe("Total number of nodes created"),
      },
    },
    wrapToolHandler(async ({ content, note, checkbox }: { content: string; note?: string; checkbox?: boolean }) => {
      const config = getConfig();

      // send_to_inbox always allowed, but respect global readOnly.
      if (config.readOnly) {
        return makeErrorResponse("ReadOnly", "Server is in read-only mode.");
      }

      const effectiveCheckbox = checkbox ?? config.inbox.defaultCheckbox;
      const tree = parseMarkdownBullets(content);

      if (tree.length === 0) {
        return makeErrorResponse("InvalidInput", "No content to add (empty input)");
      }

      // Step 1: Add first top-level item via inbox API (to get inbox file_id).
      const firstResponse = await client.sendToInbox({
        content: tree[0].content,
        note,
        checkbox: effectiveCheckbox,
      });

      const inboxFileId = firstResponse.file_id;
      const firstNodeId = firstResponse.node_id;
      let totalCreated = 1;

      // Step 2: Insert children of first node (if any).
      if (tree[0].children.length > 0) {
        const result = await insertTreeUnderParent(client, inboxFileId, firstNodeId, tree[0].children, { checkbox: effectiveCheckbox });
        totalCreated += result.totalCreated;
      }

      // Step 3: Insert remaining top-level items with their children.
      if (tree.length > 1) {
        const inboxDoc = await client.readDocument(inboxFileId);
        const inboxRootId = findRootNodeId(inboxDoc.nodes);
        const rootNode = inboxDoc.nodes.find(n => n.id === inboxRootId);
        const firstNodeIndex = rootNode?.children?.indexOf(firstNodeId) ?? -1;

        const remainingTopLevel = tree.slice(1).map(n => ({ content: n.content, children: [] }));
        const topResult = await insertTreeUnderParent(client, inboxFileId, inboxRootId, remainingTopLevel, {
          startIndex: firstNodeIndex + 1,
          checkbox: effectiveCheckbox,
        });
        totalCreated += topResult.totalCreated;

        for (let i = 0; i < topResult.rootNodeIds.length; i++) {
          const parentId = topResult.rootNodeIds[i];
          const children = tree[i + 1].children;
          if (children.length > 0) {
            const childResult = await insertTreeUnderParent(client, inboxFileId, parentId, children, { checkbox: effectiveCheckbox });
            totalCreated += childResult.totalCreated;
          }
        }
      }

      return makeResponse({
        file_id: inboxFileId,
        node_id: firstNodeId,
        url: buildDynalistUrl(inboxFileId, firstNodeId),
        total_created: totalCreated,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: edit_node
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "edit_node",
    {
      description: "Edit an existing node in a Dynalist document. Only specified fields are updated.",
      inputSchema: {
        file_id: z.string().describe("Document ID"),
        node_id: z.string().describe("Node ID to edit"),
        content: z.string().optional().describe("New content text"),
        note: z.string().optional().describe("New note text"),
        checked: z.boolean().optional().describe("Checked status"),
        checkbox: z.boolean().optional().describe("Whether to show checkbox"),
        heading: z.number().min(0).max(3).optional().describe("Heading level (0-3)"),
        color: z.number().min(0).max(6).optional().describe("Color label (0-6)"),
        collapsed: z.boolean().optional().describe("Whether the node is collapsed"),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        node_id: z.string().describe("Edited node ID"),
        url: z.string().describe("Dynalist URL for the edited node"),
      },
    },
    wrapToolHandler(async ({
      file_id,
      node_id,
      content,
      note,
      checked,
      checkbox,
      heading,
      color,
      collapsed,
    }: {
      file_id: string;
      node_id: string;
      content?: string;
      note?: string;
      checked?: boolean;
      checkbox?: boolean;
      heading?: number;
      color?: number;
      collapsed?: boolean;
    }) => {
      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const change: EditDocumentChange = {
        action: "edit",
        node_id,
      };

      // Only include fields that are explicitly set.
      if (content !== undefined) change.content = content;
      if (note !== undefined) change.note = note;
      if (checked !== undefined) change.checked = checked;
      if (checkbox !== undefined) change.checkbox = checkbox;
      if (heading !== undefined) change.heading = heading;
      if (color !== undefined) change.color = color;
      if (collapsed !== undefined) change.collapsed = collapsed;

      await client.editDocument(file_id, [change]);

      return makeResponse({
        file_id,
        node_id,
        url: buildDynalistUrl(file_id, node_id),
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: insert_node
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "insert_node",
    {
      description: "Insert a single new node into a Dynalist document.",
      inputSchema: {
        file_id: z.string().describe("Document ID"),
        parent_id: z.string().describe("Parent node ID to insert under"),
        content: z.string().describe("Content text for the new node"),
        note: z.string().optional().describe("Note text for the new node"),
        index: z.number().optional().default(-1).describe("Position under parent (-1 = end, 0 = top)"),
        checkbox: z.boolean().optional().default(false).describe("Whether to add a checkbox"),
        heading: z.number().min(0).max(3).optional().describe("Heading level (0-3)"),
        color: z.number().min(0).max(6).optional().describe("Color label (0-6)"),
        checked: z.boolean().optional().describe("Initial checked state (only meaningful with checkbox: true)"),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        node_id: z.string().describe("ID of the newly created node"),
        url: z.string().describe("Dynalist URL for the new node"),
      },
    },
    wrapToolHandler(async ({
      file_id,
      parent_id,
      content,
      note,
      index,
      checkbox,
      heading,
      color,
      checked,
    }: {
      file_id: string;
      parent_id: string;
      content: string;
      note?: string;
      index: number;
      checkbox: boolean;
      heading?: number;
      color?: number;
      checked?: boolean;
    }) => {
      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const change: EditDocumentChange = {
        action: "insert",
        parent_id,
        index,
        content,
      };

      if (note) change.note = note;
      if (checkbox) change.checkbox = checkbox;
      if (heading) change.heading = heading;
      if (color !== undefined && color > 0) change.color = color;
      if (checked !== undefined) change.checked = checked;

      const response = await client.editDocument(file_id, [change]);
      const newNodeId = response.new_node_ids?.[0];

      return makeResponse({
        file_id,
        node_id: newNodeId ?? "unknown",
        url: buildDynalistUrl(file_id, newNodeId),
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: insert_nodes
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "insert_nodes",
    {
      description:
        "Insert multiple nodes from indented markdown/text. Supports both '- bullet' format and " +
        "plain indented text. Preserves hierarchy.",
      inputSchema: {
        file_id: z.string().describe("Document ID"),
        node_id: z.string().optional().describe("Parent node ID to insert under (omit for document root)"),
        content: z.string().describe("Indented text with bullets. Supports '- text' or plain indented text."),
        position: z.enum(["as_first_child", "as_last_child"]).optional().default("as_last_child")
          .describe("Where to insert under the parent node"),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        total_created: z.number().describe("Total number of nodes created"),
        first_node_id: z.string().nullable().describe("ID of the first created node, or null if none"),
        url: z.string().describe("Dynalist URL for the first created node"),
      },
    },
    wrapToolHandler(async ({
      file_id,
      node_id,
      content,
      position,
    }: {
      file_id: string;
      node_id?: string;
      content: string;
      position: string;
    }) => {
      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      let parentNodeId = node_id;

      // If no node specified, get root node.
      if (!parentNodeId) {
        const doc = await client.readDocument(file_id);
        parentNodeId = findRootNodeId(doc.nodes);
      }

      const tree = parseMarkdownBullets(content);
      if (tree.length === 0) {
        return makeErrorResponse("InvalidInput", "No content to insert (empty or invalid format)");
      }

      const result = await insertTreeUnderParent(client, file_id, parentNodeId, tree, {
        startIndex: position === "as_first_child" ? 0 : undefined,
      });

      const firstNodeId = result.rootNodeIds[0] ?? null;
      const url = firstNodeId
        ? buildDynalistUrl(file_id, firstNodeId)
        : buildDynalistUrl(file_id);

      return makeResponse({
        file_id,
        total_created: result.totalCreated,
        first_node_id: firstNodeId,
        url,
      });
    })
  );
}
