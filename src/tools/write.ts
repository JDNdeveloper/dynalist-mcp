/**
 * Write tools: send_to_inbox, edit_items, insert_items.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, EditDocumentChange, buildNodeMap, buildParentMap, findRootNodeId, type ReadDocumentResponse } from "../dynalist-client";
import { getConfig, type Config } from "../config";
import { AccessController, requireAccess, type Policy } from "../access-control";
import { withVersionGuard } from "../version-guard";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
  insertTreeUnderParent,
  editDocumentWithPartialGuard,
  ToolInputError,
  type ParsedNode,
} from "../utils/dynalist-helpers";
import type { DocumentStore } from "../document-store";
import {
  FILE_ID_DESCRIPTION, ITEM_ID_DESCRIPTION,
  SYNC_WARNING_DESCRIPTION, SHOW_CHECKBOX_DESCRIPTION,
  CHECKED_DESCRIPTION,
  HEADING_DESCRIPTION, COLOR_DESCRIPTION, CONFIRM_GUIDANCE, MULTILINE_GUIDANCE,
  CONTENT_MULTILINE_GUIDANCE, EXPECTED_SYNC_TOKEN_DESCRIPTION,
} from "./descriptions";
import { HEADING_VALUES, COLOR_VALUES, HEADING_TO_NUMBER, COLOR_TO_NUMBER } from "./node-metadata";
import type { HeadingValue, ColorValue } from "./node-metadata";

/**
 * Check whether the global access policy blocks all write operations.
 * Used by send_to_inbox, where the target document's file_id is not known
 * ahead of time (the Dynalist inbox API only reveals it upon sending).
 *
 * Returns an error descriptor if writes are globally blocked, or null if
 * at least some documents could be writable (meaning inbox might be too).
 */
function checkGlobalWriteBlock(
  access: NonNullable<Config["access"]>,
): { error: string; message: string } | null {
  // If any path-specific rule grants allow, the inbox could be covered by
  // it, so we cannot preemptively block.
  const hasNonGlobalAllow = access.rules.some(
    r => r.policy === "allow" && r.path !== "/**" && r.path !== "/*",
  );
  if (hasNonGlobalAllow) return null;

  // No path-specific allow rules. A global rule (/** or /*) overrides the
  // default for all top-level documents, which includes the inbox.
  const globalRule = access.rules.find(r => r.path === "/**" || r.path === "/*");
  const effectivePolicy: Policy = globalRule?.policy ?? access.default;

  return requireAccess(effectivePolicy, "write");
}

export function registerWriteTools(server: McpServer, client: DynalistClient, ac: AccessController, store: DocumentStore): void {
  server.registerTool(
    "send_to_inbox",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Send an item to the Dynalist inbox. Target is the user's configured inbox. " +
        "Returns the inbox document's file_id and created item_id. " +
        "For specific documents or hierarchical content, use insert_items.",
      inputSchema: {
        content: z.string().describe("The text content for the inbox item."),
        note: z.string().optional().describe("Optional note for the item."),
        checked: z.boolean().optional().describe(CHECKED_DESCRIPTION),
        show_checkbox: z.boolean().optional().describe(
          `Whether to add a checkbox. ${SHOW_CHECKBOX_DESCRIPTION}`
        ),
        heading: z.enum(HEADING_VALUES).optional().describe(HEADING_DESCRIPTION),
        color: z.enum(COLOR_VALUES).optional().describe(COLOR_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        item_id: z.string().describe(ITEM_ID_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({ content, note, show_checkbox, heading, color, checked }: { content: string; note?: string; show_checkbox?: boolean; heading?: HeadingValue; color?: ColorValue; checked?: boolean }) => {
      const config = getConfig();

      // The Dynalist inbox API does not expose the inbox file_id without
      // actually sending an item, so we cannot resolve the inbox document's
      // path for a per-document ACL check. Instead, check whether the global
      // access policy makes it impossible for any document to be writable.
      // If no document can be writable, the inbox cannot be either.
      if (config.access) {
        const accessError = checkGlobalWriteBlock(config.access);
        if (accessError) return makeErrorResponse(accessError.error, accessError.message);
      }

      if (!content.trim()) {
        return makeErrorResponse("InvalidInput", "No content to add (empty input)");
      }

      const response = await client.sendToInbox({
        content,
        note,
        checkbox: show_checkbox,
        heading: heading !== undefined ? HEADING_TO_NUMBER[heading] : undefined,
        color: color !== undefined ? COLOR_TO_NUMBER[color] : undefined,
        checked,
      });

      // Invalidate the inbox document's cache entry since its content changed.
      store.invalidate(response.file_id);

      return makeResponse({
        file_id: response.file_id,
        item_id: response.node_id,
      });
    })
  );

  server.registerTool(
    "edit_items",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Edit one or more items in a document. Only specified fields are updated; " +
        "omitted fields are unchanged.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        items: z.array(z.object({
          item_id: z.string().describe("Item ID to edit"),
          content: z.string().optional().describe(`New content text. ${CONTENT_MULTILINE_GUIDANCE}`),
          note: z.string().optional().describe(`New note text. ${MULTILINE_GUIDANCE} Set to '' to clear.`),
          checked: z.boolean().optional().describe(CHECKED_DESCRIPTION),
          show_checkbox: z.boolean().optional().describe(
            `Whether to show a checkbox on this item. ${SHOW_CHECKBOX_DESCRIPTION}`
          ),
          heading: z.enum(HEADING_VALUES).optional().describe(HEADING_DESCRIPTION),
          color: z.enum(COLOR_VALUES).optional().describe(COLOR_DESCRIPTION),
        }).strict()).describe("Array of item edits to apply."),
        expected_sync_token: z.string().describe(EXPECTED_SYNC_TOKEN_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        edited_count: z.number().describe("Number of items edited"),
        sync_warning: z.string().optional().describe(SYNC_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      items,
      expected_sync_token,
    }: {
      file_id: string;
      items: Array<{
        item_id: string;
        content?: string;
        note?: string;
        checked?: boolean;
        show_checkbox?: boolean;
        heading?: HeadingValue;
        color?: ColorValue;
      }>;
      expected_sync_token: string;
    }) => {
      if (items.length === 0) {
        return makeErrorResponse("InvalidInput", "No items to edit (empty array).");
      }

      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const changes: EditDocumentChange[] = items.map((entry) => {
        const change: EditDocumentChange = {
          action: "edit",
          node_id: entry.item_id,
        };

        // Only include fields that are explicitly set.
        if (entry.content !== undefined) change.content = entry.content;
        if (entry.note !== undefined) change.note = entry.note;
        if (entry.checked !== undefined) change.checked = entry.checked;
        if (entry.show_checkbox !== undefined) change.checkbox = entry.show_checkbox;
        if (entry.heading !== undefined) change.heading = HEADING_TO_NUMBER[entry.heading];
        if (entry.color !== undefined) change.color = COLOR_TO_NUMBER[entry.color];

        return change;
      });

      // Validate that each entry has at least one mutable field.
      for (const entry of items) {
        const hasMutable =
          entry.content !== undefined ||
          entry.note !== undefined ||
          entry.checked !== undefined ||
          entry.show_checkbox !== undefined ||
          entry.heading !== undefined ||
          entry.color !== undefined;
        if (!hasMutable) {
          return makeErrorResponse("InvalidInput", `Item '${entry.item_id}' has no fields to edit.`);
        }
      }

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedSyncToken: expected_sync_token, store },
        async () => {
          // Pre-validate that all item IDs exist in the document.
          const doc = await store.read(file_id);
          const nodeMap = buildNodeMap(doc.nodes);
          for (const entry of items) {
            if (!nodeMap.has(entry.item_id)) {
              throw new ToolInputError("ItemNotFound", `Item '${entry.item_id}' not found in document.`);
            }
          }

          const response = await editDocumentWithPartialGuard(client, file_id, changes);
          return { result: undefined, apiCallCount: response.batches_sent };
        },
      );

      const data: Record<string, unknown> = {
        file_id,
        edited_count: items.length,
      };
      if (guard.syncWarning) data.sync_warning = guard.syncWarning;

      return makeResponse(data);
    })
  );

  // Recursive Zod schema for JSON input nodes.
  const jsonInputNodeSchema: z.ZodType<{
    content: string;
    note?: string;
    checked?: boolean;
    show_checkbox?: boolean;
    heading?: HeadingValue;
    color?: ColorValue;
    children?: unknown[];
  }> = z.lazy(() =>
    z.object({
      content: z.string().describe(`Content text. ${CONTENT_MULTILINE_GUIDANCE}`),
      note: z.string().optional().describe(`Note text. ${MULTILINE_GUIDANCE}`),
      checked: z.boolean().optional().describe(CHECKED_DESCRIPTION),
      show_checkbox: z.boolean().optional().describe(
        `Whether to add a checkbox. ${SHOW_CHECKBOX_DESCRIPTION}`
      ),
      heading: z.enum(HEADING_VALUES).optional().describe(HEADING_DESCRIPTION),
      color: z.enum(COLOR_VALUES).optional().describe(COLOR_DESCRIPTION),
      children: z.array(jsonInputNodeSchema).optional().describe("Child items"),
    }).strict()
  );

  server.registerTool(
    "insert_items",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Insert items into a document as a JSON tree. Supports nested children and " +
        "per-item metadata.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        items: z.array(jsonInputNodeSchema).describe("Array of items to insert"),
        position: z.enum(["first_child", "last_child", "after", "before"])
          .describe(
            "Insertion target. 'last_child' (most common): append under parent. " +
            "'first_child': prepend under parent. " +
            "'after'/'before': sibling-relative placement (reference_item_id required)."
          ),
        reference_item_id: z.string().optional().describe(
          "For first_child/last_child: the parent item. Omit for document root. " +
          "For after/before: the sibling item (required). Cannot be the root item for after/before."
        ),
        index: z.number().optional().describe(
          "Exact child index within the parent. 0 = first, -1 = last. " +
          "Only valid with first_child/last_child. Cannot combine with reference_item_id for sibling positions."
        ),
        expected_sync_token: z.string().describe(EXPECTED_SYNC_TOKEN_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        total_created: z.number().describe("Total number of items created"),
        root_item_ids: z.array(z.string()).describe("IDs of all top-level inserted items"),
        sync_warning: z.string().optional().describe(SYNC_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      items,
      position,
      reference_item_id,
      index,
      expected_sync_token,
    }: {
      file_id: string;
      items: unknown[];
      position: string;
      reference_item_id?: string;
      index?: number;
      expected_sync_token: string;
    }) => {
      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const isSiblingPosition = position === "after" || position === "before";

      // Validate parameter combinations.
      if (isSiblingPosition && reference_item_id === undefined) {
        return makeErrorResponse("InvalidInput", "after/before requires reference_item_id; root has no siblings.");
      }
      if (isSiblingPosition && index !== undefined) {
        return makeErrorResponse("InvalidInput", "Cannot specify index with after/before positions.");
      }

      // Convert JSON input to ParsedNode tree (no doc read needed).
      const tree = jsonInputToTree(items as JsonInputNode[]);
      if (tree.length === 0) {
        return makeErrorResponse("InvalidInput", "No items to insert (empty array)");
      }

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedSyncToken: expected_sync_token, store },
        async () => {
          let parentNodeId: string | undefined;
          let startIndex: number | undefined;

          if (isSiblingPosition) {
            // Sibling-relative positioning: resolve parent and index from the reference node.
            const doc = await store.read(file_id);
            const rootId = findRootNodeId(doc.nodes);

            // The root item has no parent, so it cannot be used as a sibling reference.
            if (reference_item_id === rootId) {
              throw new ToolInputError("InvalidInput", "Cannot use root item as reference for after/before; root has no parent.");
            }

            const parentMap = buildParentMap(doc.nodes);
            const refInfo = parentMap.get(reference_item_id!);

            if (!refInfo) {
              throw new ToolInputError("ItemNotFound", `Reference item '${reference_item_id}' not found in document.`);
            }

            parentNodeId = refInfo.parentId;
            startIndex = position === "after" ? refInfo.index + 1 : refInfo.index;
          } else {
            // Child positioning (first_child / last_child / index).
            // reference_item_id is the parent for child positions.
            parentNodeId = reference_item_id;

            // The Dynalist API snapshots parent state before processing a batch,
            // so sending index -1 for every item in a batch causes them to all
            // resolve to the same position and reverse. For multi-item inserts we
            // resolve to explicit indices to preserve input order.
            let doc: ReadDocumentResponse | undefined;
            if (!parentNodeId) {
              doc = await store.read(file_id);
              parentNodeId = findRootNodeId(doc.nodes);
            } else {
              // Validate that the specified parent node exists in the document.
              doc = await store.read(file_id);
              const parentNode = doc.nodes.find(n => n.id === parentNodeId);
              if (!parentNode) {
                throw new ToolInputError("ItemNotFound", `Parent item '${parentNodeId}' not found in document.`);
              }
            }

            if (index !== undefined && index !== -1) {
              startIndex = index;
            } else if (position === "first_child") {
              startIndex = 0;
            } else if (items.length <= 1) {
              // Single item: index -1 is unambiguous, no read needed.
              startIndex = undefined;
            } else {
              // last_child or index: -1 with multiple items.
              // Resolve to the parent's current child count so each item gets
              // a distinct index instead of all resolving to the same position.
              if (!doc) doc = await store.read(file_id);
              const parentNode = doc.nodes.find(n => n.id === parentNodeId);
              startIndex = parentNode?.children?.length ?? 0;
            }
          }

          const insertResult = await insertTreeUnderParent(client, file_id, parentNodeId, tree, {
            startIndex,
          });
          return { result: insertResult, apiCallCount: insertResult.batchesSent };
        },
      );

      const insertResult = guard.result;

      const data: Record<string, unknown> = {
        file_id,
        total_created: insertResult.totalCreated,
        root_item_ids: insertResult.rootNodeIds,
      };
      if (guard.syncWarning) data.sync_warning = guard.syncWarning;

      return makeResponse(data);
    })
  );
}

interface JsonInputNode {
  content: string;
  note?: string;
  checked?: boolean;
  show_checkbox?: boolean;
  heading?: HeadingValue;
  color?: ColorValue;
  children?: JsonInputNode[];
}

/**
 * Convert JSON input nodes to the ParsedNode tree used by insertTreeUnderParent.
 */
function jsonInputToTree(nodes: JsonInputNode[]): ParsedNode[] {
  return nodes.map((node) => ({
    content: node.content,
    note: node.note,
    checked: node.checked,
    show_checkbox: node.show_checkbox,
    heading: node.heading,
    color: node.color,
    children: node.children ? jsonInputToTree(node.children) : [],
  }));
}
