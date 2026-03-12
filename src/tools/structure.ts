/**
 * Structure tools: delete_node, move_node.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, buildNodeMap, buildParentMap } from "../dynalist-client";
import { buildDynalistUrl } from "../utils/url-parser";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
} from "../utils/dynalist-helpers";

export function registerStructureTools(server: McpServer, client: DynalistClient): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: delete_node
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "delete_node",
    {
      description:
        "Delete a node from a Dynalist document. By default, only the node is deleted and its " +
        "children move up to the parent. Use include_children=true to delete the node AND all its descendants.",
      inputSchema: {
        file_id: z.string().describe("Document ID"),
        node_id: z.string().describe("Node ID to delete"),
        include_children: z.boolean().optional().default(false).describe(
          "If true, delete the node AND all its children/descendants. " +
          "If false (default), only delete the node (children move up to parent)."
        ),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        deleted_count: z.number().describe("Number of nodes deleted"),
      },
    },
    wrapToolHandler(async ({
      file_id,
      node_id,
      include_children,
    }: {
      file_id: string;
      node_id: string;
      include_children: boolean;
    }) => {
      let deletedCount = 1;

      if (include_children) {
        const doc = await client.readDocument(file_id);
        const nodeMap = buildNodeMap(doc.nodes);

        // Collect all descendant IDs recursively.
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

        // Delete all nodes (children first, then parents - reverse order).
        const changes = nodesToDelete.reverse().map(id => ({ action: "delete" as const, node_id: id }));
        await client.editDocument(file_id, changes);
        deletedCount = nodesToDelete.length;
      } else {
        await client.editDocument(file_id, [
          { action: "delete", node_id },
        ]);
      }

      return makeResponse({
        file_id,
        deleted_count: deletedCount,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: move_node
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "move_node",
    {
      description:
        "Move a node (and all its children) to a new position relative to a reference node. " +
        "Use 'after'/'before' to place as a sibling of the reference, or " +
        "'first_child'/'last_child' to place inside the reference node.",
      inputSchema: {
        file_id: z.string().describe("Document ID"),
        node_id: z.string().describe("Node to move"),
        reference_node_id: z.string().describe("Reference node for positioning"),
        position: z.enum(["after", "before", "first_child", "last_child"]).describe(
          "'after' = immediately after reference (same parent), " +
          "'before' = immediately before reference (same parent), " +
          "'first_child' = as first child of reference, " +
          "'last_child' = as last child of reference"
        ),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        node_id: z.string().describe("Moved node ID"),
        url: z.string().describe("Dynalist URL for the moved node"),
      },
    },
    wrapToolHandler(async ({
      file_id,
      node_id,
      reference_node_id,
      position,
    }: {
      file_id: string;
      node_id: string;
      reference_node_id: string;
      position: string;
    }) => {
      let targetParentId: string;
      let targetIndex: number;

      if (position === "first_child") {
        targetParentId = reference_node_id;
        targetIndex = 0;
      } else if (position === "last_child") {
        targetParentId = reference_node_id;
        targetIndex = -1;
      } else {
        // "after" or "before": find the parent of the reference node.
        const doc = await client.readDocument(file_id);
        const parentMap = buildParentMap(doc.nodes);

        const refParentInfo = parentMap.get(reference_node_id);
        if (!refParentInfo) {
          return makeErrorResponse("NodeNotFound", "Could not find parent of reference node");
        }

        targetParentId = refParentInfo.parentId;
        targetIndex = position === "after" ? refParentInfo.index + 1 : refParentInfo.index;
      }

      await client.editDocument(file_id, [
        { action: "move", node_id, parent_id: targetParentId, index: targetIndex },
      ]);

      return makeResponse({
        file_id,
        node_id,
        url: buildDynalistUrl(file_id, node_id),
      });
    })
  );
}
