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

export function registerReadTools(server: McpServer, client: DynalistClient, ac: AccessController): void {
  // ═════════════════════════════════════════════════════════════════════
  // TOOL: list_documents
  // ═════════════════════════════════════════════════════════════════════
  server.registerTool(
    "list_documents",
    {
      description: "List all documents and folders in your Dynalist account.",
      outputSchema: {
        count: z.number().describe("Total number of documents"),
        documents: z.array(z.object({
          id: z.string().describe("Document ID"),
          title: z.string().describe("Document title"),
          url: z.string().describe("Dynalist URL for the document"),
          permission: z.string().describe("Permission level: none, read, edit, manage, or owner"),
          access_policy: z.string().optional().describe("Access policy if restricted: 'read' means read-only"),
        })).describe("All documents in the account"),
        folders: z.array(z.object({
          id: z.string().describe("Folder ID"),
          title: z.string().describe("Folder title"),
          children: z.array(z.string()).describe("IDs of documents/folders inside this folder"),
        })).describe("All folders in the account"),
        root_file_id: z.string().describe("ID of the root folder"),
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
            id: f.id,
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
          id: f.id,
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
      description: "Search for documents and folders by name. Returns matching items with their ID, title, URL, and type.",
      inputSchema: {
        query: z.string().describe("Text to search for in document/folder names (case-insensitive)"),
        type: z.enum(["all", "document", "folder"]).optional().default("all").describe("Filter by type: 'document', 'folder', or 'all'"),
      },
      outputSchema: {
        count: z.number().describe("Number of matches found"),
        query: z.string().describe("The search query that was used"),
        matches: z.array(z.object({
          id: z.string().describe("File ID"),
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
            id: f.id,
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
        "Read a Dynalist document or specific node. Returns a structured JSON tree with full node properties " +
        "(content, note, checked, checkbox, heading, color, collapsed, children). " +
        "Use max_depth to limit traversal depth on large documents.",
      inputSchema: {
        file_id: z.string().describe("Document ID"),
        node_id: z.string().optional().describe("Node to start from (omit to read from document root)"),
        max_depth: z.number().nullable().optional().describe(
          "Maximum depth to traverse. 0 = only the target node, 1 = target + immediate children, null = unlimited. " +
          "Default: 5 (configurable via readDefaults.maxDepth in ~/.dynalist-mcp.json)"
        ),
        include_collapsed_children: z.boolean().optional().describe(
          "Whether to include children of collapsed nodes. When false (default), collapsed nodes appear " +
          "but their children are omitted. The collapsed node includes children_count so you know " +
          "hidden content exists. Set true to expand collapsed nodes."
        ),
        include_notes: z.boolean().optional().describe(
          "Whether to include node notes. Default: true (configurable via readDefaults.includeNotes)"
        ),
        include_checked: z.boolean().optional().describe(
          "Whether to include checked/completed nodes. Default: true (configurable via readDefaults.includeChecked)"
        ),
        bypass_warning: z.boolean().optional().default(false).describe(
          "ONLY set to true AFTER receiving a size warning. Do NOT set true on the first request."
        ),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        title: z.string().describe("Document title"),
        url: z.string().describe("Dynalist URL"),
        node: z.any().describe(
          "Root of the node tree. Each node has: node_id (string), content (string), " +
          "note (string, if present), checked (boolean), checkbox (boolean), heading (number 0-3), " +
          "color (number 0-6), collapsed (boolean), depth_limited (true when depth limit caused " +
          "children to be omitted), children_count (total direct children regardless of visibility), " +
          "children (array of child nodes, empty when omitted by depth/collapsed filtering)"
        ),
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

      const effectiveMaxDepth = max_depth ?? config.readDefaults.maxDepth;
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
        "Search for text in a Dynalist document. Returns matching nodes with optional parent context and children.",
      inputSchema: {
        file_id: z.string().describe("Document ID"),
        query: z.string().describe("Text to search for (case-insensitive)"),
        search_notes: z.boolean().optional().default(true).describe("Also search in notes"),
        parent_levels: z.number().optional().default(1).describe("How many parent levels to include (0 = none)"),
        include_children: z.boolean().optional().default(false).describe("Include direct children of each match"),
        bypass_warning: z.boolean().optional().default(false).describe("ONLY use after receiving a size warning. Do NOT set true on first request."),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        title: z.string().describe("Document title"),
        url: z.string().describe("Dynalist URL"),
        count: z.number().describe("Number of matches found"),
        query: z.string().describe("The search query that was used"),
        matches: z.array(z.any()).describe(
          "Matching nodes. Each has: node_id, content, note, url, and optionally " +
          "parents (array of {id, content}) and children (array of {id, content})"
        ),
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
            note: node.note || undefined,
            url: buildDynalistUrl(file_id, node.id),
          };

          if (parent_levels > 0) {
            const parents = getAncestors(nodeMap, parentMap, node.id, parent_levels);
            if (parents.length > 0) {
              match.parents = parents;
            }
          }

          if (include_children && node.children && node.children.length > 0) {
            match.children = node.children
              .map(childId => {
                const childNode = nodeMap.get(childId);
                return childNode ? { id: childNode.id, content: childNode.content } : null;
              })
              .filter((c): c is { id: string; content: string } => c !== null);
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
        "Get nodes created or modified within a time period.",
      inputSchema: {
        file_id: z.string().describe("Document ID"),
        since: z.union([z.string(), z.number()]).describe("Start date - ISO string (e.g. '2024-01-15') or timestamp in milliseconds"),
        until: z.union([z.string(), z.number()]).optional().describe("End date - ISO string or timestamp (default: now)"),
        type: z.enum(["created", "modified", "both"]).optional().default("both").describe(
          "Filter by change type. 'created' = only new nodes, 'modified' = only edited (not newly created) nodes, " +
          "'both' = all changes (default)"
        ),
        parent_levels: z.number().optional().default(1).describe("How many parent levels to include for context"),
        sort: z.enum(["newest_first", "oldest_first"]).optional().default("newest_first").describe("Sort order by timestamp"),
        bypass_warning: z.boolean().optional().default(false).describe("ONLY use after receiving a size warning. Do NOT set true on first request."),
      },
      outputSchema: {
        file_id: z.string().describe("Document ID"),
        title: z.string().describe("Document title"),
        url: z.string().describe("Dynalist URL"),
        count: z.number().describe("Number of changes found"),
        matches: z.array(z.any()).describe(
          "Changed nodes. Each has: node_id, content, created, modified, url, change_type, " +
          "and optionally parents (array of {id, content})"
        ),
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
          };

          if (parent_levels > 0) {
            const parents = getAncestors(nodeMap, parentMap, node.id, parent_levels);
            if (parents.length > 0) {
              match.parents = parents;
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
        "Useful for detecting changes before doing expensive reads.",
      inputSchema: {
        file_ids: z.array(z.string()).describe("Array of document IDs to check"),
      },
      outputSchema: {
        versions: z.record(z.string(), z.number()).describe(
          "Map of document ID to version number. -1 means the document was not found."
        ),
        denied: z.array(z.string()).optional().describe(
          "Document IDs that were denied by access policy (no metadata leaked)"
        ),
      },
    },
    wrapToolHandler(async ({ file_ids }: { file_ids: string[] }) => {
      const config = getConfig();
      const policies = await ac.getPolicies(file_ids, config);

      // Split into allowed and denied.
      const allowedIds: string[] = [];
      const deniedIds: string[] = [];
      for (const id of file_ids) {
        if (policies.get(id) === "deny") {
          deniedIds.push(id);
        } else {
          allowedIds.push(id);
        }
      }

      const versions: Record<string, number> = {};

      if (allowedIds.length > 0) {
        const response = await client.checkForUpdates(allowedIds);
        for (const id of allowedIds) {
          versions[id] = response.versions[id] ?? -1;
        }
      }

      const result: Record<string, unknown> = { versions };
      if (deniedIds.length > 0) {
        result.denied = deniedIds;
      }

      return makeResponse(result);
    })
  );
}
