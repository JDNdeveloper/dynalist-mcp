/**
 * Read tools: list_documents, search_documents, read_document,
 * search_in_document, get_recent_changes, check_document_versions.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DynalistClient, buildNodeMap, buildParentMap, findRootNodeId } from "../dynalist-client";
import { getConfig, getStartupConfig } from "../config";
import { AccessController, requireAccess } from "../access-control";
import {
  checkContentSize,
  makeResponse,
  makeErrorResponse,
  wrapToolHandler,
  getAncestors,
  getPermissionLabel,
  buildNodeTree,
  applyNodeMetadata,
} from "../utils/dynalist-helpers";
import type { DocumentStore } from "../document-store";
import type { ParentLevels } from "../utils/dynalist-helpers";
import {
  FILE_ID_DESCRIPTION, FOLDER_ID_DESCRIPTION, ITEM_ID_DESCRIPTION,
  DOCUMENT_TITLE_DESCRIPTION, FOLDER_TITLE_DESCRIPTION,
  SYNC_TOKEN_DESCRIPTION, SIZE_WARNING_DESCRIPTION, MATCH_COUNT_DESCRIPTION,
  BYPASS_WARNING_DESCRIPTION, PARENT_LEVELS_DESCRIPTION,
} from "./descriptions";
import { makeSyncToken } from "../sync-token";

// ─── Output schemas for read tools ──────────────────────────────────

// Shared fields for node summaries used in parents/children arrays.
const nodeSummarySchema = z.object({
  item_id: z.string().describe(ITEM_ID_DESCRIPTION),
  content: z.string().describe("Item text content"),
}).strict();

// Shared optional metadata fields present on output nodes and match objects.
const nodeMetadataFields = {
  note: z.string().optional().describe("Item note. Omitted when empty."),
  checked: z.boolean().optional().describe("Checked (completed) state. False if not present."),
  show_checkbox: z.boolean().optional().describe("Whether a checkbox is shown. False if not present."),
  heading: z.enum(["h1", "h2", "h3"]).optional().describe(
    "Heading level: 'h1', 'h2', 'h3'. Omitted when none."
  ),
  color: z.enum(["red", "orange", "yellow", "green", "blue", "purple"]).optional().describe(
    "Color label: 'red', 'orange', 'yellow', 'green', 'blue', 'purple'. Omitted when none."
  ),
};

// Collapsed state applies to document items (read_document, get_recent_changes).
// File-tree folders also have a collapsed field in the API response, but list_documents
// does not currently expose it.
//
// TODO: Expose collapsed folder state.
const collapsedField = {
  collapsed: z.boolean().optional().describe("Whether the item is collapsed in the UI. Omitted when not collapsed."),
};

// Recursive schema for the read_document item tree.
const outputNodeSchema: z.ZodType<{
  item_id: string;
  content: string;
  note?: string;
  checked?: boolean;
  show_checkbox?: boolean;
  heading?: string;
  color?: string;
  collapsed?: boolean;
  depth_limited?: true;
  child_count?: number;
  children?: unknown[];
}> = z.lazy(() =>
  z.object({
    item_id: z.string().describe(ITEM_ID_DESCRIPTION),
    content: z.string().describe("Item text content"),
    ...nodeMetadataFields,
    ...collapsedField,
    depth_limited: z.literal(true).optional().describe(
      "Present when max_depth cut off traversal. Call read_document with this item_id to expand."
    ),
    child_count: z.number().optional().describe(
      "Direct child count. Omitted on leaf items (no children). Present on collapsed items even when 0."
    ),
    children: z.array(outputNodeSchema).optional().describe(
      "Child items. Omitted when depth-limited, collapsed, or filtered."
    ),
  }).strict()
);

// Match object for search_in_document results.
const searchMatchSchema = z.object({
  item_id: z.string().describe(ITEM_ID_DESCRIPTION),
  content: z.string().describe("Item text content"),
  ...nodeMetadataFields,
  parents: z.array(nodeSummarySchema).optional().describe(
    "Ancestor chain. Present when parent_levels is not 'none' and ancestors exist."
  ),
}).strict();

// Match object for get_recent_changes results.
const changeMatchSchema = z.object({
  item_id: z.string().describe(ITEM_ID_DESCRIPTION),
  content: z.string().describe("Item text content"),
  change_type: z.enum(["created", "modified"]).describe("Whether this item was created or modified in the time range"),
  created: z.string().describe("Creation timestamp (ISO 8601)"),
  modified: z.string().describe("Last modified timestamp (ISO 8601)"),
  ...nodeMetadataFields,
  ...collapsedField,
  parents: z.array(nodeSummarySchema).optional().describe(
    "Ancestor chain. Present when parent_levels is not 'none' and ancestors exist."
  ),
}).strict();

// Document entry in the list_documents file tree.
const fileTreeDocumentSchema = z.object({
  file_id: z.string().describe(FILE_ID_DESCRIPTION),
  title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
  type: z.literal("document").describe("File type"),
  permission: z.enum(["none", "read", "edit", "manage", "owner"]).describe(
    "Permission level for this document"
  ),
  access_policy: z.enum(["read"]).optional().describe(
    "Access policy if restricted. Omitted when unrestricted."
  ),
}).strict();

// Recursive folder entry in the list_documents file tree.
const fileTreeFolderSchema: z.ZodType<{
  file_id: string;
  title: string;
  type: "folder";
  depth_limited?: true;
  child_count: number;
  children?: unknown[];
}> = z.lazy(() =>
  z.object({
    file_id: z.string().describe(FOLDER_ID_DESCRIPTION),
    title: z.string().describe(FOLDER_TITLE_DESCRIPTION),
    type: z.literal("folder").describe("File type"),
    depth_limited: z.literal(true).optional().describe(
      "Present when max_depth cut off traversal. Call list_documents with this folder's file_id to expand."
    ),
    child_count: z.number().describe(
      "Direct children count. Always present on folders, including empty folders with 0."
    ),
    children: z.array(fileTreeEntrySchema).optional().describe(
      "Child documents and folders. Omitted when depth-limited."
    ),
  }).strict()
);

// Union of document and folder entries.
const fileTreeEntrySchema = z.union([fileTreeDocumentSchema, fileTreeFolderSchema]);

export function registerReadTools(server: McpServer, client: DynalistClient, ac: AccessController, store: DocumentStore): void {
  const { readDefaults } = getStartupConfig();

  server.registerTool(
    "list_documents",
    {
      description:
        "List documents and folders as a recursive tree.",
      inputSchema: {
        folder_id: z.string().optional().describe(
          "Starting folder. Omit to list from the top level."
        ),
        max_depth: z.number().nullable().optional().default(null).describe(
          "Depth of folder nesting to include. 1 = direct children only, " +
          "2 = children + grandchildren, null = unlimited."
        ),
      },
      outputSchema: {
        document_count: z.number().describe("Total number of documents in the result"),
        files: z.array(fileTreeEntrySchema).describe(
          "Recursive file tree of intermixed documents and folders."
        ),
      },
    },
    wrapToolHandler(async ({
      folder_id,
      max_depth,
    }: {
      folder_id?: string;
      max_depth: number | null;
    }) => {
      const config = getConfig();
      const response = await client.listFiles();

      // Build a lookup map for all files.
      const fileMap = new Map(response.files.map((f) => [f.id, f]));

      // Build policies for all files to filter denied ones.
      const allIds = response.files.map((f) => f.id);
      const policies = await ac.getPolicies(allIds, config);

      // Validate folder_id if provided. Access check runs first so that
      // denied folders do not leak existence or type information.
      if (folder_id !== undefined) {
        if (policies.get(folder_id) === "deny") {
          return makeErrorResponse("NotFound", `Folder '${folder_id}' not found`);
        }
        const target = fileMap.get(folder_id);
        if (!target) {
          return makeErrorResponse("NotFound", `Folder '${folder_id}' not found`);
        }
        if (target.type === "document") {
          return makeErrorResponse("InvalidInput", `'${folder_id}' is a document, not a folder`);
        }
      }

      // Folders referenced by non-deny rule paths are visible even when
      // denied, so the agent can see the full folder chain.
      const ruleVisibleFolders = await ac.getRuleVisibleFolderIds(config);

      // Recursively build the file tree from a folder's children.
      // Check whether a denied folder has any visible descendants,
      // recursively. Used by countVisibleChildren to include denied
      // folders that serve as structural containers.
      function hasVisibleDescendants(folderId: string): boolean {
        const folder = fileMap.get(folderId);
        if (!folder) return false;
        for (const childId of folder.children ?? []) {
          const c = fileMap.get(childId);
          if (!c) continue;
          if (policies.get(childId) !== "deny") return true;
          if ((c.type === "folder" || c.type === "root") && hasVisibleDescendants(childId)) return true;
        }
        return false;
      }

      // Count how many direct children of a folder would be visible
      // when expanded. Matches buildFileTree's inclusion logic: non-denied
      // items always count; denied folders count when they have visible
      // descendants or are referenced by a non-deny rule path.
      function countVisibleChildren(folderId: string): number {
        const folder = fileMap.get(folderId);
        if (!folder) return 0;
        let count = 0;
        for (const childId of folder.children ?? []) {
          const c = fileMap.get(childId);
          if (!c) continue;
          if (policies.get(childId) !== "deny") {
            count++;
          } else if ((c.type === "folder" || c.type === "root") &&
                     (ruleVisibleFolders.has(childId) || hasVisibleDescendants(childId))) {
            count++;
          }
        }
        return count;
      }

      let documentCount = 0;

      function buildFileTree(folderId: string, currentDepth: number): Record<string, unknown>[] {
        const folder = fileMap.get(folderId);
        if (!folder) return [];

        // If past the depth limit, return nothing. The caller is
        // responsible for signaling depth_limited on the folder entry.
        if (max_depth !== null && currentDepth > max_depth) {
          return [];
        }

        const result: Record<string, unknown>[] = [];

        for (const childId of folder.children ?? []) {
          const child = fileMap.get(childId);
          if (!child) continue;

          const childPolicy = policies.get(childId);
          if (childPolicy === "deny") {
            // Denied documents are omitted entirely. Denied folders are
            // shown when they have visible descendants or are referenced
            // by a non-deny rule path.
            if (child.type === "folder" || child.type === "root") {
              const children = buildFileTree(childId, currentDepth + 1);
              if (children.length > 0 || ruleVisibleFolders.has(childId)) {
                const entry: Record<string, unknown> = {
                  file_id: child.id,
                  title: child.title,
                  type: "folder",
                  child_count: children.length,
                };
                if (children.length > 0) {
                  entry.children = children;
                }
                result.push(entry);
              }
            }
            continue;
          }

          if (child.type === "document") {
            const doc: Record<string, unknown> = {
              file_id: child.id,
              title: child.title,
              type: "document",
              permission: getPermissionLabel(child.permission),
            };
            if (childPolicy === "read") {
              doc.access_policy = "read";
            }
            documentCount++;
            result.push(doc);
          } else if (child.type === "folder") {
            // Check if we have reached the depth limit.
            if (max_depth !== null && currentDepth >= max_depth) {
              const entry: Record<string, unknown> = {
                file_id: child.id,
                title: child.title,
                type: "folder",
                depth_limited: true,
                child_count: countVisibleChildren(child.id),
              };
              result.push(entry);
            } else {
              const children = buildFileTree(child.id, currentDepth + 1);
              const entry: Record<string, unknown> = {
                file_id: child.id,
                title: child.title,
                type: "folder",
                child_count: children.length,
              };
              if (children.length > 0) {
                entry.children = children;
              }
              result.push(entry);
            }
          }
        }

        return result;
      }

      // Start from the target folder (or root).
      const startFolderId = folder_id ?? response.root_file_id;
      const files = buildFileTree(startFolderId, 1);

      return makeResponse({
        document_count: documentCount,
        files,
      });
    })
  );

  server.registerTool(
    "search_documents",
    {
      description:
        "Search for documents and folders by title. Does not search document content; " +
        "use search_in_document for that.\n\n" +
        "Each match has a type field ('document' or 'folder'). Document matches include " +
        "permission.",
      inputSchema: {
        query: z.string().describe("Regex pattern to match against document/folder names. Case-insensitive by default."),
        type: z.enum(["all", "document", "folder"]).optional().default("all").describe("Filter by type: 'document', 'folder', or 'all'"),
        case_sensitive: z.boolean().optional().default(false).describe("Case-sensitive matching."),
      },
      outputSchema: {
        count: z.number().describe(MATCH_COUNT_DESCRIPTION),
        matches: z.array(z.object({
          file_id: z.string().describe(FILE_ID_DESCRIPTION),
          title: z.string().describe("Document or folder title"),
          type: z.enum(["document", "folder"]).describe("Whether this is a document or folder"),
          permission: z.enum(["none", "read", "edit", "manage", "owner"]).optional().describe("Permission level (documents only)"),
          access_policy: z.enum(["read"]).optional().describe("Access policy if restricted. Omitted when unrestricted."),
        }).strict()).describe("Matching documents and/or folders"),
      },
    },
    wrapToolHandler(async ({ query, type, case_sensitive }: { query: string; type: string; case_sensitive: boolean }) => {
      const config = getConfig();
      const response = await client.listFiles();

      let regex: RegExp;
      try {
        regex = new RegExp(query, case_sensitive ? "" : "i");
      } catch (e) {
        return makeErrorResponse("InvalidInput", `Invalid regex pattern: ${(e as Error).message}`);
      }

      // Build policies for all files to filter denied ones.
      const allIds = response.files.map((f) => f.id);
      const policies = await ac.getPolicies(allIds, config);

      const matches = response.files
        .filter((f) => {
          if (policies.get(f.id) === "deny") return false;
          if (f.type === "root") return false;
          const nameMatch = regex.test(f.title ?? "");
          const typeMatch = type === "all" || f.type === type;
          return nameMatch && typeMatch;
        })
        .map((f) => {
          const policy = policies.get(f.id)!;
          const match: Record<string, unknown> = {
            file_id: f.id,
            title: f.title,
            type: f.type,
          };
          if (f.type === "document") {
            match.permission = getPermissionLabel(f.permission);
          }
          if (policy === "read") {
            match.access_policy = "read";
          }
          return match;
        });

      return makeResponse({
        count: matches.length,
        matches,
      });
    })
  );

  server.registerTool(
    "read_document",
    {
      description:
        "Read a document as a JSON item tree. Provide item_id to zoom into a subtree.\n\n" +
        "max_depth and include_collapsed_children are orthogonal: max_depth does NOT expand " +
        "collapsed items; include_collapsed_children does NOT bypass the depth limit.\n\n" +
        "The starting item always shows its children regardless of collapsed state.\n\n" +
        "Hidden children are signaled by depth_limited: true (max_depth cut off traversal). " +
        "Call read_document with that item_id to expand.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        item_id: z.string().optional().describe(
          "Starting item. Omit for document root."
        ),
        max_depth: z.number().nullable().optional().default(readDefaults.maxDepth).describe(
          "Max traversal depth. 0 = target only, 1 = target + children, null = unlimited."
        ),
        include_collapsed_children: z.boolean().optional().default(readDefaults.includeCollapsedChildren).describe(
          "Include collapsed items' children. When false, collapsed items show " +
          "child_count but omit children."
        ),
        include_notes: z.boolean().optional().default(readDefaults.includeNotes).describe(
          "Include item notes."
        ),
        include_checked: z.boolean().optional().default(readDefaults.includeChecked).describe(
          "Include checked/completed items."
        ),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
        sync_token: z.string().describe(SYNC_TOKEN_DESCRIPTION),
        item: outputNodeSchema.optional().describe("Root of the item tree"),
        warning: z.string().optional().describe(SIZE_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      item_id,
      max_depth,
      include_collapsed_children,
      include_notes,
      include_checked,
      bypass_warning,
    }: {
      file_id: string;
      item_id?: string;
      max_depth: number | null;
      include_collapsed_children: boolean;
      include_notes: boolean;
      include_checked: boolean;
      bypass_warning: boolean;
    }) => {
      const config = getConfig();

      // Access check.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "read");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const doc = await store.read(file_id);
      const nodeMap = buildNodeMap(doc.nodes);

      // Determine starting node.
      const startNodeId = item_id ?? findRootNodeId(doc.nodes);

      if (!nodeMap.has(startNodeId)) {
        return makeErrorResponse("ItemNotFound", `Item '${startNodeId}' not found in document`);
      }

      const tree = buildNodeTree(nodeMap, startNodeId, {
        maxDepth: max_depth,
        includeCollapsedChildren: include_collapsed_children,
        includeNotes: include_notes,
        includeChecked: include_checked,
      });

      if (!tree) {
        return makeErrorResponse("ItemNotFound", `Item '${startNodeId}' could not be rendered`);
      }

      // Check content size on serialized output.
      const serialized = JSON.stringify(tree, null, 2);
      const sizeCheck = checkContentSize(
        serialized,
        bypass_warning,
        [
          "Use max_depth to limit traversal depth (e.g., max_depth: 2)",
          "Target a specific item_id instead of entire document",
        ],
        config.sizeWarning.warningTokenThreshold,
        config.sizeWarning.maxTokenThreshold,
      );

      if (sizeCheck) {
        return makeResponse({
          file_id,
          title: doc.title,
          sync_token: makeSyncToken(file_id, doc.version),
          warning: sizeCheck.warning,
        });
      }

      return makeResponse({
        file_id,
        title: doc.title,
        sync_token: makeSyncToken(file_id, doc.version),
        item: tree,
      });
    })
  );

  server.registerTool(
    "search_in_document",
    {
      description:
        "Search for text in a document. Returns matching items with metadata. " +
        "Use parent_levels for ancestor breadcrumbs without a separate read_document call.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        query: z.string().describe("Regex pattern to match against item content and notes. Case-insensitive by default."),
        search_notes: z.boolean().optional().default(true).describe("Also search in notes"),
        case_sensitive: z.boolean().optional().default(false).describe("Case-sensitive matching."),
        parent_levels: z.enum(["none", "immediate", "all"]).optional().default("immediate").describe(PARENT_LEVELS_DESCRIPTION),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
        sync_token: z.string().describe(SYNC_TOKEN_DESCRIPTION),
        count: z.number().optional().describe(MATCH_COUNT_DESCRIPTION),
        matches: z.array(searchMatchSchema).optional().describe("Matching items"),
        warning: z.string().optional().describe(SIZE_WARNING_DESCRIPTION),
      },
    },
    wrapToolHandler(async ({
      file_id,
      query,
      search_notes,
      case_sensitive,
      parent_levels,
      bypass_warning,
    }: {
      file_id: string;
      query: string;
      search_notes: boolean;
      case_sensitive: boolean;
      parent_levels: ParentLevels;
      bypass_warning: boolean;
    }) => {
      const config = getConfig();

      // Access check.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "read");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      let regex: RegExp;
      try {
        regex = new RegExp(query, case_sensitive ? "" : "i");
      } catch (e) {
        return makeErrorResponse("InvalidInput", `Invalid regex pattern: ${(e as Error).message}`);
      }

      const doc = await store.read(file_id);
      const nodeMap = buildNodeMap(doc.nodes);
      const parentMap = buildParentMap(doc.nodes);

      const matches = doc.nodes
        .filter((node) => {
          const contentMatch = regex.test(node.content ?? "");
          const noteMatch = search_notes && regex.test(node.note ?? "");
          return contentMatch || noteMatch;
        })
        .map((node) => {
          const match: Record<string, unknown> = {
            item_id: node.id,
            content: node.content,
          };

          // Include optional metadata only when present, in canonical order.
          applyNodeMetadata(match, node, { includeNotes: true });

          // Nested structure always last.
          if (parent_levels !== "none") {
            const parents = getAncestors(nodeMap, parentMap, node.id, parent_levels);
            if (parents.length > 0) {
              match.parents = parents.map(p => ({ item_id: p.id, content: p.content }));
            }
          }

          return match;
        });

      const result = {
        file_id,
        title: doc.title,
        sync_token: makeSyncToken(file_id, doc.version),
        count: matches.length,
        matches,
      };

      const serialized = JSON.stringify(result, null, 2);
      const sizeCheck = checkContentSize(
        serialized,
        bypass_warning,
        [
          "Use a more specific query to reduce matches",
          "Use parent_levels: \"none\" to exclude parent context",
        ],
        config.sizeWarning.warningTokenThreshold,
        config.sizeWarning.maxTokenThreshold,
      );

      if (sizeCheck) {
        return makeResponse({
          file_id,
          title: doc.title,
          sync_token: makeSyncToken(file_id, doc.version),
          warning: sizeCheck.warning,
        });
      }

      return makeResponse(result);
    })
  );

  server.registerTool(
    "get_recent_changes",
    {
      description:
        "Get items created or modified within a time period. Accepts ISO 8601 date strings. " +
        "Date-only strings like '2025-03-11' are start-of-day for 'since' and " +
        "end-of-day for 'until'.",
      inputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        since: z.string().describe("Start: ISO 8601 date or datetime (e.g. '2024-01-15', '2024-01-15T09:30:00Z')"),
        until: z.string().optional().describe("End: ISO 8601 date or datetime (default: now)"),
        type: z.enum(["created", "modified", "both"]).optional().default("both").describe(
          "'created' = new items only, 'modified' = edited (not new) only, 'both' = all."
        ),
        parent_levels: z.enum(["none", "immediate", "all"]).optional().default("immediate").describe(PARENT_LEVELS_DESCRIPTION),
        sort: z.enum(["newest_first", "oldest_first"]).optional().default("newest_first").describe("Sort order by timestamp"),
        bypass_warning: z.boolean().optional().default(false).describe(BYPASS_WARNING_DESCRIPTION),
      },
      outputSchema: {
        file_id: z.string().describe(FILE_ID_DESCRIPTION),
        title: z.string().describe(DOCUMENT_TITLE_DESCRIPTION),
        sync_token: z.string().describe(SYNC_TOKEN_DESCRIPTION),
        count: z.number().optional().describe(MATCH_COUNT_DESCRIPTION),
        matches: z.array(changeMatchSchema).optional().describe("Changed items"),
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
      since: string;
      until?: string;
      type: string;
      parent_levels: ParentLevels;
      sort: string;
      bypass_warning: boolean;
    }) => {
      const config = getConfig();

      // Access check.
      const policy = await ac.getPolicy(file_id, config);
      const accessError = requireAccess(policy, "read");
      if (accessError) return makeErrorResponse(accessError.error, accessError.message);

      const parseTimestamp = (val: string, endOfDay: boolean = false): number => {
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
        return makeErrorResponse("InvalidInput", `Invalid 'since' value '${since}'. Expected ISO 8601 date (e.g. '2025-03-11') or datetime (e.g. '2025-03-11T09:30:00Z').`);
      }
      if (isNaN(untilTs)) {
        return makeErrorResponse("InvalidInput", `Invalid 'until' value '${until}'. Expected ISO 8601 date (e.g. '2025-03-11') or datetime (e.g. '2025-03-11T09:30:00Z').`);
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
            item_id: node.id,
            content: node.content,
            change_type: createdInRange ? "created" : "modified",
            created: new Date(node.created).toISOString(),
            modified: new Date(node.modified).toISOString(),
          };

          // Include optional metadata only when present, in canonical order.
          applyNodeMetadata(match, node, { includeNotes: true });
          if (node.collapsed) match.collapsed = true;

          // Nested structure always last.
          if (parent_levels !== "none") {
            const parents = getAncestors(nodeMap, parentMap, node.id, parent_levels);
            if (parents.length > 0) {
              match.parents = parents.map(p => ({ item_id: p.id, content: p.content }));
            }
          }

          return match;
        });

      // Sort results. ISO 8601 strings are lexicographically sortable.
      matches.sort((a, b) => {
        const aTime = (a.change_type === "created" ? a.created : a.modified) as string;
        const bTime = (b.change_type === "created" ? b.created : b.modified) as string;
        return sort === "newest_first" ? bTime.localeCompare(aTime) : aTime.localeCompare(bTime);
      });

      const result = {
        file_id,
        title: doc.title,
        sync_token: makeSyncToken(file_id, doc.version),
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
          sync_token: makeSyncToken(file_id, doc.version),
          warning: sizeCheck.warning,
        });
      }

      return makeResponse(result);
    })
  );

  server.registerTool(
    "check_document_versions",
    {
      description:
        "Check document sync tokens without fetching content. " +
        "Detect changes before an expensive read_document call. " +
        "Empty string means not found or access denied.",
      inputSchema: {
        file_ids: z.array(z.string()).describe("Array of document file IDs to check"),
      },
      outputSchema: {
        sync_tokens: z.record(z.string(), z.string()).describe(
          "Map of file ID to sync token. Empty string means the document was not found."
        ),
      },
    },
    wrapToolHandler(async ({ file_ids }: { file_ids: string[] }) => {
      const config = getConfig();
      const policies = await ac.getPolicies(file_ids, config);

      // Separate allowed from denied. Denied IDs get empty string
      // (indistinguishable from not-found) to avoid confirming existence.
      const allowedIds: string[] = [];
      const syncTokens: Record<string, string> = {};
      for (const id of file_ids) {
        if (policies.get(id) === "deny") {
          syncTokens[id] = "";
        } else {
          allowedIds.push(id);
        }
      }

      if (allowedIds.length > 0) {
        const response = await client.checkForUpdates(allowedIds);
        for (const id of allowedIds) {
          const version = response.versions[id];
          syncTokens[id] = version !== undefined ? makeSyncToken(id, version) : "";
        }
      }

      return makeResponse({ sync_tokens: syncTokens });
    })
  );
}
