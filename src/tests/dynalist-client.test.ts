import { describe, test, expect } from "bun:test";
import {
  buildNodeMap,
  buildParentMap,
  findRootNodeId,
  type DynalistNode,
} from "../dynalist-client";

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

// ─── buildNodeMap ────────────────────────────────────────────────────

describe("buildNodeMap", () => {
  test("constructs map from nodes", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const map = buildNodeMap(nodes);
    expect(map.size).toBe(3);
    expect(map.get("a")?.id).toBe("a");
    expect(map.get("b")?.id).toBe("b");
    expect(map.get("c")?.id).toBe("c");
  });

  test("empty input", () => {
    expect(buildNodeMap([]).size).toBe(0);
  });

  test("preserves node data", () => {
    const node = makeNode("x", ["y"], "hello");
    node.note = "a note";
    const map = buildNodeMap([node]);
    const result = map.get("x")!;
    expect(result.content).toBe("hello");
    expect(result.note).toBe("a note");
    expect(result.children).toEqual(["y"]);
  });
});

// ─── buildParentMap ──────────────────────────────────────────────────

describe("buildParentMap", () => {
  test("maps children to parent with index", () => {
    const nodes = [
      makeNode("root", ["a", "b"]),
      makeNode("a", ["c"]),
      makeNode("b"),
      makeNode("c"),
    ];
    const map = buildParentMap(nodes);
    expect(map.get("a")).toEqual({ parentId: "root", index: 0 });
    expect(map.get("b")).toEqual({ parentId: "root", index: 1 });
    expect(map.get("c")).toEqual({ parentId: "a", index: 0 });
  });

  test("root has no parent entry", () => {
    const nodes = [makeNode("root", ["a"]), makeNode("a")];
    const map = buildParentMap(nodes);
    expect(map.has("root")).toBe(false);
  });

  test("empty input", () => {
    expect(buildParentMap([]).size).toBe(0);
  });
});

// ─── findRootNodeId ──────────────────────────────────────────────────

describe("findRootNodeId", () => {
  test("standard case: root is not a child of any node", () => {
    const nodes = [
      makeNode("root", ["a", "b"]),
      makeNode("a"),
      makeNode("b"),
    ];
    expect(findRootNodeId(nodes)).toBe("root");
  });

  test("single node", () => {
    expect(findRootNodeId([makeNode("only")])).toBe("only");
  });

  test("fallback to first node when all are children", () => {
    // Pathological case: circular or broken tree.
    const nodes = [
      makeNode("a", ["b"]),
      makeNode("b", ["a"]),
    ];
    // "a" is a child of "b" and "b" is a child of "a".
    // Neither is free of references, so fallback to first.
    expect(findRootNodeId(nodes)).toBe(nodes[0].id);
  });

  test("root not at index 0", () => {
    const nodes = [
      makeNode("child1"),
      makeNode("child2"),
      makeNode("root", ["child1", "child2"]),
    ];
    expect(findRootNodeId(nodes)).toBe("root");
  });
});
