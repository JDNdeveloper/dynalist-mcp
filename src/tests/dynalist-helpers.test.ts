import { describe, test, expect } from "bun:test";
import { groupByLevel, buildNodeTree, type ParsedNode } from "../utils/dynalist-helpers";
import type { DynalistNode } from "../dynalist-client";

// ─── groupByLevel ─────────────────────────────────────────────────────

describe("groupByLevel", () => {
  test("single node with no children produces one level", () => {
    const roots: ParsedNode[] = [
      { content: "Solo", children: [] },
    ];
    const levels = groupByLevel(roots);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(1);
    expect(levels[0][0].content).toBe("Solo");
    expect(levels[0][0].parentLevelIndex).toBe(-1);
    expect(levels[0][0].localIndex).toBe(0);
  });

  test("flat list of roots produces one level with correct indices", () => {
    const roots: ParsedNode[] = [
      { content: "A", children: [] },
      { content: "B", children: [] },
      { content: "C", children: [] },
    ];
    const levels = groupByLevel(roots);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(3);
    expect(levels[0][0].content).toBe("A");
    expect(levels[0][1].content).toBe("B");
    expect(levels[0][2].content).toBe("C");
    // All roots have parentLevelIndex of -1.
    for (const node of levels[0]) {
      expect(node.parentLevelIndex).toBe(-1);
    }
  });

  test("nested tree groups nodes by depth", () => {
    const roots: ParsedNode[] = [
      {
        content: "Parent",
        children: [
          {
            content: "Child 1",
            children: [
              { content: "Grandchild", children: [] },
            ],
          },
          { content: "Child 2", children: [] },
        ],
      },
    ];
    const levels = groupByLevel(roots);

    // Three levels: root, children, grandchildren.
    expect(levels).toHaveLength(3);

    // Level 0: one root.
    expect(levels[0]).toHaveLength(1);
    expect(levels[0][0].content).toBe("Parent");

    // Level 1: two children, both referencing parent at index 0.
    expect(levels[1]).toHaveLength(2);
    expect(levels[1][0].content).toBe("Child 1");
    expect(levels[1][0].parentLevelIndex).toBe(0);
    expect(levels[1][1].content).toBe("Child 2");
    expect(levels[1][1].parentLevelIndex).toBe(0);

    // Level 2: one grandchild, referencing Child 1 at index 0.
    expect(levels[2]).toHaveLength(1);
    expect(levels[2][0].content).toBe("Grandchild");
    expect(levels[2][0].parentLevelIndex).toBe(0);
  });

  test("multiple roots with children track parent indices correctly", () => {
    const roots: ParsedNode[] = [
      {
        content: "Root A",
        children: [{ content: "A-child", children: [] }],
      },
      {
        content: "Root B",
        children: [{ content: "B-child", children: [] }],
      },
    ];
    const levels = groupByLevel(roots);

    expect(levels).toHaveLength(2);
    expect(levels[1]).toHaveLength(2);

    // A-child references Root A (index 0 in level 0).
    expect(levels[1][0].content).toBe("A-child");
    expect(levels[1][0].parentLevelIndex).toBe(0);

    // B-child references Root B (index 1 in level 0).
    expect(levels[1][1].content).toBe("B-child");
    expect(levels[1][1].parentLevelIndex).toBe(1);
  });

  test("optional fields are preserved on level nodes", () => {
    const roots: ParsedNode[] = [
      {
        content: "Styled node",
        note: "A note",
        checkbox: true,
        checked: false,
        heading: 2,
        color: 3,
        children: [],
      },
    ];
    const levels = groupByLevel(roots);
    const node = levels[0][0];
    expect(node.note).toBe("A note");
    expect(node.checkbox).toBe(true);
    expect(node.checked).toBe(false);
    expect(node.heading).toBe(2);
    expect(node.color).toBe(3);
  });

  test("empty roots array produces one empty level", () => {
    const levels = groupByLevel([]);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(0);
  });
});

// ─── buildNodeTree ────────────────────────────────────────────────────

function makeNode(id: string, children: string[] = [], content = ""): DynalistNode {
  return {
    id,
    content,
    note: "",
    created: 0,
    modified: 0,
    children,
    collapsed: false,
  };
}

const defaultOptions = {
  maxDepth: null,
  includeCollapsedChildren: true,
  includeNotes: true,
  includeChecked: true,
};

describe("buildNodeTree", () => {
  test("handles cyclic node data without infinite loop", () => {
    // Node A references B, B references A.
    const nodes = [
      makeNode("a", ["b"], "Node A"),
      makeNode("b", ["a"], "Node B"),
    ];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const tree = buildNodeTree(nodeMap, "a", defaultOptions);
    expect(tree).not.toBeNull();
    expect(tree!.node_id).toBe("a");

    // B should appear as child of A, but A should not appear again under B.
    expect(tree!.children).toHaveLength(1);
    expect(tree!.children[0].node_id).toBe("b");
    expect(tree!.children[0].children).toHaveLength(0);
  });

  test("handles self-referencing node without infinite loop", () => {
    const nodes = [makeNode("a", ["a"], "Self ref")];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    const tree = buildNodeTree(nodeMap, "a", defaultOptions);
    expect(tree).not.toBeNull();
    expect(tree!.node_id).toBe("a");
    // The self-reference should be skipped by the visited guard.
    expect(tree!.children).toHaveLength(0);
  });
});
