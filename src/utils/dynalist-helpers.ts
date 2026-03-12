/**
 * Shared helpers used across tool modules.
 */

import type { DynalistNode } from "../dynalist-client";
import { DynalistClient, DynalistApiError } from "../dynalist-client";
import { ConfigError } from "../config";
import type { EditDocumentChange } from "../dynalist-client";
import { buildDynalistUrl } from "./url-parser";
import type { ParsedNode } from "./markdown-parser";
import { groupByLevel } from "./markdown-parser";
import type { NodeSummary, OutputNode, InsertTreeOptions } from "../types";

/**
 * Estimate token count (~4 chars per token).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Check content size and return warning if too large.
 * Returns null if content is OK, or a warning object.
 */
export function checkContentSize(
  content: string,
  bypassWarning: boolean,
  recommendations: string[],
  warningThreshold: number = 5000,
  maxThreshold: number = 24500,
): { warning: string; canBypass: boolean } | null {
  const tokenCount = estimateTokens(content);

  // If bypass was used preemptively (result is small), warn against this practice.
  if (bypassWarning && tokenCount <= warningThreshold) {
    return {
      warning: `INCORRECT USAGE: You used bypass_warning: true preemptively.\n\n` +
        `The bypass_warning option should ONLY be used AFTER receiving a size warning, ` +
        `not on the first request. Please repeat the request WITHOUT bypass_warning to get the result.\n\n` +
        `This ensures you're aware of large results before they fill your context.`,
      canBypass: false,
    };
  }

  // Bypass only works for results between warning and max threshold.
  // Results exceeding max threshold cannot be bypassed.
  if (tokenCount <= warningThreshold || (bypassWarning && tokenCount <= maxThreshold)) {
    return null;
  }

  const canBypass = tokenCount <= maxThreshold;

  let warning = `LARGE RESULT WARNING\n`;
  warning += `This query would return ~${tokenCount.toLocaleString()} tokens which may fill your context.\n\n`;
  warning += `Recommendations:\n`;
  for (const rec of recommendations) {
    warning += `- ${rec}\n`;
  }

  if (canBypass) {
    warning += `\nTo receive the full result anyway (~${tokenCount.toLocaleString()} tokens), repeat the SAME request with bypass_warning: true`;
  } else {
    warning += `\nResult too large (>${maxThreshold.toLocaleString()} tokens). Please reduce the scope using the recommendations above.`;
  }

  return { warning, canBypass };
}

/**
 * Build a structured MCP tool response with both structuredContent
 * and a text content block for backwards compatibility.
 */
export function makeResponse(data: Record<string, unknown>) {
  return {
    structuredContent: data,
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Build a structured MCP error response.
 */
export function makeErrorResponse(code: string, message: string) {
  return {
    structuredContent: { error: code, message },
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

/**
 * Wrap a tool handler in try/catch so that unhandled exceptions are returned
 * as structured MCP error responses instead of crashing the server.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapToolHandler(fn: (...args: any[]) => Promise<any>): any {
  return async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof PartialInsertError) {
        return error.toStructuredResponse();
      }
      if (error instanceof ConfigError) {
        return makeErrorResponse("ConfigError", error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof DynalistApiError ? error.code : "Unknown";
      return makeErrorResponse(code, message);
    }
  };
}

/**
 * Get ancestor nodes (parents) up to N levels.
 * Returns array with nearest parent first.
 */
export function getAncestors(
  nodeMap: Map<string, DynalistNode>,
  parentMap: Map<string, { parentId: string; index: number }>,
  nodeId: string,
  levels: number
): NodeSummary[] {
  if (levels <= 0) return [];

  const ancestors: NodeSummary[] = [];
  let currentId = nodeId;

  for (let i = 0; i < levels; i++) {
    const parentInfo = parentMap.get(currentId);
    if (!parentInfo) break;

    const parentNode = nodeMap.get(parentInfo.parentId);
    if (!parentNode) break;

    ancestors.push({ id: parentNode.id, content: parentNode.content });
    currentId = parentNode.id;
  }

  return ancestors;
}

/**
 * Convert permission number to readable label.
 */
export function getPermissionLabel(permission: number): string {
  switch (permission) {
    case 0: return "none";
    case 1: return "read";
    case 2: return "edit";
    case 3: return "manage";
    case 4: return "owner";
    default: return "unknown";
  }
}

/**
 * Build a structured node tree for read_document output.
 * Respects max_depth, collapsed state, checked filtering, and notes filtering.
 */
export function buildNodeTree(
  nodeMap: Map<string, DynalistNode>,
  nodeId: string,
  options: {
    maxDepth: number | null;
    includeCollapsedChildren: boolean;
    includeNotes: boolean;
    includeChecked: boolean;
  },
  currentDepth: number = 0,
): OutputNode | null {
  const node = nodeMap.get(nodeId);
  if (!node) return null;

  // Skip checked items if disabled.
  if (!options.includeChecked && node.checked) {
    return null;
  }

  const isCollapsed = node.collapsed === true;
  const childIds = node.children || [];
  const childrenCount = childIds.length;
  const effectiveMaxDepth = options.maxDepth ?? Infinity;

  // Determine whether to include children.
  const atMaxDepth = currentDepth >= effectiveMaxDepth;
  const collapsedHidesChildren = isCollapsed && !options.includeCollapsedChildren;
  const shouldOmitChildren = atMaxDepth || collapsedHidesChildren;

  const outputChildren: OutputNode[] = [];

  if (!shouldOmitChildren) {
    for (const childId of childIds) {
      const childNode = buildNodeTree(nodeMap, childId, options, currentDepth + 1);
      if (childNode) {
        outputChildren.push(childNode);
      }
    }
  }

  const output: OutputNode = {
    node_id: node.id,
    content: node.content,
    collapsed: isCollapsed,
    children_count: childrenCount,
    children: outputChildren,
  };

  // Include optional fields only when present.
  if (options.includeNotes && node.note && node.note.trim()) {
    output.note = node.note;
  }
  if (node.checked !== undefined) output.checked = node.checked;
  if (node.checkbox !== undefined) output.checkbox = node.checkbox;
  if (node.heading !== undefined && node.heading > 0) output.heading = node.heading;
  if (node.color !== undefined && node.color > 0) output.color = node.color;

  // Signal depth_limited when the depth limit caused children to be omitted.
  // Only set on nodes that have children and are NOT being hidden by collapsed state alone.
  if (atMaxDepth && childrenCount > 0 && !collapsedHidesChildren) {
    output.depth_limited = true;
  }

  return output;
}

/**
 * Error thrown on partial insert failure. Contains enough context for the
 * caller to report what was created before the failure occurred.
 */
export class PartialInsertError extends Error {
  readonly fileId: string;
  readonly insertedCount: number;
  readonly totalCount: number;
  readonly firstNodeId: string | undefined;
  readonly failedAtDepth: number;

  constructor(opts: {
    fileId: string;
    insertedCount: number;
    totalCount: number;
    firstNodeId: string | undefined;
    failedAtDepth: number;
    cause: unknown;
  }) {
    const msg = `Inserted ${opts.insertedCount} of ${opts.totalCount} nodes before failure at depth ${opts.failedAtDepth}. You may need to clean up partial results.`;
    super(msg, { cause: opts.cause });
    this.name = "PartialInsertError";
    this.fileId = opts.fileId;
    this.insertedCount = opts.insertedCount;
    this.totalCount = opts.totalCount;
    this.firstNodeId = opts.firstNodeId;
    this.failedAtDepth = opts.failedAtDepth;
  }

  toStructuredResponse() {
    const url = this.firstNodeId
      ? buildDynalistUrl(this.fileId, this.firstNodeId)
      : buildDynalistUrl(this.fileId);
    return {
      structuredContent: {
        error: "PartialInsert",
        message: this.message,
        file_id: this.fileId,
        inserted_count: this.insertedCount,
        total_count: this.totalCount,
        first_node_id: this.firstNodeId ?? null,
        url,
      },
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          error: "PartialInsert",
          message: this.message,
          file_id: this.fileId,
          inserted_count: this.insertedCount,
          total_count: this.totalCount,
          first_node_id: this.firstNodeId ?? null,
          url,
        }),
      }],
      isError: true,
    };
  }
}

/**
 * Insert a tree of nodes under a parent, level by level.
 * Returns total nodes created and array of created node IDs for level 0.
 *
 * On partial failure (e.g. network error mid-insert), throws a
 * PartialInsertError with context about what was created.
 */
export async function insertTreeUnderParent(
  client: DynalistClient,
  fileId: string,
  parentId: string,
  tree: ParsedNode[],
  options: InsertTreeOptions = {}
): Promise<{ totalCreated: number; rootNodeIds: string[] }> {
  if (tree.length === 0) {
    return { totalCreated: 0, rootNodeIds: [] };
  }

  const levels = groupByLevel(tree);
  const totalCount = levels.reduce((sum, level) => sum + level.length, 0);
  let totalCreated = 0;
  let rootNodeIds: string[] = [];
  let previousLevelIds: string[] = [];

  for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
    const level = levels[levelIdx];
    const changes: EditDocumentChange[] = [];
    const childCountPerParent = new Map<string, number>();

    for (const node of level) {
      const nodeParentId = node.parentLevelIndex === -1
        ? parentId
        : previousLevelIds[node.parentLevelIndex];

      // For level 0, use the caller's startIndex. When undefined (as_last_child),
      // every insert uses -1 to append at end. For deeper levels, children are
      // inserted into freshly created parents so index 0 is correct.
      const baseIndex = levelIdx === 0
        ? (options.startIndex ?? -1)
        : 0;
      const count = childCountPerParent.get(nodeParentId) || 0;

      // When appending at end (-1), every insert must use -1 so the server
      // appends each one after the previous. Adding count would produce
      // non-negative indices that insert at the wrong position.
      const insertIndex = baseIndex === -1 ? -1 : baseIndex + count;

      changes.push({
        action: "insert",
        parent_id: nodeParentId,
        index: insertIndex,
        content: node.content,
        checkbox: options.checkbox || undefined,
      });
      childCountPerParent.set(nodeParentId, count + 1);
    }

    try {
      const response = await client.editDocument(fileId, changes);
      const newIds = response.new_node_ids || [];

      if (levelIdx === 0) {
        rootNodeIds = newIds;
      }

      totalCreated += newIds.length;
      previousLevelIds = newIds;
    } catch (error) {
      throw new PartialInsertError({
        fileId,
        insertedCount: totalCreated,
        totalCount,
        firstNodeId: rootNodeIds[0],
        failedAtDepth: levelIdx,
        cause: error,
      });
    }
  }

  return { totalCreated, rootNodeIds };
}
