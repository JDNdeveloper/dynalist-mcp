/**
 * Parse indented bullet text into a tree structure
 * Supports both markdown bullets ("- text") and plain indented text
 */

export interface ParsedNode {
  content: string;
  children: ParsedNode[];
}

interface FlatNode {
  content: string;
  level: number;
}

/**
 * Parse markdown/indented text into a tree of nodes
 */
export function parseMarkdownBullets(text: string): ParsedNode[] {
  const lines = text.split("\n");
  const flatNodes: FlatNode[] = [];

  // Detect indent unit (smallest non-zero indent)
  let indentUnit = 4; // default
  for (const line of lines) {
    if (!line.trim()) continue;
    const leadingSpaces = getLeadingSpaces(line);
    if (leadingSpaces > 0 && leadingSpaces < indentUnit) {
      indentUnit = leadingSpaces;
    }
  }

  // Parse each line into flat nodes with levels
  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;

    const leadingSpaces = getLeadingSpaces(line);
    const level = Math.floor(leadingSpaces / indentUnit);

    // Extract content - remove leading whitespace and bullet marker
    let content = line.trim();

    // Remove bullet markers: "- ", "* ", "• ", numbered "1. ", "1) "
    content = content
      .replace(/^[-*•]\s+/, "")      // - text, * text, • text
      .replace(/^\d+[.)]\s+/, "")    // 1. text, 1) text
      .replace(/^>\s*/, "");         // > quote (treat as regular text)

    if (content) {
      flatNodes.push({ content, level });
    }
  }

  // Convert flat nodes to tree
  return buildTree(flatNodes);
}

/**
 * Count leading spaces (tabs converted to 4 spaces)
 */
function getLeadingSpaces(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === " ") {
      count++;
    } else if (char === "\t") {
      count += 4; // treat tab as 4 spaces
    } else {
      break;
    }
  }
  return count;
}

/**
 * Convert flat nodes with levels into a tree structure
 */
function buildTree(flatNodes: FlatNode[]): ParsedNode[] {
  if (flatNodes.length === 0) return [];

  const roots: ParsedNode[] = [];
  const stack: { node: ParsedNode; level: number }[] = [];

  for (const flat of flatNodes) {
    const node: ParsedNode = {
      content: flat.content,
      children: [],
    };

    // Find parent - go up the stack until we find a node with lower level
    while (stack.length > 0 && stack[stack.length - 1].level >= flat.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      // No parent - this is a root node
      roots.push(node);
    } else {
      // Add as child of the top of stack
      stack[stack.length - 1].node.children.push(node);
    }

    // Push current node to stack
    stack.push({ node, level: flat.level });
  }

  return roots;
}

/**
 * Flatten a tree back into an array for insertion (DFS order)
 * Returns nodes with their parent index (-1 for roots)
 */
export interface FlattenedNode {
  content: string;
  parentIndex: number; // -1 for roots, otherwise index in result array
}

export function flattenTree(roots: ParsedNode[]): FlattenedNode[] {
  const result: FlattenedNode[] = [];

  function traverse(node: ParsedNode, parentIndex: number) {
    const currentIndex = result.length;
    result.push({ content: node.content, parentIndex });

    for (const child of node.children) {
      traverse(child, currentIndex);
    }
  }

  for (const root of roots) {
    traverse(root, -1);
  }

  return result;
}

/**
 * Group nodes by level for batch insertion
 * Returns array of levels, each level contains nodes with their parent's index in previous level
 */
export interface LevelNode {
  content: string;
  localIndex: number;      // Index within this level
  parentLevelIndex: number; // Index of parent in previous level (-1 for roots)
}

export function groupByLevel(roots: ParsedNode[]): LevelNode[][] {
  const levels: LevelNode[][] = [];

  // Level 0: all roots
  const level0: LevelNode[] = roots.map((root, idx) => ({
    content: root.content,
    localIndex: idx,
    parentLevelIndex: -1,
  }));
  levels.push(level0);

  // Build subsequent levels
  let currentParents = roots;
  while (true) {
    const nextLevel: LevelNode[] = [];
    let localIdx = 0;

    for (let parentIdx = 0; parentIdx < currentParents.length; parentIdx++) {
      const parent = currentParents[parentIdx];
      for (const child of parent.children) {
        nextLevel.push({
          content: child.content,
          localIndex: localIdx++,
          parentLevelIndex: parentIdx,
        });
      }
    }

    if (nextLevel.length === 0) break;

    levels.push(nextLevel);

    // Collect all children as next parents
    currentParents = [];
    for (const parent of currentParents.length > 0 ? currentParents : roots) {
      // We need to collect children in order
    }
    // Actually rebuild from roots traversing to this depth
    currentParents = getNodesAtDepth(roots, levels.length - 1);
  }

  return levels;
}

/**
 * Get all nodes at a specific depth
 */
function getNodesAtDepth(roots: ParsedNode[], depth: number): ParsedNode[] {
  if (depth === 0) return roots;

  const result: ParsedNode[] = [];
  for (const root of roots) {
    collectAtDepth(root, 0, depth, result);
  }
  return result;
}

function collectAtDepth(node: ParsedNode, currentDepth: number, targetDepth: number, result: ParsedNode[]) {
  if (currentDepth === targetDepth) {
    result.push(node);
    return;
  }
  for (const child of node.children) {
    collectAtDepth(child, currentDepth + 1, targetDepth, result);
  }
}
