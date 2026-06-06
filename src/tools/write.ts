/**
 * Write tools: send_to_inbox, edit_items, insert_items.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, EditDocumentChange, buildNodeMap, buildParentMap, findRootNodeId } from "../dynalist-client";
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
  INSTRUCTIONS_FIRST_GUIDANCE,
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
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
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
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
        `${CONFIRM_GUIDANCE} ` +
        "Edit one or more items in a document. Only specified fields are updated; " +
        "omitted fields are unchanged. Only include fields the user explicitly asked " +
        "to change; do NOT clear fields (e.g. color, heading) as a side effect.",
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
      children: z.array(jsonInputNodeSchema).optional().describe(
        "Recursive child item objects. Each child uses the same fields as an items element " +
        "and can contain its own children. Pass objects, not strings or item IDs, " +
        "even if your client renders this field as a primitive array."
      ),
    }).strict()
  );

  server.registerTool(
    "insert_items",
    {
      description:
        `${INSTRUCTIONS_FIRST_GUIDANCE} ` +
        `${CONFIRM_GUIDANCE} ` +
        "Insert items into a document as JSON trees. Each insertion targets an " +
        "independent location, allowing inserts at different positions in a single " +
        "call. Each insertion supports nested children and per-item metadata.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        expected_sync_token: z.string().describe(EXPECTED_SYNC_TOKEN_DESCRIPTION),
        insertions: z.array(z.object({
          position: z.enum(["after", "before", "first_child", "last_child"])
            .describe(
              "Insertion target. 'after'/'before': sibling-relative placement " +
              "(reference_item_id required). 'first_child': prepend under parent. " +
              "'last_child' (most common): append under parent."
            ),
          reference_item_id: z.string().optional().describe(
            "For after/before: the sibling item (required). Cannot be the root item. " +
            "For first_child/last_child: the parent item. Omit for document root."
          ),
          items: z.array(jsonInputNodeSchema).describe(
            "Array of item objects to insert. Each item can include recursive children."
          ),
        }).strict()).describe(
          "Array of independent insertions. Each targets its own location, so items " +
          "can be placed at different parents or siblings in a single call."
        ),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        created_count: z.number().describe("Total number of items created across all insertions"),
        sync_warning: z.string().optional().describe(SYNC_WARNING_DESCRIPTION),
        insertions: z.array(z.object({
          created_count: z.number().describe("Number of items created by this insertion"),
          root_item_ids: z.array(z.string()).describe("IDs of the top-level inserted items for this insertion"),
        }).strict()).describe("Per-insertion results in the same order as the input insertions"),
      },
    },
    wrapToolHandler(async ({
      file_id,
      expected_sync_token,
      insertions,
    }: {
      file_id: string;
      expected_sync_token: string;
      insertions: Array<{
        position: string;
        reference_item_id?: string;
        items: unknown[];
      }>;
    }) => {
      if (insertions.length === 0) {
        return makeErrorResponse("InvalidInput", "No insertions specified (empty array).");
      }

      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      // Validate all insertions upfront before any API calls.
      for (const insertion of insertions) {
        const isSibling = insertion.position === "after" || insertion.position === "before";
        if (isSibling && insertion.reference_item_id === undefined) {
          return makeErrorResponse("InvalidInput", "after/before requires reference_item_id.");
        }
        if ((insertion.items as JsonInputNode[]).length === 0) {
          return makeErrorResponse("InvalidInput", "Each insertion must have at least one item (empty items array).");
        }
      }

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedSyncToken: expected_sync_token, store },
        async () => {
          // Read the document once upfront. Resolving all positions before any writes
          // avoids N-1 re-reads inside the loop and enables semantic conflict detection
          // (e.g. first_child of P and before-P's-first-child both map to index 0 under
          // P and must be rejected regardless of how they were expressed).
          const doc = await store.read(file_id);
          const rootId = findRootNodeId(doc.nodes);
          const parentMap = buildParentMap(doc.nodes);
          const nodeMap = buildNodeMap(doc.nodes);

          // Resolve each insertion to (parentNodeId, resolvedStartIndex). Detect
          // semantic conflicts: two insertions mapping to the same (parent, index)
          // would produce unpredictable ordering because each resolves from the
          // pre-insertion document state without knowing what the other will add.
          const resolvedInsertions: Array<{ parentNodeId: string; resolvedStartIndex: number }> = [];
          const conflictKeys = new Set<string>();

          for (const insertion of insertions) {
            const isSiblingPosition = insertion.position === "after" || insertion.position === "before";
            let parentNodeId: string;
            let resolvedStartIndex: number;

            if (isSiblingPosition) {
              if (insertion.reference_item_id === rootId) {
                throw new ToolInputError("InvalidInput", "Cannot use root item as reference for after/before; root has no parent.");
              }
              const refInfo = parentMap.get(insertion.reference_item_id!);
              if (!refInfo) {
                throw new ToolInputError("ItemNotFound", `Reference item '${insertion.reference_item_id}' not found in document.`);
              }
              parentNodeId = refInfo.parentId;
              resolvedStartIndex = insertion.position === "after" ? refInfo.index + 1 : refInfo.index;
            } else {
              if (!insertion.reference_item_id) {
                parentNodeId = rootId;
              } else {
                if (!nodeMap.has(insertion.reference_item_id)) {
                  throw new ToolInputError("ItemNotFound", `Parent item '${insertion.reference_item_id}' not found in document.`);
                }
                parentNodeId = insertion.reference_item_id;
              }
              const parentNode = nodeMap.get(parentNodeId);
              resolvedStartIndex = insertion.position === "first_child" ? 0 : (parentNode?.children?.length ?? 0);
            }

            const conflictKey = `${parentNodeId}:${resolvedStartIndex}`;
            if (conflictKeys.has(conflictKey)) {
              throw new ToolInputError(
                "InvalidInput",
                "Conflicting insertions: two or more insertions resolve to the same position in the document. " +
                "Use distinct target positions, or combine them into a single insertion with multiple items."
              );
            }
            conflictKeys.add(conflictKey);
            resolvedInsertions.push({ parentNodeId, resolvedStartIndex });
          }

          // Apply offset accounting. After insertion j commits k top-level items at
          // resolvedStartIndex_j under its parent, all subsequent insertions to the
          // same parent at resolvedStartIndex >= j's are shifted up by k. Using
          // resolved (pre-offset) indices for the comparison is correct: each prior
          // insertion's contribution is independent and additive.
          //
          // `<=` is intentional: any prior insertion at an equal resolvedStartIndex
          // would also shift subsequent insertions. The conflict check above ensures
          // no two insertions share the same (parentId, resolvedStartIndex), so the
          // equal case is unreachable in practice — but `<=` is still semantically
          // correct if that invariant ever changes.
          //
          // `items.length` counts only top-level items because only those occupy
          // slots directly in the parent's children array. Nested children are
          // inserted under their own parents and do not affect sibling indices.
          const effectiveInsertions = resolvedInsertions.map((resolved, i) => {
            let offset = 0;
            for (let j = 0; j < i; j++) {
              if (
                resolvedInsertions[j].parentNodeId === resolved.parentNodeId &&
                resolvedInsertions[j].resolvedStartIndex <= resolved.resolvedStartIndex
              ) {
                offset += (insertions[j].items as JsonInputNode[]).length;
              }
            }
            return { parentNodeId: resolved.parentNodeId, startIndex: resolved.resolvedStartIndex + offset };
          });

          // Execute insertions with pre-computed positions. No per-iteration re-reads needed.
          const insertionResults: Array<{ totalCreated: number; rootNodeIds: string[]; batchesSent: number }> = [];
          for (let i = 0; i < insertions.length; i++) {
            const { parentNodeId, startIndex } = effectiveInsertions[i];
            const tree = jsonInputToTree(insertions[i].items as JsonInputNode[]);
            const insertResult = await insertTreeUnderParent(client, file_id, parentNodeId, tree, { startIndex });
            insertionResults.push(insertResult);
          }

          const totalApiCallCount = insertionResults.reduce((sum, r) => sum + r.batchesSent, 0);
          return { result: insertionResults, apiCallCount: totalApiCallCount };
        },
      );

      const insertionResults = guard.result;
      const totalCreated = insertionResults.reduce((sum, r) => sum + r.totalCreated, 0);

      const data: Record<string, unknown> = {
        file_id,
        created_count: totalCreated,
      };
      if (guard.syncWarning) data.sync_warning = guard.syncWarning;
      data.insertions = insertionResults.map(r => ({
        created_count: r.totalCreated,
        root_item_ids: r.rootNodeIds,
      }));

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
