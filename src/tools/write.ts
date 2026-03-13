/**
 * Write tools: send_to_inbox, edit_node, insert_node, insert_nodes.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, EditDocumentChange, findRootNodeId } from "../dynalist-client";
import { buildDynalistUrl } from "../utils/url-parser";
import { parseMarkdownBullets } from "../utils/markdown-parser";
import { getConfig, type Config } from "../config";
import { AccessController, requireAccess, type Policy } from "../access-control";
import {
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
  insertTreeUnderParent,
} from "../utils/dynalist-helpers";
import { FILE_ID_DESCRIPTION, CHECKBOX_DESCRIPTION, CHECKED_DESCRIPTION, HEADING_DESCRIPTION, COLOR_DESCRIPTION, CONFIRM_GUIDANCE, MULTILINE_GUIDANCE, CONTENT_MULTILINE_GUIDANCE } from "./descriptions";

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

export function registerWriteTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
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
        "specific document or inserting hierarchical content, use insert_node or insert_nodes instead.",
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

      return makeResponse({
        file_id: response.file_id,
        node_id: response.node_id,
        url: buildDynalistUrl(response.file_id, response.node_id),
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: edit_node
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "edit_node",
    {
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Edit an existing node in a Dynalist document. Only specified fields are updated. " +
        "Omitted fields are left unchanged (not reset to defaults). This is a partial update.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        node_id: z.string().describe("Node ID to edit"),
        content: z.string().optional().describe(`New content text. ${CONTENT_MULTILINE_GUIDANCE}`),
        note: z.string().optional().describe(`New note text. ${MULTILINE_GUIDANCE} Set to '' to clear.`),
        checked: z.boolean().optional().describe(CHECKED_DESCRIPTION),
        checkbox: z.boolean().optional().describe(
          `Whether to show a checkbox on this node. ${CHECKBOX_DESCRIPTION}`
        ),
        heading: z.number().min(0).max(3).optional().describe(HEADING_DESCRIPTION),
        color: z.number().min(0).max(6).optional().describe(COLOR_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
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
    }: {
      file_id: string;
      node_id: string;
      content?: string;
      note?: string;
      checked?: boolean;
      checkbox?: boolean;
      heading?: number;
      color?: number;
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
      description:
        `${CONFIRM_GUIDANCE} ` +
        "Insert a single new node into a Dynalist document. For inserting multiple nodes with " +
        "hierarchy, use insert_nodes instead (it is faster and preserves tree structure).",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        parent_id: z.string().describe("Parent node ID to insert under"),
        content: z.string().describe(`Content text for the new node. ${CONTENT_MULTILINE_GUIDANCE}`),
        note: z.string().optional().describe(`Note text. ${MULTILINE_GUIDANCE}`),
        index: z.number().optional().default(-1).describe(
          "Position under parent. 0 = first child, -1 = last child (default)."
        ),
        checkbox: z.boolean().optional().describe(
          `Whether to add a checkbox. ${CHECKBOX_DESCRIPTION}`
        ),
        heading: z.number().min(0).max(3).optional().describe(HEADING_DESCRIPTION),
        color: z.number().min(0).max(6).optional().describe(COLOR_DESCRIPTION),
        checked: z.boolean().optional().describe(CHECKED_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
        node_id: z.string().describe("ID of the newly created node"),
        parent_id: z.string().describe("Parent node ID"),
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
      checkbox?: boolean;
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

      if (note !== undefined) change.note = note;
      if (checkbox) change.checkbox = checkbox;
      if (heading !== undefined && heading > 0) change.heading = heading;
      if (color !== undefined && color > 0) change.color = color;
      if (checked !== undefined) change.checked = checked;

      const response = await client.editDocument(file_id, [change]);
      const newNodeId = response.new_node_ids?.[0];

      return makeResponse({
        file_id,
        node_id: newNodeId ?? "unknown",
        parent_id,
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
        `${CONFIRM_GUIDANCE} ` +
        "Insert multiple nodes from indented text, preserving hierarchy. Preferred over calling " +
        "insert_node in a loop. Accepts '- bullet' format or plain indented text.\n\n" +
        "Example input:\n" +
        "- Top level item\n" +
        "  - Child item\n" +
        "    - Grandchild\n" +
        "- Another top level item",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        node_id: z.string().optional().describe("Parent node ID to insert under (omit for document root)"),
        content: z.string().describe("Indented text with bullets. Supports '- text' or plain indented text."),
        position: z.enum(["as_first_child", "as_last_child"]).optional().default("as_last_child")
          .describe("Where to insert under the parent node"),
      },
      outputSchema: {
        file_id: z.string().describe("Document file ID"),
        total_created: z.number().describe("Total number of nodes created"),
        root_node_ids: z.array(z.string()).describe("IDs of all top-level inserted nodes"),
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
        root_node_ids: result.rootNodeIds,
        url,
      });
    })
  );
}
