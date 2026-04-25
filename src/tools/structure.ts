/**
 * Structure tools: delete_items, move_items.
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
  editDocumentWithPartialGuard,
  ToolInputError,
  PartialWriteError,
} from "../utils/dynalist-helpers";
import type { DocumentStore } from "../document-store";
import {
  FILE_ID_DESCRIPTION, SYNC_WARNING_DESCRIPTION,
  CONFIRM_GUIDANCE, EXPECTED_SYNC_TOKEN_DESCRIPTION,
  REREAD_GUIDANCE,
  INSTRUCTIONS_FIRST_GUIDANCE,
} from "./descriptions";

export function registerStructureTools(server: McpServer, client: DynalistClient, ac: AccessController, store: DocumentStore): void {
  server.registerTool(
    "delete_items",
    {
      description:
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
        `${CONFIRM_GUIDANCE} ` +
        "Delete items and their subtrees from a document.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        item_ids: z.array(z.string()).describe("Item IDs to delete."),
        children: z.enum(["delete", "promote"]).optional().default("delete").describe(
          "What to do with children of deleted items. 'delete': remove entire subtree. " +
          "'promote': re-parent children to the deleted item's parent " +
          "(single-item only; use to remove a grouping item while keeping its children)."
        ),
        expected_sync_token: z.string().describe(EXPECTED_SYNC_TOKEN_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        deleted_count: z.number().describe("Number of items deleted (targets and all descendants if children not promoted)."),
        promoted_children_count: z.number().optional().describe("Number of direct children promoted to parent (only when children is 'promote')"),
        sync_warning: z.string().optional().describe(SYNC_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      item_ids,
      children: childrenMode,
      expected_sync_token,
    }: {
      file_id: string;
      item_ids: string[];
      children: "delete" | "promote";
      expected_sync_token: string;
    }) => {
      if (item_ids.length === 0) {
        return makeErrorResponse("InvalidInput", "No items to delete (empty array).");
      }

      if (childrenMode === "promote" && item_ids.length > 1) {
        return makeErrorResponse(
          "InvalidInput",
          "children: 'promote' is only supported for single-item deletions (item_ids must have exactly one element).",
        );
      }

      // Reject duplicates.
      const seen = new Set<string>();
      for (const id of item_ids) {
        if (seen.has(id)) {
          return makeErrorResponse("InvalidInput", `Duplicate item_id '${id}' in array.`);
        }
        seen.add(id);
      }

      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      // Reject deleting the root item (literal "root" string check, no read needed).
      if (item_ids.includes("root")) {
        return makeErrorResponse("InvalidInput", "Cannot delete the root item of a document.");
      }

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedSyncToken: expected_sync_token, store },
        async (): Promise<{ result: { deleted_count: number; promoted_children_count?: number }; apiCallCount: number }> => {
          const doc = await store.read(file_id);
          const rootId = findRootNodeId(doc.nodes);
          const nodeMap = buildNodeMap(doc.nodes);
          const parentMap = buildParentMap(doc.nodes);

          // Validate all item IDs exist and none are the root.
          for (const id of item_ids) {
            if (id === rootId) {
              throw new ToolInputError("InvalidInput", "Cannot delete the root item of a document.");
            }
            if (!nodeMap.has(id)) {
              throw new ToolInputError("ItemNotFound", `Item '${id}' not found in document.`);
            }
          }

          // Child promotion path (single item only).
          if (childrenMode === "promote") {
            const node_id = item_ids[0];
            const targetNode = nodeMap.get(node_id)!;

            if (targetNode.children && targetNode.children.length > 0) {
              const parentInfo = parentMap.get(node_id);
              if (!parentInfo) {
                throw new ToolInputError("ItemNotFound", "Could not find parent of item to delete.");
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
              const moveResponse = await editDocumentWithPartialGuard(client, file_id, moveChanges);

              // Now delete just the (now childless) node. The move already
              // succeeded, so if the delete fails the children are promoted
              // but the parent still exists.
              let deleteResponse;
              try {
                deleteResponse = await client.editDocument(file_id, [{ action: "delete", node_id }]);
              } catch (error) {
                throw new PartialWriteError({
                  fileId: file_id,
                  message: `Children were promoted but the parent item was not deleted. ${REREAD_GUIDANCE}`,
                  cause: error,
                });
              }

              return {
                result: { deleted_count: 1, promoted_children_count: promotedCount },
                apiCallCount: moveResponse.batches_sent + deleteResponse.batches_sent,
              };
            }

            // Leaf node (no children to promote). Just delete it.
            const response = await client.editDocument(file_id, [{ action: "delete", node_id }]);
            return {
              result: { deleted_count: 1, promoted_children_count: 0 },
              apiCallCount: response.batches_sent,
            };
          }

          // Subtree deletion path (one or more items).
          const deleteSet = new Set(item_ids);

          // Deduplicate: skip items whose ancestor is also in deleteSet.
          const deduped: string[] = [];
          for (const id of item_ids) {
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

          const response = await editDocumentWithPartialGuard(client, file_id, changes);
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
      if (guard.result.promoted_children_count !== undefined) {
        data.promoted_children_count = guard.result.promoted_children_count;
      }
      if (guard.syncWarning) data.sync_warning = guard.syncWarning;

      return makeResponse(data);
    })
  );

  server.registerTool(
    "move_items",
    {
      description:
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
        `${CONFIRM_GUIDANCE} ` +
        "Move items (with subtrees) to new positions in a document. Moves within a single " +
        "call are applied sequentially; later moves see earlier moves' effects.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        moves: z.array(z.object({
          item_id: z.string().describe("Item to move (subtree included)"),
          reference_item_id: z.string().describe("Reference item for positioning"),
          position: z.enum(["after", "before", "first_child", "last_child"]).describe(
            "'after'/'before': sibling of reference (same parent). " +
            "'first_child'/'last_child': child of reference."
          ),
        }).strict()).describe("Array of moves to apply sequentially."),
        expected_sync_token: z.string().describe(EXPECTED_SYNC_TOKEN_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        moved_count: z.number().describe("Number of items moved"),
        sync_warning: z.string().optional().describe(SYNC_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      moves,
      expected_sync_token,
    }: {
      file_id: string;
      moves: Array<{
        item_id: string;
        reference_item_id: string;
        position: string;
      }>;
      expected_sync_token: string;
    }) => {
      if (moves.length === 0) {
        return makeErrorResponse("InvalidInput", "No moves to apply (empty array).");
      }

      // Reject moving the root item (literal "root" string check, no read needed).
      //
      // The Dynalist API does not reject this; it corrupts and permanently locks
      // the document. See docs/dynalist-api-behavior.md.
      for (const move of moves) {
        if (move.item_id === "root") {
          return makeErrorResponse("InvalidInput", "Cannot move the root item of a document.");
        }
      }

      const config = getConfig();

      // Access check: only document-level policy is checked for within-document moves.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedSyncToken: expected_sync_token, store },
        async () => {
          const doc = await store.read(file_id);
          const rootId = findRootNodeId(doc.nodes);
          const nodeMap = buildNodeMap(doc.nodes);

          // Validate no move targets the root item (by actual ID).
          for (const move of moves) {
            if (move.item_id === rootId) {
              throw new ToolInputError("InvalidInput", "Cannot move the root item of a document.");
            }
          }

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

          // Check descendancy using the mutable childrenMap. Depth is
          // capped at 1000 as a safety guard against corrupted cyclic data.
          // If the limit is hit, we conservatively return true (rejects the
          // move rather than allowing a potentially cyclic one).
          const MAX_DESCENDANT_DEPTH = 1000;
          function isDescendant(ancestorId: string, targetId: string, depth: number = 0): boolean {
            if (depth >= MAX_DESCENDANT_DEPTH) return true;
            const children = childrenMap.get(ancestorId);
            if (!children) return false;
            for (const childId of children) {
              if (childId === targetId) return true;
              if (isDescendant(childId, targetId, depth + 1)) return true;
            }
            return false;
          }

          const allChanges: Array<{ action: "move"; node_id: string; parent_id: string; index: number }> = [];

          for (const move of moves) {
            const { item_id, reference_item_id, position } = move;

            if (!nodeMap.has(item_id)) {
              throw new ToolInputError("ItemNotFound", `Item '${item_id}' not found in document.`);
            }
            if (!nodeMap.has(reference_item_id)) {
              throw new ToolInputError("ItemNotFound", `Reference item '${reference_item_id}' not found in document.`);
            }
            if (item_id === reference_item_id) {
              throw new ToolInputError("InvalidInput", "Cannot move an item relative to itself.");
            }

            let targetParentId: string;
            let targetIndex: number;

            if (position === "first_child") {
              targetParentId = reference_item_id;
              targetIndex = 0;
            } else if (position === "last_child") {
              targetParentId = reference_item_id;
              // Resolve to an explicit index rather than passing -1 to the API.
              // The API resolves -1 against a snapshot taken before the batch,
              // so multiple last_child moves to the same parent would all resolve
              // to the same position and reverse. Using the mutable child count
              // gives each move a distinct sequential index.
              const siblings = childrenMap.get(reference_item_id) ?? [];
              targetIndex = siblings.length;
            } else {
              // "after" or "before": find the parent of the reference node.
              const refParentInfo = parentMap.get(reference_item_id);
              if (!refParentInfo) {
                throw new ToolInputError("ItemNotFound", "Could not find parent of reference item.");
              }

              targetParentId = refParentInfo.parentId;
              targetIndex = position === "after" ? refParentInfo.index + 1 : refParentInfo.index;
            }

            if (item_id === targetParentId || isDescendant(item_id, targetParentId)) {
              throw new ToolInputError("InvalidInput", "Cannot move an item into one of its own descendants.");
            }

            // The API uses post-removal indexing: it removes the node first,
            // then inserts at the given index. When moving within the same
            // parent and the node is earlier than the target, the removal
            // shifts the target index down by 1, so we must compensate.
            let apiIndex = targetIndex;
            const movedNodeInfo = parentMap.get(item_id);
            if (movedNodeInfo && movedNodeInfo.parentId === targetParentId && movedNodeInfo.index < apiIndex) {
              apiIndex--;
            }

            allChanges.push({ action: "move", node_id: item_id, parent_id: targetParentId, index: apiIndex });

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
            newSiblings.splice(insertAt, 0, item_id);

            // Rebuild parentMap for the new parent's children.
            for (let i = 0; i < newSiblings.length; i++) {
              parentMap.set(newSiblings[i], { parentId: targetParentId, index: i });
            }
          }

          const response = await editDocumentWithPartialGuard(client, file_id, allChanges);
          return { result: undefined, apiCallCount: response.batches_sent };
        },
      );

      const data: Record<string, unknown> = {
        file_id,
        moved_count: moves.length,
      };
      if (guard.syncWarning) data.sync_warning = guard.syncWarning;

      return makeResponse(data);
    })
  );
}
