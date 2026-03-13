/**
 * Write tools: send_to_inbox, edit_nodes, insert_nodes.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, EditDocumentChange, buildParentMap, findRootNodeId, type ReadDocumentResponse } from "../dynalist-client";
import { buildDynalistUrl } from "../utils/url-parser";
import { getConfig, type Config } from "../config";
import { AccessController, requireAccess, type Policy } from "../access-control";
import { withVersionGuard } from "../version-guard";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
  insertTreeUnderParent,
  ToolInputError,
  type ParsedNode,
} from "../utils/dynalist-helpers";
import type { DocumentStore } from "../document-store";
import { FILE_ID_DESCRIPTION, CHECKBOX_DESCRIPTION, CHECKED_DESCRIPTION, HEADING_DESCRIPTION, COLOR_DESCRIPTION, CONFIRM_GUIDANCE, MULTILINE_GUIDANCE, CONTENT_MULTILINE_GUIDANCE, EXPECTED_VERSION_DESCRIPTION } from "./descriptions";

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

  return requireAccess(effectivePolicy, "write", false);
}

export function registerWriteTools(server: McpServer, client: DynalistClient, ac: AccessController, store: DocumentStore): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: send_to_inbox
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "send_to_inbox",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Send a single item to your Dynalist inbox. The target document is the user's configured " +
        "inbox in Dynalist settings and cannot be changed via this tool. For inserting into a " +
        "specific document or inserting hierarchical content, use insert_nodes instead.",
      inputSchema: {
        content: z.string().describe("The text content for the inbox item."),
        note: z.string().optional().describe("Optional note for the item."),
        checkbox: z.boolean().optional().describe(
          `Whether to add a checkbox. ${CHECKBOX_DESCRIPTION}`
        ),
      },
      outputSchema: {
        file_id: z.string().describe("Inbox document file ID"),
        node_id: z.string().describe("ID of the created node"),
        url: z.string().describe("Dynalist URL for the created node"),
      },
    },
    wrapToolHandler(async ({ content, note, checkbox }: { content: string; note?: string; checkbox?: boolean }) => {
      const config = getConfig();

      if (config.readOnly) {
        return makeErrorResponse("ReadOnly", "Server is in read-only mode.");
      }

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

      const effectiveCheckbox = checkbox ?? config.inbox.defaultCheckbox;

      const response = await client.sendToInbox({
        content,
        note,
        checkbox: effectiveCheckbox,
      });

      // Invalidate the inbox document's cache entry since its content changed.
      store.invalidate(response.file_id);

      return makeResponse({
        file_id: response.file_id,
        node_id: response.node_id,
        url: buildDynalistUrl(response.file_id, response.node_id),
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: edit_nodes
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "edit_nodes",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Edit one or more existing nodes in a Dynalist document. Only specified fields are " +
        "updated per node. Omitted fields are left unchanged (not reset to defaults). " +
        "For a single node, pass a one-element array.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        nodes: z.array(z.object({
          node_id: z.string().describe("Node ID to edit"),
          content: z.string().optional().describe(`New content text. ${CONTENT_MULTILINE_GUIDANCE}`),
          note: z.string().optional().describe(`New note text. ${MULTILINE_GUIDANCE} Set to '' to clear.`),
          checked: z.boolean().optional().describe(CHECKED_DESCRIPTION),
          checkbox: z.boolean().optional().describe(
            `Whether to show a checkbox on this node. ${CHECKBOX_DESCRIPTION}`
          ),
          heading: z.number().min(0).max(3).optional().describe(HEADING_DESCRIPTION),
          color: z.number().min(0).max(6).optional().describe(COLOR_DESCRIPTION),
        })).describe("Array of node edits to apply."),
        expected_version: z.number().describe(EXPECTED_VERSION_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
        edited_count: z.number().describe("Number of nodes edited"),
        node_ids: z.array(z.string()).describe("IDs of all edited nodes"),
        version_warning: z.string().optional().describe("Warning if a concurrent edit was detected during the write."),
      },
    },
    wrapToolHandler(async ({
      file_id,
      nodes,
      expected_version,
    }: {
      file_id: string;
      nodes: Array<{
        node_id: string;
        content?: string;
        note?: string;
        checked?: boolean;
        checkbox?: boolean;
        heading?: number;
        color?: number;
      }>;
      expected_version: number;
    }) => {
      if (nodes.length === 0) {
        return makeErrorResponse("InvalidInput", "No nodes to edit (empty array).");
      }

      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const changes: EditDocumentChange[] = nodes.map((entry) => {
        const change: EditDocumentChange = {
          action: "edit",
          node_id: entry.node_id,
        };

        // Only include fields that are explicitly set.
        if (entry.content !== undefined) change.content = entry.content;
        if (entry.note !== undefined) change.note = entry.note;
        if (entry.checked !== undefined) change.checked = entry.checked;
        if (entry.checkbox !== undefined) change.checkbox = entry.checkbox;
        if (entry.heading !== undefined) change.heading = entry.heading;
        if (entry.color !== undefined) change.color = entry.color;

        return change;
      });

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedVersion: expected_version, store },
        async () => {
          const response = await client.editDocument(file_id, changes);
          return { result: undefined, apiCallCount: response.batches_sent };
        },
      );

      const nodeIds = nodes.map((entry) => entry.node_id);
      const data: Record<string, unknown> = {
        file_id,
        edited_count: nodes.length,
        node_ids: nodeIds,
      };
      if (guard.versionWarning) data.version_warning = guard.versionWarning;

      return makeResponse(data);
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: insert_nodes
  // ═════════════════════════════════════════════════════════════════════

  // Recursive Zod schema for JSON input nodes.
  const jsonInputNodeSchema: z.ZodType<{
    content: string;
    note?: string;
    checkbox?: boolean;
    checked?: boolean;
    heading?: number;
    color?: number;
    children?: unknown[];
  }> = z.lazy(() =>
    z.object({
      content: z.string().describe(`Content text. ${CONTENT_MULTILINE_GUIDANCE}`),
      note: z.string().optional().describe(`Note text. ${MULTILINE_GUIDANCE}`),
      checkbox: z.boolean().optional().describe(
        `Whether to add a checkbox. ${CHECKBOX_DESCRIPTION}`
      ),
      checked: z.boolean().optional().describe(CHECKED_DESCRIPTION),
      heading: z.number().min(0).max(3).optional().describe(HEADING_DESCRIPTION),
      color: z.number().min(0).max(6).optional().describe(COLOR_DESCRIPTION),
      children: z.array(jsonInputNodeSchema).optional().describe("Child nodes"),
    })
  );

  server.registerTool(
    "insert_nodes",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Insert one or more nodes into a Dynalist document as a JSON tree. Supports nested " +
        "hierarchy and per-node fields (note, checkbox, checked, heading, color). For a single " +
        "node, pass a one-element array.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        node_id: z.string().optional().describe("Parent node ID to insert under (omit for document root). Inferred from reference_node_id when using after/before."),
        nodes: z.array(jsonInputNodeSchema).describe("Array of nodes to insert"),
        position: z.enum(["as_first_child", "as_last_child", "after", "before"]).optional().default("as_last_child")
          .describe("Where to insert. 'as_first_child'/'as_last_child' insert under the parent (node_id). 'after'/'before' insert relative to reference_node_id as a sibling."),
        index: z.number().optional().describe(
          "Exact child index for root-level nodes. Overrides position when set. " +
          "0 = first child, -1 = last child. Cannot be combined with reference_node_id."
        ),
        reference_node_id: z.string().optional().describe(
          "Sibling node to insert relative to. Required when position is 'after' or 'before'. " +
          "Cannot be combined with 'as_first_child'/'as_last_child' or index."
        ),
        expected_version: z.number().describe(EXPECTED_VERSION_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
        total_created: z.number().describe("Total number of nodes created"),
        root_node_ids: z.array(z.string()).describe("IDs of all top-level inserted nodes"),
        url: z.string().describe("Dynalist URL for the first created node"),
        version_warning: z.string().optional().describe("Warning if a concurrent edit was detected during the write."),
      },
    },
    wrapToolHandler(async ({
      file_id,
      node_id,
      nodes,
      position,
      index,
      reference_node_id,
      expected_version,
    }: {
      file_id: string;
      node_id?: string;
      nodes: unknown[];
      position: string;
      index?: number;
      reference_node_id?: string;
      expected_version: number;
    }) => {
      const config = getConfig();

      // Access check: requires write (allow) policy.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "write", config.readOnly);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      // Validate parameter combinations.
      if (reference_node_id !== undefined && index !== undefined) {
        return makeErrorResponse("InvalidInput", "Cannot specify both reference_node_id and index.");
      }
      if ((position === "after" || position === "before") && reference_node_id === undefined) {
        return makeErrorResponse("InvalidInput", `Position '${position}' requires reference_node_id.`);
      }
      if (reference_node_id !== undefined && (position === "as_first_child" || position === "as_last_child")) {
        return makeErrorResponse("InvalidInput", `Cannot use reference_node_id with position '${position}'.`);
      }

      // Convert JSON input to ParsedNode tree (no doc read needed).
      const tree = jsonInputToTree(nodes as JsonInputNode[]);
      if (tree.length === 0) {
        return makeErrorResponse("InvalidInput", "No nodes to insert (empty array)");
      }

      const guard = await withVersionGuard(
        { client, fileId: file_id, expectedVersion: expected_version, store },
        async () => {
          let parentNodeId = node_id;
          let startIndex: number | undefined;

          if (position === "after" || position === "before") {
            // Sibling-relative positioning: resolve parent and index from the reference node.
            const doc = await store.read(file_id);
            const parentMap = buildParentMap(doc.nodes);
            const refInfo = parentMap.get(reference_node_id!);

            if (!refInfo) {
              throw new ToolInputError("NodeNotFound", `Reference node '${reference_node_id}' not found in document.`);
            }

            // If node_id was provided, validate it matches the reference node's parent.
            if (node_id !== undefined && node_id !== refInfo.parentId) {
              throw new ToolInputError("InvalidInput", "node_id does not match the parent of reference_node_id.");
            }

            parentNodeId = refInfo.parentId;
            startIndex = position === "after" ? refInfo.index + 1 : refInfo.index;
          } else {
            // Child positioning (as_first_child / as_last_child / index).
            // The Dynalist API snapshots parent state before processing a batch,
            // so sending index -1 for every item in a batch causes them to all
            // resolve to the same position and reverse. For multi-item inserts we
            // resolve to explicit indices to preserve input order.
            let doc: ReadDocumentResponse | undefined;
            if (!parentNodeId) {
              doc = await store.read(file_id);
              parentNodeId = findRootNodeId(doc.nodes);
            }

            if (index !== undefined && index !== -1) {
              startIndex = index;
            } else if (position === "as_first_child") {
              startIndex = 0;
            } else if (nodes.length <= 1) {
              // Single item: index -1 is unambiguous, no read needed.
              startIndex = undefined;
            } else {
              // as_last_child (default) or index: -1 with multiple items.
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
      const firstNodeId = insertResult.rootNodeIds[0] ?? null;
      const url = firstNodeId
        ? buildDynalistUrl(file_id, firstNodeId)
        : buildDynalistUrl(file_id);

      const data: Record<string, unknown> = {
        file_id,
        total_created: insertResult.totalCreated,
        root_node_ids: insertResult.rootNodeIds,
        url,
      };
      if (guard.versionWarning) data.version_warning = guard.versionWarning;

      return makeResponse(data);
    })
  );
}

interface JsonInputNode {
  content: string;
  note?: string;
  checkbox?: boolean;
  checked?: boolean;
  heading?: number;
  color?: number;
  children?: JsonInputNode[];
}

/**
 * Convert JSON input nodes to the ParsedNode tree used by insertTreeUnderParent.
 */
function jsonInputToTree(nodes: JsonInputNode[]): ParsedNode[] {
  return nodes.map((node) => ({
    content: node.content,
    note: node.note,
    checkbox: node.checkbox,
    checked: node.checked,
    heading: node.heading,
    color: node.color,
    children: node.children ? jsonInputToTree(node.children) : [],
  }));
}
