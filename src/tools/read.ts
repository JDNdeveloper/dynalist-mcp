/**
 * Read tools: list_documents, search_documents, read_document,
 * search_in_document, get_recent_changes, check_document_versions.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, buildNodeMap, buildParentMap, findRootNodeId } from "../dynalist-client";
import { buildDynalistUrl } from "../utils/url-parser";
import { getConfig } from "../config";
import { AccessController, requireAccess } from "../access-control";
import {
  checkContentSize,
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
  getAncestors,
  getPermissionLabel,
  buildNodeTree,
} from "../utils/dynalist-helpers";
import type { DocumentStore } from "../document-store";
import type { ParentLevels } from "../utils/dynalist-helpers";
import {
  FILE_ID_DESCRIPTION, FOLDER_ID_DESCRIPTION, NODE_ID_DESCRIPTION,
  URL_DESCRIPTION, DOCUMENT_TITLE_DESCRIPTION, FOLDER_TITLE_DESCRIPTION,
  VERSION_DESCRIPTION, SIZE_WARNING_DESCRIPTION, MATCH_COUNT_DESCRIPTION,
  BYPASS_WARNING_DESCRIPTION, PARENT_LEVELS_DESCRIPTION,
} from "./descriptions";
import { NUMBER_TO_HEADING, NUMBER_TO_COLOR } from "./node-metadata";

// ─── Output schemas for read tools ──────────────────────────────────

// Shared fields for node summaries used in parents/children arrays.
const nodeSummarySchema = z.object({
  node_id: z.string().describe(NODE_ID_DESCRIPTION),
  content: z.string().describe("Node text content"),
});

// Shared optional metadata fields present on output nodes and match objects.
const nodeMetadataFields = {
  note: z.string().optional().describe("Node note. Omitted when empty."),
  checked: z.boolean().optional().describe("Checked (completed) state. Omitted when no checkbox."),
  show_checkbox: z.boolean().optional().describe("Whether a checkbox is shown. Omitted when no checkbox."),
  heading: z.enum(["h1", "h2", "h3"]).optional().describe(
    "Heading level: 'h1', 'h2', 'h3'. Omitted when none."
  ),
  color: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).optional().describe(
    "Color label: 'red', 'orange', 'yellow', 'green', 'blue', 'purple'. Omitted when none."
  ),
  collapsed: z.boolean().describe("Whether the node is collapsed in the UI"),
};

// Recursive schema for the read_document node tree.
const outputNodeSchema: z.ZodType<{
  node_id: string;
  content: string;
  note?: string;
  checked?: boolean;
  show_checkbox?: boolean;
  heading?: string;
  color?: string;
  collapsed: boolean;
  depth_limited?: true;
  children_count: number;
  children: unknown[];
}> = z.lazy(() =>
  z.object({
    node_id: z.string().describe(NODE_ID_DESCRIPTION),
    content: z.string().describe("Node text content"),
    ...nodeMetadataFields,
    depth_limited: z.literal(true).optional().describe(
      "Present when max_depth cut off traversal. Call read_document with this node_id to expand."
    ),
    children_count: z.number().describe("Total direct children, regardless of visibility"),
    children: z.array(outputNodeSchema).describe("Child nodes. Empty when depth-limited or collapse-hidden."),
  })
);

// Match object for search_in_document results.
const searchMatchSchema = z.object({
  node_id: z.string().describe(NODE_ID_DESCRIPTION),
  content: z.string().describe("Node text content"),
  url: z.string().describe(URL_DESCRIPTION),
  ...nodeMetadataFields,
  parents: z.array(nodeSummarySchema).optional().describe(
    "Ancestor chain. Present when parent_levels is not 'none' and ancestors exist."
  ),
  children: z.array(nodeSummarySchema).optional().describe(
    "Direct children. Present when include_children is true and node has children."
  ),
});

// Match object for get_recent_changes results.
const changeMatchSchema = z.object({
  node_id: z.string().describe(NODE_ID_DESCRIPTION),
  content: z.string().describe("Node text content"),
  url: z.string().describe(URL_DESCRIPTION),
  change_type: z.enum(["created", "modified"]).describe("Whether this node was created or modified in the time range"),
  created: z.number().describe("Creation timestamp (ms since epoch)"),
  modified: z.number().describe("Last modified timestamp (ms since epoch)"),
  ...nodeMetadataFields,
  parents: z.array(nodeSummarySchema).optional().describe(
    "Ancestor chain. Present when parent_levels is not 'none' and ancestors exist."
  ),
});

export function registerReadTools(server: McpServer, client: DynalistClient, ac: AccessController, store: DocumentStore): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: list_documents
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "list_documents",
    {
      description:
        "List all documents and folders. Returns the folder hierarchy with children arrays. " +
        "Use returned file_id values in other tools.",
      outputSchema: {
        count: z.number().describe("Total number of documents"),
        documents: z.array(z.object({
          file_id: z.string().describe(FILE_ID_DESCRIPTION),
          title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
          url: z.string().describe(URL_DESCRIPTION),
          permission: z.enum(["none", "read", "edit", "manage", "owner"]).describe("Permission level for this document"),
          access_policy: z.enum(["read"]).optional().describe("Access policy if restricted. Omitted when unrestricted."),
        })).describe("All documents in the account"),
        folders: z.array(z.object({
          file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
          title: z.string().describe(FOLDER_TITLE_DESCRIPTION),
          children: z.array(z.string()).describe("File IDs of documents/folders inside this folder"),
        })).describe("All folders in the account"),
        root_file_id: z.string().describe(
          "File ID of the invisible root folder. Not a real folder in the UI. " +
          "Its children are the top-level items. Never show this to users."
        ),
      },
    },
    wrapToolHandler(async () => {
      const config = getConfig();
      const response = await client.listFiles();

      // Build policies for all files to filter denied ones.
      const allIds = response.files.map((f) => f.id);
      const policies = await ac.getPolicies(allIds, config);

      const documents = response.files
        .filter((f) => f.type === "document" && policies.get(f.id) !== "deny")
        .map((f) => {
          const policy = policies.get(f.id)!;
          const doc: Record<string, unknown> = {
            file_id: f.id,
            title: f.title,
            url: buildDynalistUrl(f.id),
            permission: getPermissionLabel(f.permission),
          };
          if (policy === "read") {
            doc.access_policy = "read";
          }
          return doc;
        });

      const folders = response.files
        .filter((f) => (f.type === "folder" || f.type === "root") && policies.get(f.id) !== "deny")
        .map((f) => ({
          file_id: f.id,
          title: f.title,
          children: (f.children ?? []).filter((childId) => policies.get(childId) !== "deny"),
        }));

      // root_file_id is always returned regardless of ACL. It is structural
      // metadata agents need to navigate the folder hierarchy, not content.
      return makeResponse({
        count: documents.length,
        documents,
        folders,
        root_file_id: response.root_file_id,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: search_documents
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "search_documents",
    {
      description:
        "Search for documents and folders by title. Filters the file tree only; does not search " +
        "node content. Use search_in_document to search inside a document.",
      inputSchema: {
        query: z.string().describe("Text to search for in document/folder names (case-insensitive)"),
        type: z.enum(["all", "document", "folder"]).optional().default("all").describe("Filter by type: 'document', 'folder', or 'all'"),
      },
      outputSchema: {
        count: z.number().describe(MATCH_COUNT_DESCRIPTION),
        query: z.string().describe("The search query that was used"),
        matches: z.array(z.object({
          file_id: z.string().describe(FILE_ID_DESCRIPTION),
          title: z.string().describe("Document or folder title"),
          type: z.enum(["document", "folder"]).describe("Whether this is a document or folder"),
          url: z.string().optional().describe("Dynalist URL (documents only)"),
          permission: z.enum(["none", "read", "edit", "manage", "owner"]).optional().describe("Permission level (documents only)"),
          children: z.array(z.string()).optional().describe("Child file IDs (folders only)"),
          access_policy: z.enum(["read"]).optional().describe("Access policy if restricted. Omitted when unrestricted."),
        })).describe("Matching documents and/or folders"),
      },
    },
    wrapToolHandler(async ({ query, type }: { query: string; type: string }) => {
      const config = getConfig();
      const response = await client.listFiles();
      const queryLower = query.toLowerCase();

      // Build policies for all files to filter denied ones.
      const allIds = response.files.map((f) => f.id);
      const policies = await ac.getPolicies(allIds, config);

      const matches = response.files
        .filter((f) => {
          if (policies.get(f.id) === "deny") return false;
          if (f.type === "root") return false;
          const nameMatch = f.title?.toLowerCase().includes(queryLower);
          const typeMatch = type === "all" || f.type === type;
          return nameMatch && typeMatch;
        })
        .map((f) => {
          const policy = policies.get(f.id)!;
          const match: Record<string, unknown> = {
            file_id: f.id,
            title: f.title,
            type: f.type,
            url: f.type === "document" ? buildDynalistUrl(f.id) : undefined,
            permission: f.type === "document" ? getPermissionLabel(f.permission) : undefined,
            children: f.type === "folder" ? (f.children ?? []).filter((childId) => policies.get(childId) !== "deny") : undefined,
          };
          if (policy === "read") {
            match.access_policy = "read";
          }
          return match;
        });

      return makeResponse({
        count: matches.length,
        query,
        matches,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: read_document
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "read_document",
    {
      description:
        "Read a document as a JSON node tree. Omit node_id for root. Provide node_id to zoom " +
        "into a subtree.\n\n" +
        "Two independent size controls:\n" +
        "- max_depth: limits tree traversal depth (default 5, null = unlimited).\n" +
        "- include_collapsed_children: includes children of collapsed nodes (default false).\n" +
        "These are orthogonal: max_depth does NOT expand collapsed nodes; " +
        "include_collapsed_children does NOT bypass the depth limit.\n\n" +
        "The starting node always shows its children regardless of collapsed state.\n\n" +
        "Hidden children are signaled distinctly:\n" +
        "- depth_limited: true means max_depth cut off traversal. " +
        "Fix: read_document with that node_id.\n" +
        "- collapsed: true + children_count > 0 means user-collapsed in UI. " +
        "Fix: include_collapsed_children: true, or pass its node_id.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        node_id: z.string().optional().describe(
          "Starting node. Omit for document root."
        ),
        max_depth: z.number().nullable().optional().describe(
          "Max traversal depth. 0 = target only, 1 = target + children, null = unlimited. Default: 5."
        ),
        include_collapsed_children: z.boolean().optional().describe(
          "Include collapsed nodes' children. Default false: collapsed nodes show " +
          "children_count but empty children."
        ),
        include_notes: z.boolean().optional().describe(
          "Include node notes. Default: true."
        ),
        include_checked: z.boolean().optional().describe(
          "Include checked/completed nodes. Default: true."
        ),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().optional().describe(FILE_ID_DESCRIPTION),
        title: z.string().optional().describe(DOCUMENT_TITLE_DESCRIPTION),
        version: z.number().optional().describe(VERSION_DESCRIPTION),
        url: z.string().optional().describe(URL_DESCRIPTION),
        node: outputNodeSchema.optional().describe("Root of the node tree"),
        warning: z.string().optional().describe(SIZE_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      node_id,
      max_depth,
      include_collapsed_children,
      include_notes,
      include_checked,
      bypass_warning,
    }: {
      file_id: string;
      node_id?: string;
      max_depth?: number | null;
      include_collapsed_children?: boolean;
      include_notes?: boolean;
      include_checked?: boolean;
      bypass_warning: boolean;
    }) => {
      const config = getConfig();

      // Access check.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "read", false);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const effectiveMaxDepth = max_depth === undefined ? config.readDefaults.maxDepth : max_depth;
      const effectiveIncludeCollapsedChildren = include_collapsed_children ?? config.readDefaults.includeCollapsedChildren;
      const effectiveIncludeNotes = include_notes ?? config.readDefaults.includeNotes;
      const effectiveIncludeChecked = include_checked ?? config.readDefaults.includeChecked;

      const doc = await store.read(file_id);
      const nodeMap = buildNodeMap(doc.nodes);

      // Determine starting node.
      const startNodeId = node_id ?? findRootNodeId(doc.nodes);

      if (!nodeMap.has(startNodeId)) {
        return makeErrorResponse("NodeNotFound", `Node '${startNodeId}' not found in document`);
      }

      const tree = buildNodeTree(nodeMap, startNodeId, {
        maxDepth: effectiveMaxDepth,
        includeCollapsedChildren: effectiveIncludeCollapsedChildren,
        includeNotes: effectiveIncludeNotes,
        includeChecked: effectiveIncludeChecked,
      });

      if (!tree) {
        return makeErrorResponse("NodeNotFound", `Node '${startNodeId}' could not be rendered`);
      }

      // Check content size on serialized output.
      const serialized = JSON.stringify(tree, null, 2);
      const sizeCheck = checkContentSize(
        serialized,
        bypass_warning,
        [
          "Use max_depth to limit traversal depth (e.g., max_depth: 2)",
          "Target a specific node_id instead of entire document",
        ],
        config.sizeWarning.warningTokenThreshold,
        config.sizeWarning.maxTokenThreshold,
      );

      if (sizeCheck) {
        return makeResponse({
          file_id,
          title: doc.title,
          version: doc.version,
          warning: sizeCheck.warning,
        });
      }

      const url = node_id
        ? buildDynalistUrl(file_id, node_id)
        : buildDynalistUrl(file_id);

      return makeResponse({
        file_id,
        title: doc.title,
        version: doc.version,
        url,
        node: tree,
      });
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: search_in_document
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "search_in_document",
    {
      description:
        "Search for text in a document. Returns matching nodes with metadata. " +
        "Use parent_levels for ancestor breadcrumbs without a separate read_document call.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        query: z.string().describe("Text to search for (case-insensitive)"),
        search_notes: z.boolean().optional().default(true).describe("Also search in notes"),
        parent_levels: z.enum(["none", "immediate", "all"]).optional().default("immediate").describe(PARENT_LEVELS_DESCRIPTION),
        include_children: z.boolean().optional().default(false).describe("Include direct children of each match"),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().optional().describe(FILE_ID_DESCRIPTION),
        title: z.string().optional().describe(DOCUMENT_TITLE_DESCRIPTION),
        version: z.number().optional().describe(VERSION_DESCRIPTION),
        url: z.string().optional().describe(URL_DESCRIPTION),
        count: z.number().optional().describe(MATCH_COUNT_DESCRIPTION),
        query: z.string().optional().describe("The search query that was used"),
        matches: z.array(searchMatchSchema).optional().describe("Matching nodes"),
        warning: z.string().optional().describe(SIZE_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      query,
      search_notes,
      parent_levels,
      include_children,
      bypass_warning,
    }: {
      file_id: string;
      query: string;
      search_notes: boolean;
      parent_levels: ParentLevels;
      include_children: boolean;
      bypass_warning: boolean;
    }) => {
      const config = getConfig();

      // Access check.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "read", false);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const doc = await store.read(file_id);
      const nodeMap = buildNodeMap(doc.nodes);
      const parentMap = buildParentMap(doc.nodes);
      const queryLower = query.toLowerCase();

      const matches = doc.nodes
        .filter((node) => {
          const contentMatch = node.content?.toLowerCase().includes(queryLower);
          const noteMatch = search_notes && node.note?.toLowerCase().includes(queryLower);
          return contentMatch || noteMatch;
        })
        .map((node) => {
          const match: Record<string, unknown> = {
            node_id: node.id,
            content: node.content,
            url: buildDynalistUrl(file_id, node.id),
            collapsed: node.collapsed ?? false,
          };

          // Include optional fields only when present, consistent with read_document.
          if (node.checked !== undefined) match.checked = node.checked;
          if (node.checkbox !== undefined) match.show_checkbox = node.checkbox;
          if (node.heading !== undefined && node.heading > 0) match.heading = NUMBER_TO_HEADING[node.heading];
          if (node.color !== undefined && node.color > 0) match.color = NUMBER_TO_COLOR[node.color];

          // Include note only when non-empty.
          if (node.note && node.note.trim()) {
            match.note = node.note;
          }

          if (parent_levels !== "none") {
            const parents = getAncestors(nodeMap, parentMap, node.id, parent_levels);
            if (parents.length > 0) {
              match.parents = parents.map(p => ({ node_id: p.id, content: p.content }));
            }
          }

          if (include_children && node.children && node.children.length > 0) {
            match.children = node.children
              .map(childId => {
                const childNode = nodeMap.get(childId);
                return childNode ? { node_id: childNode.id, content: childNode.content } : null;
              })
              .filter((c): c is { node_id: string; content: string } => c !== null);
          }

          return match;
        });

      const result = {
        file_id,
        title: doc.title,
        version: doc.version,
        url: buildDynalistUrl(file_id),
        count: matches.length,
        query,
        matches,
      };

      const serialized = JSON.stringify(result, null, 2);
      const sizeCheck = checkContentSize(
        serialized,
        bypass_warning,
        [
          "Use a more specific query to reduce matches",
          "Use parent_levels: \"none\" to exclude parent context",
          "Use include_children: false to exclude children",
        ],
        config.sizeWarning.warningTokenThreshold,
        config.sizeWarning.maxTokenThreshold,
      );

      if (sizeCheck) {
        return makeResponse({
          file_id,
          title: doc.title,
          version: doc.version,
          warning: sizeCheck.warning,
        });
      }

      return makeResponse(result);
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: get_recent_changes
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "get_recent_changes",
    {
      description:
        "Get nodes created or modified within a time period. Timestamps in milliseconds since " +
        "epoch. Date-only strings like '2025-03-11' are start-of-day for 'since' and " +
        "end-of-day for 'until'.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        since: z.union([z.string(), z.number()]).describe("Start: ISO date (e.g. '2024-01-15') or ms timestamp"),
        until: z.union([z.string(), z.number()]).optional().describe("End: ISO date or ms timestamp (default: now)"),
        type: z.enum(["created", "modified", "both"]).optional().default("both").describe(
          "'created' = new nodes only, 'modified' = edited (not new) only, 'both' = all (default)."
        ),
        parent_levels: z.enum(["none", "immediate", "all"]).optional().default("immediate").describe(PARENT_LEVELS_DESCRIPTION),
        sort: z.enum(["newest_first", "oldest_first"]).optional().default("newest_first").describe("Sort order by timestamp"),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().optional().describe(FILE_ID_DESCRIPTION),
        title: z.string().optional().describe(DOCUMENT_TITLE_DESCRIPTION),
        version: z.number().optional().describe(VERSION_DESCRIPTION),
        url: z.string().optional().describe(URL_DESCRIPTION),
        count: z.number().optional().describe(MATCH_COUNT_DESCRIPTION),
        matches: z.array(changeMatchSchema).optional().describe("Changed nodes"),
        warning: z.string().optional().describe(SIZE_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      since,
      until,
      type,
      parent_levels,
      sort,
      bypass_warning,
    }: {
      file_id: string;
      since: string | number;
      until?: string | number;
      type: string;
      parent_levels: ParentLevels;
      sort: string;
      bypass_warning: boolean;
    }) => {
      const config = getConfig();

      // Access check.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "read", false);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const parseTimestamp = (val: string | number, endOfDay: boolean = false): number => {
        if (typeof val === "number") return val;
        const date = new Date(val);
        // If it's a date-only string and endOfDay is true, use end of day.
        if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
          date.setUTCHours(23, 59, 59, 999);
        }
        return date.getTime();
      };

      const sinceTs = parseTimestamp(since, false);
      const untilTs = until ? parseTimestamp(until, true) : Date.now();

      if (isNaN(sinceTs)) {
        return makeErrorResponse("InvalidInput", "Invalid 'since' date format");
      }
      if (isNaN(untilTs)) {
        return makeErrorResponse("InvalidInput", "Invalid 'until' date format");
      }

      const doc = await store.read(file_id);
      const nodeMap = buildNodeMap(doc.nodes);
      const parentMap = buildParentMap(doc.nodes);

      const matches = doc.nodes
        .filter((node) => {
          const createdInRange = node.created >= sinceTs && node.created <= untilTs;
          const modifiedInRange = node.modified >= sinceTs && node.modified <= untilTs;

          if (type === "created") return createdInRange;
          if (type === "modified") return modifiedInRange && !createdInRange;
          return createdInRange || modifiedInRange;
        })
        .map((node) => {
          const createdInRange = node.created >= sinceTs && node.created <= untilTs;

          const match: Record<string, unknown> = {
            node_id: node.id,
            content: node.content,
            created: node.created,
            modified: node.modified,
            url: buildDynalistUrl(file_id, node.id),
            change_type: createdInRange ? "created" : "modified",
            collapsed: node.collapsed ?? false,
          };

          // Include optional fields only when present, consistent with read_document.
          if (node.checked !== undefined) match.checked = node.checked;
          if (node.checkbox !== undefined) match.show_checkbox = node.checkbox;
          if (node.heading !== undefined && node.heading > 0) match.heading = NUMBER_TO_HEADING[node.heading];
          if (node.color !== undefined && node.color > 0) match.color = NUMBER_TO_COLOR[node.color];

          // Include note only when non-empty.
          if (node.note && node.note.trim()) {
            match.note = node.note;
          }

          if (parent_levels !== "none") {
            const parents = getAncestors(nodeMap, parentMap, node.id, parent_levels);
            if (parents.length > 0) {
              match.parents = parents.map(p => ({ node_id: p.id, content: p.content }));
            }
          }

          return match;
        });

      // Sort results.
      matches.sort((a, b) => {
        const aTime = (a.change_type === "created" ? a.created : a.modified) as number;
        const bTime = (b.change_type === "created" ? b.created : b.modified) as number;
        return sort === "newest_first" ? bTime - aTime : aTime - bTime;
      });

      const result = {
        file_id,
        title: doc.title,
        version: doc.version,
        url: buildDynalistUrl(file_id),
        count: matches.length,
        matches,
      };

      const serialized = JSON.stringify(result, null, 2);
      const sizeCheck = checkContentSize(
        serialized,
        bypass_warning,
        [
          "Use a shorter time period (narrower since/until range)",
          "Use parent_levels: \"none\" to exclude parent context",
          "Filter by type: 'created' or 'modified' instead of 'both'",
        ],
        config.sizeWarning.warningTokenThreshold,
        config.sizeWarning.maxTokenThreshold,
      );

      if (sizeCheck) {
        return makeResponse({
          file_id,
          title: doc.title,
          version: doc.version,
          warning: sizeCheck.warning,
        });
      }

      return makeResponse(result);
    })
  );

  // ═════════════════════════════════════════════════════════════════════
  // TOOL: check_document_versions
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "check_document_versions",
    {
      description:
        "Check document version numbers without fetching content. " +
        "Detect changes before an expensive read_document call. " +
        "Version increments on each edit.",
      inputSchema: {
        file_ids: z.array(z.string()).describe("Array of document file IDs to check"),
      },
      outputSchema: {
        versions: z.record(z.string(), z.number()).describe(
          "Map of file ID to version number. -1 means the document was not found."
        ),
      },
    },
    wrapToolHandler(async ({ file_ids }: { file_ids: string[] }) => {
      const config = getConfig();
      const policies = await ac.getPolicies(file_ids, config);

      // Separate allowed from denied. Denied IDs get version -1
      // (indistinguishable from not-found) to avoid confirming existence.
      const allowedIds: string[] = [];
      const versions: Record<string, number> = {};
      for (const id of file_ids) {
        if (policies.get(id) === "deny") {
          versions[id] = -1;
        } else {
          allowedIds.push(id);
        }
      }

      if (allowedIds.length > 0) {
        const response = await client.checkForUpdates(allowedIds);
        for (const id of allowedIds) {
          versions[id] = response.versions[id] ?? -1;
        }
      }

      return makeResponse({ versions });
    })
  );
}
