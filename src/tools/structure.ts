/**
 * Structure tools: delete_nodes, move_nodes.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, buildNodeMap, buildParentMap, findRootNodeId } from "../dynalist-client";
import { getConfig } from "../config";
import { AccessController, requireAccess } from "../access-control";
import { withVersionGuard } from "../version-guard";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
  ToolInputError,
} from "../utils/dynalist-helpers";
import type { DocumentStore } from "../document-store";
import { FILE_ID_DESCRIPTION, CONFIRM_GUIDANCE, EXPECTED_VERSION_DESCRIPTION } from "./descriptions";

export function registerStructureTools(server: McpServer, client: DynalistClient, ac: AccessController, store: DocumentStore): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: delete_nodes
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "delete_nodes",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Delete one or more nodes from a Dynalist document. By default, each node and its " +
        "entire subtree are deleted. For a single node, pass a one-element array.\n\n" +
        "If two nodes in the array overlap (one is an ancestor of the other), the descendant " +
        "is automatically deduplicated.\n\n" +
        "include_children: false is a niche option that promotes (unwraps) a single node's " +
        "children up to its parent instead of deleting them. This is only supported when " +
        "deleting a single node. The vast majority of deletions should use the default " +
        "(include_children: true). Only use include_children: false when the user explicitly " +
        "wants to remove a grouping node (e.g. a header) while keeping its items.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        node_ids: z.array(z.string()).describe("Node IDs to delete. For a single deletion, pass a one-element array."),
        include_children: z.boolean().optional().default(true).describe(
          "If true (default), delete each node and all its descendants (entire subtree). " +
          "If false, promote children up to the deleted node's parent. " +
          "Only supported for single-node deletions (node_ids must have exactly one element)."
        ),
        expected_version: z.number().describe(EXPECTED_VERSION_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
        deleted_count: z.number().describe("Number of nodes deleted"),
        promoted_children: z.number().optional().describe("Number of direct children promoted to parent (only when include_children is false)"),
        version_warning: z.string().optional().describe("Warning if a concurrent edit was detected during the write."),
      },
    },
    wrapToolHandler(async ({
      file_id,
      node_ids,
      include_children,
      expected_version,
    }: {
      file_id: string;
      node_ids: string[];
      include_children: boolean;
      expected_version: number;
    }) => {
      if (node_ids.length === 0) {
        return makeErrorResponse("InvalidInput", "No nodes to delete (empty array).");
      }

      if (!include_children && node_ids.length > 1) {
        return makeErrorResponse(
          "InvalidInput",
          "include_children: false is only supported for single-node deletions (node_ids must have exactly one element).",
        );
      }

      // Reject duplicates.
      const seen = new Set<string>();
      for (const id of node_ids) {
        if (seen.has(id)) {
          return makeErrorResponse("InvalidInput", `Duplicate node_id '${id}' in array.`);
        }
        seen.add(id);
      }

      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      // Reject deleting the root node (literal "root" string check, no read needed).
      if (node_ids.includes("root")) {
        return makeErrorResponse("InvalidInput", "Cannot delete the root node of a document.");
      }

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedVersion: expected_version, store },
        async (): Promise<{ result: { deleted_count: number; promoted_children?: number }; apiCallCount: number }> => {
          const doc = await store.read(file_id);
          const rootId = findRootNodeId(doc.nodes);
          const nodeMap = buildNodeMap(doc.nodes);
          const parentMap = buildParentMap(doc.nodes);

          // Validate all node IDs exist and none are the root.
          for (const id of node_ids) {
            if (id === rootId) {
              throw new ToolInputError("InvalidInput", "Cannot delete the root node of a document.");
            }
            if (!nodeMap.has(id)) {
              throw new ToolInputError("NodeNotFound", `Node '${id}' not found in document.`);
            }
          }

          // Child promotion path (single node only).
          if (!include_children) {
            const node_id = node_ids[0];
            const targetNode = nodeMap.get(node_id)!;

            if (targetNode.children && targetNode.children.length > 0) {
              const parentInfo = parentMap.get(node_id);
              if (!parentInfo) {
                throw new ToolInputError("NodeNotFound", "Could not find parent of node to delete.");
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
              const moveResponse = await client.editDocument(file_id, moveChanges);

              // Now delete just the (now childless) node.
              const deleteResponse = await client.editDocument(file_id, [{ action: "delete", node_id }]);

              return {
                result: { deleted_count: 1, promoted_children: promotedCount },
                apiCallCount: moveResponse.batches_sent + deleteResponse.batches_sent,
              };
            }

            // Leaf node with include_children: false. Just delete it.
            const response = await client.editDocument(file_id, [{ action: "delete", node_id }]);
            return {
              result: { deleted_count: 1, promoted_children: 0 },
              apiCallCount: response.batches_sent,
            };
          }

          // Subtree deletion path (one or more nodes).
          const deleteSet = new Set(node_ids);

          // Deduplicate: skip nodes whose ancestor is also in deleteSet.
          const deduped: string[] = [];
          for (const id of node_ids) {
            let dominated = false;
            let cursor = parentMap.get(id);
            while (cursor) {
              if (deleteSet.has(cursor.parentId)) {
                dominated = true;
                break;
              }
              cursor = parentMap.get(cursor.parentId);
            }
            if (!dominated) deduped.push(id);
          }

          // Collect full subtrees via DFS.
          const allToDelete: string[] = [];
          function collectSubtree(id: string) {
            allToDelete.push(id);
            const node = nodeMap.get(id);
            if (node?.children) {
              for (const childId of node.children) {
                collectSubtree(childId);
              }
            }
          }
          for (const id of deduped) {
            collectSubtree(id);
          }

          // Delete in reverse (children before parents). This ordering makes the
          // operation idempotent on partial failure: if batching is interrupted
          // mid-way (rate limit exhaustion, server restart, etc.), only leaf nodes
          // have been deleted and the remaining nodes are still connected to the
          // tree. Retrying the tool call re-reads the document, re-collects the
          // surviving subtree, and deletes the rest. Parent-first ordering would
          // orphan children on partial failure with no way to recover them.
          const changes = allToDelete.reverse().map(id => ({ action: "delete" as const, node_id: id }));

          const response = await client.editDocument(file_id, changes);
          return {
            result: { deleted_count: allToDelete.length },
            apiCallCount: response.batches_sent,
          };
        },
      );

      const data: Record<string, unknown> = {
        file_id,
        deleted_count: guard.result.deleted_count,
      };
      if (guard.result.promoted_children !== undefined) {
        data.promoted_children = guard.result.promoted_children;
      }
      if (guard.versionWarning) data.version_warning = guard.versionWarning;

      return makeResponse(data);
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: move_nodes
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "move_nodes",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Move one or more nodes (and their subtrees) to new positions within a Dynalist document. " +
        "Moves are applied sequentially, so later moves can reference positions created by earlier " +
        "moves. For a single move, pass a one-element array.\n\n" +
        "Position values:\n" +
        "- 'after': place immediately after the reference (same parent).\n" +
        "- 'before': place immediately before the reference (same parent).\n" +
        "- 'first_child': place as the first child inside the reference.\n" +
        "- 'last_child': place as the last child inside the reference.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        moves: z.array(z.object({
          node_id: z.string().describe("Node to move (its entire subtree moves with it)"),
          reference_node_id: z.string().describe("Reference node for positioning"),
          position: z.enum(["after", "before", "first_child", "last_child"]).describe(
            "'after' = immediately after reference (same parent), " +
            "'before' = immediately before reference (same parent), " +
            "'first_child' = as first child of reference, " +
            "'last_child' = as last child of reference."
          ),
        })).describe("Array of moves to apply sequentially."),
        expected_version: z.number().describe(EXPECTED_VERSION_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
        moved_count: z.number().describe("Number of nodes moved"),
        node_ids: z.array(z.string()).describe("IDs of all moved nodes"),
        version_warning: z.string().optional().describe("Warning if a concurrent edit was detected during the write."),
      },
    },
    wrapToolHandler(async ({
      file_id,
      moves,
      expected_version,
    }: {
      file_id: string;
      moves: Array<{
        node_id: string;
        reference_node_id: string;
        position: string;
      }>;
      expected_version: number;
    }) => {
      if (moves.length === 0) {
        return makeErrorResponse("InvalidInput", "No moves to apply (empty array).");
      }

      const config = getConfig();

      // Access check: only document-level policy is checked for within-document moves.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedVersion: expected_version, store },
        async () => {
          const doc = await store.read(file_id);
          const nodeMap = buildNodeMap(doc.nodes);

          // Build mutable state: childrenMap and parentMap that we update
          // after each move so that later moves see the effects of earlier ones.
          const childrenMap = new Map<string, string[]>();
          const parentMap = new Map<string, { parentId: string; index: number }>();

          for (const node of doc.nodes) {
            const children = node.children ? [...node.children] : [];
            childrenMap.set(node.id, children);
            for (let i = 0; i < children.length; i++) {
              parentMap.set(children[i], { parentId: node.id, index: i });
            }
          }

          // Check descendancy using the mutable childrenMap.
          function isDescendant(ancestorId: string, targetId: string): boolean {
            const children = childrenMap.get(ancestorId);
            if (!children) return false;
            for (const childId of children) {
              if (childId === targetId) return true;
              if (isDescendant(childId, targetId)) return true;
            }
            return false;
          }

          const allChanges: Array<{ action: "move"; node_id: string; parent_id: string; index: number }> = [];

          for (const move of moves) {
            const { node_id, reference_node_id, position } = move;

            if (!nodeMap.has(node_id)) {
              throw new ToolInputError("NodeNotFound", `Node '${node_id}' not found in document.`);
            }
            if (!nodeMap.has(reference_node_id)) {
              throw new ToolInputError("NodeNotFound", `Reference node '${reference_node_id}' not found in document.`);
            }
            if (node_id === reference_node_id) {
              throw new ToolInputError("InvalidInput", "Cannot move a node relative to itself.");
            }

            let targetParentId: string;
            let targetIndex: number;

            if (position === "first_child") {
              targetParentId = reference_node_id;
              targetIndex = 0;
            } else if (position === "last_child") {
              targetParentId = reference_node_id;
              // Resolve to an explicit index rather than passing -1 to the API.
              // The API resolves -1 against a snapshot taken before the batch,
              // so multiple last_child moves to the same parent would all resolve
              // to the same position and reverse. Using the mutable child count
              // gives each move a distinct sequential index.
              const siblings = childrenMap.get(reference_node_id) ?? [];
              targetIndex = siblings.length;
            } else {
              // "after" or "before": find the parent of the reference node.
              const refParentInfo = parentMap.get(reference_node_id);
              if (!refParentInfo) {
                throw new ToolInputError("NodeNotFound", "Could not find parent of reference node.");
              }

              targetParentId = refParentInfo.parentId;
              targetIndex = position === "after" ? refParentInfo.index + 1 : refParentInfo.index;
            }

            if (node_id === targetParentId || isDescendant(node_id, targetParentId)) {
              throw new ToolInputError("InvalidInput", "Cannot move a node into one of its own descendants.");
            }

            // The API uses post-removal indexing: it removes the node first,
            // then inserts at the given index. When moving within the same
            // parent and the node is earlier than the target, the removal
            // shifts the target index down by 1, so we must compensate.
            let apiIndex = targetIndex;
            const movedNodeInfo = parentMap.get(node_id);
            if (movedNodeInfo && movedNodeInfo.parentId === targetParentId && movedNodeInfo.index < apiIndex) {
              apiIndex--;
            }

            allChanges.push({ action: "move", node_id, parent_id: targetParentId, index: apiIndex });

            // Update mutable state so subsequent moves see this move's effect.
            if (movedNodeInfo) {
              const oldSiblings = childrenMap.get(movedNodeInfo.parentId)!;
              oldSiblings.splice(movedNodeInfo.index, 1);

              // Rebuild parentMap for the old parent's remaining children.
              for (let i = 0; i < oldSiblings.length; i++) {
                parentMap.set(oldSiblings[i], { parentId: movedNodeInfo.parentId, index: i });
              }
            }

            // Insert into new parent's children. Use targetIndex (pre-removal)
            // for the mutable state since we already removed the node above.
            const newSiblings = childrenMap.get(targetParentId) ?? [];
            const insertAt = movedNodeInfo && movedNodeInfo.parentId === targetParentId && movedNodeInfo.index < targetIndex
              ? targetIndex - 1
              : targetIndex;
            newSiblings.splice(insertAt, 0, node_id);

            // Rebuild parentMap for the new parent's children.
            for (let i = 0; i < newSiblings.length; i++) {
              parentMap.set(newSiblings[i], { parentId: targetParentId, index: i });
            }
          }

          const response = await client.editDocument(file_id, allChanges);
          return { result: undefined, apiCallCount: response.batches_sent };
        },
      );

      const nodeIds = moves.map((m) => m.node_id);
      const data: Record<string, unknown> = {
        file_id,
        moved_count: moves.length,
        node_ids: nodeIds,
      };
      if (guard.versionWarning) data.version_warning = guard.versionWarning;

      return makeResponse(data);
    })
  );
}
