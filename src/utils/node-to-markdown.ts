/**
 * Convert Dynalist nodes to Markdown format
 */

import { DynalistNode, buildNodeMap } from "../dynalist-client.js";

export interface ConvertOptions {
  /** Maximum depth to traverse (undefined = unlimited) */
  maxDepth?: number;
  /** Include notes as sub-bullets */
  includeNotes?: boolean;
  /** Include checked/completed items */
  includeChecked?: boolean;
  /** Indent string (default: 4 spaces) */
  indent?: string;
}

const DEFAULT_OPTIONS: Required<ConvertOptions> = {
  maxDepth: Infinity,
  includeNotes: true,
  includeChecked: true,
  indent: "    ",
};

/**
 * Convert a node and its children to Markdown
 */
export function nodeToMarkdown(
  nodes: DynalistNode[],
  rootNodeId: string,
  options: ConvertOptions = {}
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const nodeMap = buildNodeMap(nodes);

  return renderNode(nodeMap, rootNodeId, 0, opts);
}

/**
 * Recursively render a node and its children
 */
function renderNode(
  nodeMap: Map<string, DynalistNode>,
  nodeId: string,
  depth: number,
  options: Required<ConvertOptions>
): string {
  const node = nodeMap.get(nodeId);
  if (!node) return "";

  // Skip checked items if option is disabled
  if (!options.includeChecked && node.checked) {
    return "";
  }

  // Check max depth
  if (depth > options.maxDepth) {
    return "";
  }

  const indent = options.indent.repeat(depth);
  let result = "";

  // Build the bullet line
  const bullet = formatBullet(node);
  const content = formatContent(node);

  const children = node.children || [];
  if (content || children.length > 0) {
    result += `${indent}${bullet}${content}\n`;
  }

  // Add note as sub-bullet if present and enabled
  if (options.includeNotes && node.note && node.note.trim()) {
    const noteIndent = options.indent.repeat(depth + 1);
    // Split note by newlines and render each as a sub-bullet
    const noteLines = node.note.split("\n").filter((line) => line.trim());
    for (const noteLine of noteLines) {
      result += `${noteIndent}- ${noteLine.trim()}\n`;
    }
  }

  // Render children
  for (const childId of children) {
    result += renderNode(nodeMap, childId, depth + 1, options);
  }

  return result;
}

/**
 * Format the bullet prefix based on node properties
 */
function formatBullet(node: DynalistNode): string {
  // Checkbox items
  if (node.checkbox) {
    return node.checked ? "- [x] " : "- [ ] ";
  }

  // Heading items (h1, h2, h3)
  if (node.heading && node.heading > 0) {
    const hashes = "#".repeat(node.heading);
    return `${hashes} `;
  }

  // Regular bullet
  return "- ";
}

/**
 * Format the content text
 */
function formatContent(node: DynalistNode): string {
  return node.content || "";
}

/**
 * Get a subtree starting from a specific node
 */
export function getSubtree(
  nodes: DynalistNode[],
  startNodeId: string
): DynalistNode[] {
  const nodeMap = buildNodeMap(nodes);
  const result: DynalistNode[] = [];
  const visited = new Set<string>();

  function collect(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = nodeMap.get(nodeId);
    if (!node) return;

    result.push(node);
    for (const childId of node.children || []) {
      collect(childId);
    }
  }

  collect(startNodeId);
  return result;
}

/**
 * Convert entire document to Markdown, starting from root
 */
export function documentToMarkdown(
  nodes: DynalistNode[],
  options: ConvertOptions = {}
): string {
  const nodeMap = buildNodeMap(nodes);

  // Find root node (typically the first node, which represents the document)
  // The root node's children are the top-level items
  const rootNode = nodes.find((n) => {
    // Root is the node not referenced as child by anyone
    const isChild = nodes.some((other) => (other.children || []).includes(n.id));
    return !isChild;
  });

  if (!rootNode) {
    return "";
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };
  let result = "";

  // Render children of root (not the root itself, which is usually empty)
  for (const childId of rootNode.children || []) {
    result += renderNode(nodeMap, childId, 0, opts);
  }

  return result;
}
