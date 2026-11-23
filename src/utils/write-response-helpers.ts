/**
 * Post-write readback for item write tools. After a guarded write, re-reads
 * the document and returns a tree pruned to the changed area plus a fresh
 * sync token, so the agent can verify its edits without a separate
 * read_document call.
 */

import { z } from "zod";
import { buildNodeMap, buildParentMap, findRootNodeId, type DynalistNode } from "../dynalist-client";
import { getConfig } from "../config";
import type { DocumentStore } from "../document-store";
import { makeSyncToken } from "../sync-token";
import { CONCURRENT_EDIT_WARNING, type VersionGuardResult } from "../version-guard";
import { applyNodeMetadata, buildNodeTree, estimateTokens } from "./dynalist-helpers";
import type { OutputNode } from "../types";
import { nodeMetadataFields, collapsedField } from "../tools/read";
import {
  ITEM_ID_DESCRIPTION, REREAD_GUIDANCE, SYNC_WARNING_DESCRIPTION,
  WRITE_SYNC_TOKEN_DESCRIPTION, WRITE_READBACK_WARNING_DESCRIPTION, WRITE_READBACK_DESCRIPTION,
} from "../tools/descriptions";

// Number of unchanged siblings shown on each side of a changed position.
const READBACK_CONTEXT_SIBLINGS = 1;

// Parents with at most this many children are shown in full, since
// windowing them would hide only one or two siblings.
const READBACK_SHOW_ALL_MAX_CHILDREN = 5;

/**
 * A location the write changed, resolved against the post-write document.
 *
 * - item: an item that exists after the write (edited, inserted, moved, or
 *   promoted). expand renders its full subtree instead of only the item.
 * - slot: the position in a parent's children where items were removed.
 * - children: every child of a parent (used when all children changed).
 */
export type ReadbackTarget =
  | { type: "item"; itemId: string; expand?: boolean }
  | { type: "slot"; parentId: string; index: number }
  | { type: "children"; parentId: string };

/**
 * Placeholder for consecutive siblings left out of the readback.
 */
export interface OmittedMarker {
  omitted: number;
}

/**
 * An item in the readback tree. Matches read_document's item shape, except
 * that children may contain OmittedMarker entries and child_count counts
 * every child, including omitted ones.
 */
export type ReadbackNode = Omit<OutputNode, "children"> & {
  children?: Array<ReadbackNode | OmittedMarker>;
};

export interface WriteReadback {
  // Scalar response fields in canonical schema order. Spread these into the
  // response before any nested structures.
  scalars: { sync_token?: string; sync_warning?: string; warning?: string };
  readback?: ReadbackNode;
}

const omittedMarkerSchema = z.object({
  omitted: z.number().describe("Number of consecutive siblings not shown at this position."),
}).strict();

// The children union has no literal discriminator: items keep
// read_document's exact shape, and the two variants are told apart by
// item_id versus omitted.
const readbackNodeSchema: z.ZodType<ReadbackNode> = z.lazy(() =>
  z.object({
    item_id: z.string().describe(ITEM_ID_DESCRIPTION),
    content: z.string().describe("Item text content"),
    ...nodeMetadataFields,
    ...collapsedField,
    depth_limited: z.literal(true).optional().describe(
      "Present when this item's children are not included. Call read_document with this item_id to expand."
    ),
    child_count: z.number().optional().describe(
      "Total direct children, including omitted ones. Omitted on leaf items."
    ),
    children: z.array(z.union([readbackNodeSchema, omittedMarkerSchema])).optional().describe(
      "Child items in order. Each { omitted: n } entry stands for n consecutive siblings not shown."
    ),
  }).strict()
) as z.ZodType<ReadbackNode>;

/**
 * Output schema fields shared by every item write tool. Spread
 * readbackScalarOutputFields before the tool's nested structures and
 * readbackOutputField last.
 */
export const readbackScalarOutputFields = {
  sync_token: z.string().optional().describe(WRITE_SYNC_TOKEN_DESCRIPTION),
  sync_warning: z.string().optional().describe(SYNC_WARNING_DESCRIPTION),
  warning: z.string().optional().describe(WRITE_READBACK_WARNING_DESCRIPTION),
};
export const readbackOutputField = {
  readback: readbackNodeSchema.optional().describe(WRITE_READBACK_DESCRIPTION),
};

/**
 * Re-read the document after a guarded write and render the readback tree
 * around the given targets.
 *
 * The sync token comes from the readback's own version, and is returned only
 * when that version equals the guard's post-write version. A mismatch means
 * another client edited the document between the post-write check and the
 * readback, so the readback would not reflect only this write.
 */
export async function readBackWrite<T>(
  store: DocumentStore,
  fileId: string,
  guard: VersionGuardResult<T>,
  targets: ReadbackTarget[],
): Promise<WriteReadback> {
  if (guard.syncWarning) {
    return { scalars: { sync_warning: guard.syncWarning } };
  }

  let doc;
  try {
    doc = await store.read(fileId);
  } catch {
    // The write already succeeded, so a failed readback must not turn into
    // an error response.
    return {
      scalars: { sync_warning: `Write succeeded, but the post-write read failed. ${REREAD_GUIDANCE}` },
    };
  }

  if (doc.version !== guard.postWriteVersion) {
    return { scalars: { sync_warning: CONCURRENT_EDIT_WARNING } };
  }

  const syncToken = makeSyncToken(fileId, doc.version);
  const readback = buildReadback(doc.nodes, targets);

  const { warningTokenThreshold } = getConfig().sizeWarning;
  if (estimateTokens(JSON.stringify(readback)) > warningTokenThreshold) {
    return {
      scalars: {
        sync_token: syncToken,
        warning:
          "Readback omitted because it exceeds the size threshold. " +
          "Read the affected items with read_document to verify.",
      },
    };
  }

  return { scalars: { sync_token: syncToken }, readback };
}

/**
 * Build a tree from the document root pruned to the targets. Each target's
 * parent shows the changed positions plus adjacent siblings, every ancestor
 * on the path to the root shows the child leading to it, and every run of
 * hidden siblings becomes one OmittedMarker.
 */
function buildReadback(nodes: DynalistNode[], targets: ReadbackTarget[]): ReadbackNode {
  const nodeMap = buildNodeMap(nodes);
  const parentMap = buildParentMap(nodes);
  const rootId = findRootNodeId(nodes);

  // isChangeSite is false for groups that exist only because they are
  // ancestors on the path to a change. Those show only the child on the
  // path, even when they have few children.
  interface ParentGroup {
    isChangeSite: boolean;
    showAll: boolean;
    indices: Set<number>;
  }
  const groups = new Map<string, ParentGroup>();
  const expandIds = new Set<string>();
  function groupFor(parentId: string): ParentGroup {
    let group = groups.get(parentId);
    if (!group) {
      group = { isChangeSite: false, showAll: false, indices: new Set() };
      groups.set(parentId, group);
    }
    return group;
  }
  function changeSiteGroupFor(parentId: string): ParentGroup {
    const group = groupFor(parentId);
    group.isChangeSite = true;
    return group;
  }
  function addRange(group: ParentGroup, start: number, end: number): void {
    for (let i = start; i <= end; i++) group.indices.add(i);
  }

  for (const target of targets) {
    if (target.type === "item") {
      // Items without a parent (the root, or an item a concurrent edit
      // removed) have no position to show.
      const location = parentMap.get(target.itemId);
      if (!location) continue;
      addRange(
        changeSiteGroupFor(location.parentId),
        location.index - READBACK_CONTEXT_SIBLINGS,
        location.index + READBACK_CONTEXT_SIBLINGS,
      );
      if (target.expand) expandIds.add(target.itemId);
    } else if (target.type === "slot") {
      if (!nodeMap.has(target.parentId)) continue;
      // A slot sits between index - 1 and index, so the window covers the
      // siblings on either side of the gap.
      addRange(
        changeSiteGroupFor(target.parentId),
        target.index - READBACK_CONTEXT_SIBLINGS,
        target.index + READBACK_CONTEXT_SIBLINGS - 1,
      );
    } else {
      if (!nodeMap.has(target.parentId)) continue;
      changeSiteGroupFor(target.parentId).showAll = true;
    }
  }

  // Connect every changed parent to the root by showing the child on the
  // path at each ancestor level.
  for (const parentId of [...groups.keys()]) {
    let childId = parentId;
    let location = parentMap.get(childId);
    while (location) {
      groupFor(location.parentId).indices.add(location.index);
      childId = location.parentId;
      location = parentMap.get(childId);
    }
  }

  function render(nodeId: string): ReadbackNode {
    const node = nodeMap.get(nodeId)!;
    const group = groups.get(nodeId);

    // Inserted items show their full subtree, since that is exactly what the
    // agent asked to create. Items off the changed paths are depth-limited.
    if (expandIds.has(nodeId) || !group) {
      return buildNodeTree(nodeMap, nodeId, {
        maxDepth: expandIds.has(nodeId) ? null : 0,
        includeCollapsedChildren: false,
        includeNotes: true,
        includeChecked: true,
        includeTimestamps: false,
      }) as ReadbackNode;
    }

    const output = { item_id: node.id, content: node.content } as ReadbackNode;
    applyNodeMetadata(output, node, { includeNotes: true });
    if (node.collapsed) output.collapsed = true;

    const childIds = node.children ?? [];
    const childCount = childIds.length;
    if (childCount === 0) return output;

    const showAll = group.showAll || (group.isChangeSite && childCount <= READBACK_SHOW_ALL_MAX_CHILDREN);
    const indices = showAll
      ? childIds.map((_, i) => i)
      : [...group.indices].filter((i) => i >= 0 && i < childCount).sort((a, b) => a - b);

    const children: Array<ReadbackNode | OmittedMarker> = [];
    let nextIndex = 0;
    for (const index of indices) {
      if (index > nextIndex) children.push({ omitted: index - nextIndex });
      children.push(render(childIds[index]));
      nextIndex = index + 1;
    }
    if (nextIndex < childCount) children.push({ omitted: childCount - nextIndex });

    output.child_count = childCount;
    output.children = children;
    return output;
  }

  return render(rootId);
}
