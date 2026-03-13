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
import { FILE_ID_DESCRIPTION, BYPASS_WARNING_DESCRIPTION, PARENT_LEVELS_DESCRIPTION } from "./descriptions";

export function registerReadTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: list_documents
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "list_documents",
    {
      description:
        "List all documents and folders in your Dynalist account. Returns the folder hierarchy " +
        "(folders with children arrays containing document/folder IDs) so you can understand the " +
        "organizational structure. Use the returned file_id values as parameters for all other tools.",
      outputSchema: {
        count: z.number().describe("Total number of documents"),
        documents: z.array(z.object({
          file_id: z.string().describe("Document file ID, used as file_id parameter in other tools"),
          title: z.string().describe("Document title"),
          url: z.string().describe("Dynalist URL for the document"),
          permission: z.string().describe("Permission level: none, read, edit, manage, or owner"),
          access_policy: z.string().optional().describe("Access policy if restricted: 'read' means read-only"),
        })).describe("All documents in the account"),
        folders: z.array(z.object({
          file_id: z.string().describe("Folder file ID"),
          title: z.string().describe("Folder title"),
          children: z.array(z.string()).describe("File IDs of documents/folders inside this folder"),
        })).describe("All folders in the account"),
        root_file_id: z.string().describe("File ID of the root folder"),
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
        .filter((f) => f.type === "folder" && policies.get(f.id) !== "deny")
        .map((f) => ({
          file_id: f.id,
          title: f.title,
          children: (f.children ?? []).filter((childId) => policies.get(childId) !== "deny"),
        }));

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
        "Search for documents and folders by name. This is a client-side filter on the file tree, " +
        "not a server-side search. Useful for finding a document by name when you don't want to " +
        "parse the full file tree from list_documents.",
      inputSchema: {
        query: z.string().describe("Text to search for in document/folder names (case-insensitive)"),
        type: z.enum(["all", "document", "folder"]).optional().default("all").describe("Filter by type: 'document', 'folder', or 'all'"),
      },
      outputSchema: {
        count: z.number().describe("Number of matches found"),
        query: z.string().describe("The search query that was used"),
        matches: z.array(z.object({
          file_id: z.string().describe("File ID"),
          title: z.string().describe("File title"),
          type: z.enum(["document", "folder"]).describe("Whether this is a document or folder"),
          url: z.string().optional().describe("Dynalist URL (documents only)"),
          permission: z.string().optional().describe("Permission level (documents only)"),
          children: z.array(z.string()).optional().describe("Child file IDs (folders only)"),
          access_policy: z.string().optional().describe("Access policy if restricted"),
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
        "Read a Dynalist document as a structured JSON node tree. Omit node_id to read from the " +
        "document root (useful for seeing the full hierarchy to locate a node's position). Provide " +
        "node_id to zoom into a specific subtree.\n\n" +
        "Output size is controlled by two independent mechanisms:\n" +
        "- max_depth: limits tree traversal depth (default 5, null = unlimited).\n" +
        "- include_collapsed_children: includes children of collapsed nodes (default false).\n" +
        "These are orthogonal. Setting max_depth high does NOT expand collapsed nodes. Setting " +
        "include_collapsed_children: true does NOT bypass the depth limit.\n\n" +
        "The starting node (the node_id you pass, or the document root) always shows its children " +
        "regardless of collapsed state, matching the Dynalist UI zoom behavior.\n\n" +
        "When children are hidden, the response signals the cause (these are distinct):\n" +
        "- depth_limited: true means the max_depth limit cut off traversal. The node is NOT collapsed. " +
        "Fix: call read_document with that node's node_id to zoom in.\n" +
        "- collapsed: true with children_count > 0 means the user collapsed this node in the Dynalist UI. " +
        "Fix: re-request with include_collapsed_children: true, or pass its node_id to zoom in.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        node_id: z.string().optional().describe(
          "Node to start reading from. Omit to read from the document root."
        ),
        max_depth: z.number().nullable().optional().describe(
          "Maximum depth to traverse. 0 = only the target node, 1 = target + immediate children, " +
          "null = unlimited. Default: 5 (configurable via readDefaults.maxDepth)."
        ),
        include_collapsed_children: z.boolean().optional().describe(
          "Include children of collapsed nodes. When false (default), collapsed nodes show " +
          "children_count but children is empty. Set true to expand all collapsed nodes."
        ),
        include_notes: z.boolean().optional().describe(
          "Include node notes in the response. Default: true (configurable via readDefaults.includeNotes)."
        ),
        include_checked: z.boolean().optional().describe(
          "Include checked/completed nodes. When false, checked nodes are omitted entirely. " +
          "Default: true (configurable via readDefaults.includeChecked)."
        ),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().optional().describe("Document file ID"),
        title: z.string().optional().describe("Document title"),
        version: z.number().optional().describe(
          "Document version number. Pass this as expected_version to write tools to detect concurrent edits."
        ),
        url: z.string().optional().describe("Dynalist URL"),
        node: z.any().optional().describe(
          "Root of the node tree. Each node has: node_id (string), content (string), " +
          "note (string, omitted when empty), checked (boolean), checkbox (boolean), " +
          "heading (number, 0=none, 1=H1, 2=H2, 3=H3, omitted when 0), " +
          "color (number, 0=none, 1=red, 2=orange, 3=yellow, 4=green, 5=blue, 6=purple, omitted when 0), " +
          "collapsed (boolean, user-collapsed in UI, not the same as depth_limited), " +
          "depth_limited (true when max_depth cut off traversal, not the same as collapsed), " +
          "children_count (total direct children regardless of visibility), " +
          "children (array of child nodes, empty when hidden by depth/collapsed filtering)."
        ),
        warning: z.string().optional().describe("Size warning message when result exceeds token threshold"),
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

      const doc = await client.readDocument(file_id);
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
        return makeResponse({ warning: sizeCheck.warning });
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
        "Search for text in a Dynalist document. Returns matching nodes with full metadata. " +
        "Use parent_levels to include ancestor breadcrumbs, the most efficient way to " +
        "understand where matches live in the hierarchy without a separate read_document call.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        query: z.string().describe("Text to search for (case-insensitive)"),
        search_notes: z.boolean().optional().default(true).describe("Also search in notes"),
        parent_levels: z.number().optional().default(1).describe(PARENT_LEVELS_DESCRIPTION),
        include_children: z.boolean().optional().default(false).describe("Include direct children of each match"),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().optional().describe("Document file ID"),
        title: z.string().optional().describe("Document title"),
        url: z.string().optional().describe("Dynalist URL"),
        count: z.number().optional().describe("Number of matches found"),
        query: z.string().optional().describe("The search query that was used"),
        matches: z.array(z.any()).optional().describe(
          "Matching nodes. Each has: node_id, content, note (if present), url, checked, " +
          "checkbox, heading, color, collapsed, and optionally parents (array of {node_id, content}) " +
          "and children (array of {node_id, content})."
        ),
        warning: z.string().optional().describe("Size warning message when result exceeds token threshold"),
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
      parent_levels: number;
      include_children: boolean;
      bypass_warning: boolean;
    }) => {
      const config = getConfig();

      // Access check.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "read", false);
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const doc = await client.readDocument(file_id);
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
          if (node.checkbox !== undefined) match.checkbox = node.checkbox;
          if (node.heading !== undefined && node.heading > 0) match.heading = node.heading;
          if (node.color !== undefined && node.color > 0) match.color = node.color;

          // Include note only when non-empty.
          if (node.note && node.note.trim()) {
            match.note = node.note;
          }

          if (parent_levels > 0) {
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
          "Use parent_levels: 0 to exclude parent context",
          "Use include_children: false to exclude children",
        ],
        config.sizeWarning.warningTokenThreshold,
        config.sizeWarning.maxTokenThreshold,
      );

      if (sizeCheck) {
        return makeResponse({ warning: sizeCheck.warning });
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
        "Get nodes created or modified within a time period. Timestamps are milliseconds since " +
        "epoch. Date-only strings like '2025-03-11' are treated as start-of-day for 'since' and " +
        "end-of-day for 'until'.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        since: z.union([z.string(), z.number()]).describe("Start date: ISO string (e.g. '2024-01-15') or timestamp in milliseconds"),
        until: z.union([z.string(), z.number()]).optional().describe("End date: ISO string or timestamp in milliseconds (default: now)"),
        type: z.enum(["created", "modified", "both"]).optional().default("both").describe(
          "Filter by change type. 'created' = only new nodes, 'modified' = only edited (not newly created) nodes, " +
          "'both' = all changes (default)."
        ),
        parent_levels: z.number().optional().default(1).describe(PARENT_LEVELS_DESCRIPTION),
        sort: z.enum(["newest_first", "oldest_first"]).optional().default("newest_first").describe("Sort order by timestamp"),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().optional().describe("Document file ID"),
        title: z.string().optional().describe("Document title"),
        url: z.string().optional().describe("Dynalist URL"),
        count: z.number().optional().describe("Number of changes found"),
        matches: z.array(z.any()).optional().describe(
          "Changed nodes. Each has: node_id, content, note (if present), created, modified, " +
          "url, change_type, checked, checkbox, heading, color, collapsed, and optionally " +
          "parents (array of {node_id, content})."
        ),
        warning: z.string().optional().describe("Size warning message when result exceeds token threshold"),
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
      parent_levels: number;
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

      const doc = await client.readDocument(file_id);
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
          if (node.checkbox !== undefined) match.checkbox = node.checkbox;
          if (node.heading !== undefined && node.heading > 0) match.heading = node.heading;
          if (node.color !== undefined && node.color > 0) match.color = node.color;

          // Include note only when non-empty.
          if (node.note && node.note.trim()) {
            match.note = node.note;
          }

          if (parent_levels > 0) {
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
          "Use parent_levels: 0 to exclude parent context",
          "Filter by type: 'created' or 'modified' instead of 'both'",
        ],
        config.sizeWarning.warningTokenThreshold,
        config.sizeWarning.maxTokenThreshold,
      );

      if (sizeCheck) {
        return makeResponse({ warning: sizeCheck.warning });
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
        "Check version numbers for one or more documents without fetching their content. " +
        "Use this to detect whether a document has changed before doing an expensive " +
        "read_document call. The version number increases on every edit.",
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
