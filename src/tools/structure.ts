/**
 * Structure tools: delete_node, move_node.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, buildNodeMap, buildParentMap, findRootNodeId } from "../dynalist-client";
import { buildDynalistUrl } from "../utils/url-parser";
import { getConfig } from "../config";
import { AccessController, requireAccess } from "../access-control";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
} from "../utils/dynalist-helpers";
import { FILE_ID_DESCRIPTION, CONFIRM_GUIDANCE } from "./descriptions";

export function registerStructureTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: delete_node
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "delete_node",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Delete a node from a Dynalist document. By default, the node and its entire subtree " +
        "are deleted. Set include_children: false to promote children up to the deleted node's " +
        "parent instead (the node is removed but its children survive in place).\n\n" +
        "Examples:\n" +
        "- Delete a section and everything under it: include_children: true (default).\n" +
        "- Delete a header but keep its items: include_children: false.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        node_id: z.string().describe("Node ID to delete"),
        include_children: z.boolean().optional().default(true).describe(
          "If true (default), delete the node and all its descendants (entire subtree). " +
          "If false, promote children up to the deleted node's parent."
        ),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
        deleted_count: z.number().describe("Number of nodes deleted"),
        promoted_children: z.number().optional().describe("Number of direct children promoted to parent (only when include_children is false)"),
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
      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      // Reject deleting the root node.
      if (node_id === "root") {
        return makeErrorResponse("InvalidInput", "Cannot delete the root node of a document.");
      }

      const doc = await client.readDocument(file_id);
      const rootId = findRootNodeId(doc.nodes);
      if (node_id === rootId) {
        return makeErrorResponse("InvalidInput", "Cannot delete the root node of a document.");
      }

      const nodeMap = buildNodeMap(doc.nodes);
      const parentMap = buildParentMap(doc.nodes);
      const targetNode = nodeMap.get(node_id);

      if (!targetNode) {
        return makeErrorResponse("NodeNotFound", `Node '${node_id}' not found in document.`);
      }

      if (!include_children && targetNode.children && targetNode.children.length > 0) {
        // Promote children: move them to the deleted node's parent at the same position.
        const parentInfo = parentMap.get(node_id);
        if (!parentInfo) {
          return makeErrorResponse("NodeNotFound", "Could not find parent of node to delete.");
        }

        // Capture count before mutations, since editDocument mutates the in-memory node.
        const promotedCount = targetNode.children.length;

        // Move each child to be a sibling of the node being deleted,
        // placed at the node's index. Each successive child goes after
        // the previous one, so we increment the index.
        const moveChanges = targetNode.children.map((childId, i) => ({
          action: "move" as const,
          node_id: childId,
          parent_id: parentInfo.parentId,
          index: parentInfo.index + i,
        }));
        await client.editDocument(file_id, moveChanges);

        // Now delete just the (now childless) node.
        await client.editDocument(file_id, [{ action: "delete", node_id }]);

        return makeResponse({
          file_id,
          deleted_count: 1,
          promoted_children: promotedCount,
        });
      }

      // Collect the target node and all descendants via depth-first traversal.
      // The Dynalist API's delete action only removes the specified node and
      // orphans its children, so we must enumerate the full subtree ourselves.
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

      // Delete in reverse (children before parents). This ordering makes the
      // operation idempotent on partial failure: if batching is interrupted
      // mid-way (rate limit exhaustion, server restart, etc.), only leaf nodes
      // have been deleted and the remaining nodes are still connected to the
      // tree. Retrying the tool call re-reads the document, re-collects the
      // surviving subtree, and deletes the rest. Parent-first ordering would
      // orphan children on partial failure with no way to recover them.
      const changes = nodesToDelete.reverse().map(id => ({ action: "delete" as const, node_id: id }));
      await client.editDocument(file_id, changes);

      return makeResponse({
        file_id,
        deleted_count: nodesToDelete.length,
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
        `${CONFIRM_GUIDANCE} ` +
        "Move a node and its entire subtree to a new position relative to a reference node.\n\n" +
        "Position examples:\n" +
        "- 'after': place immediately after the reference (same parent).\n" +
        "- 'before': place immediately before the reference (same parent).\n" +
        "- 'first_child': place as the first child inside the reference.\n" +
        "- 'last_child': place as the last child inside the reference.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        node_id: z.string().describe("Node to move (its entire subtree moves with it)"),
        reference_node_id: z.string().describe("Reference node for positioning"),
        position: z.enum(["after", "before", "first_child", "last_child"]).describe(
          "'after' = immediately after reference (same parent), " +
          "'before' = immediately before reference (same parent), " +
          "'first_child' = as first child of reference, " +
          "'last_child' = as last child of reference."
        ),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
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
      const config = getConfig();

      // Access check: only document-level policy is checked for within-document moves.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      // Reject self-referential moves that would orphan the node.
      if (node_id === reference_node_id) {
        return makeErrorResponse("InvalidInput", "Cannot move a node relative to itself.");
      }

      // Read the document to validate the move and resolve positions.
      const doc = await client.readDocument(file_id);
      const nodeMap = buildNodeMap(doc.nodes);

      if (!nodeMap.has(node_id)) {
        return makeErrorResponse("NodeNotFound", `Node '${node_id}' not found in document.`);
      }
      if (!nodeMap.has(reference_node_id)) {
        return makeErrorResponse("NodeNotFound", `Reference node '${reference_node_id}' not found in document.`);
      }

      // Check if the target parent is a descendant of the node being moved.
      // This applies to all positions: for first_child/last_child the target
      // parent is the reference node itself; for before/after it is the
      // reference node's parent.
      function isDescendant(ancestorId: string, targetId: string): boolean {
        const node = nodeMap.get(ancestorId);
        if (!node?.children) return false;
        for (const childId of node.children) {
          if (childId === targetId) return true;
          if (isDescendant(childId, targetId)) return true;
        }
        return false;
      }

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
        const parentMap = buildParentMap(doc.nodes);

        const refParentInfo = parentMap.get(reference_node_id);
        if (!refParentInfo) {
          return makeErrorResponse("NodeNotFound", "Could not find parent of reference node");
        }

        targetParentId = refParentInfo.parentId;
        targetIndex = position === "after" ? refParentInfo.index + 1 : refParentInfo.index;

        // The API uses post-removal indexing: it removes the node first,
        // then inserts at the given index. When moving within the same
        // parent and the node is earlier than the reference, the removal
        // shifts the reference's index down by 1, so we must compensate.
        const movedNodeInfo = parentMap.get(node_id);
        if (movedNodeInfo && movedNodeInfo.parentId === targetParentId && movedNodeInfo.index < refParentInfo.index) {
          targetIndex--;
        }
      }

      if (node_id === targetParentId || isDescendant(node_id, targetParentId)) {
        return makeErrorResponse("InvalidInput", "Cannot move a node into one of its own descendants.");
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
