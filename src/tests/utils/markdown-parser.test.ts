import { describe, test, expect } from "bun:test";
import {
  parseMarkdownBullets,
  flattenTree,
  groupByLevel,
} from "../../utils/markdown-parser";

// ─── parseMarkdownBullets ────────────────────────────────────────────

describe("parseMarkdownBullets", () => {
  test("single line", () => {
    const result = parseMarkdownBullets("hello");
    expect(result).toEqual([{ content: "hello", children: [] }]);
  });

  test("single line with dash bullet", () => {
    const result = parseMarkdownBullets("- hello");
    expect(result).toEqual([{ content: "hello", children: [] }]);
  });

  test("multi-line flat list", () => {
    const result = parseMarkdownBullets("- one\n- two\n- three");
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("one");
    expect(result[1].content).toBe("two");
    expect(result[2].content).toBe("three");
    for (const node of result) {
      expect(node.children).toEqual([]);
    }
  });

  test("nested 2 levels", () => {
    const result = parseMarkdownBullets("- parent\n    - child");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("parent");
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].content).toBe("child");
  });

  test("nested 3+ levels", () => {
    const input = "- a\n    - b\n        - c\n            - d";
    const result = parseMarkdownBullets(input);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("a");
    expect(result[0].children[0].content).toBe("b");
    expect(result[0].children[0].children[0].content).toBe("c");
    expect(result[0].children[0].children[0].children[0].content).toBe("d");
  });

  test("mixed bullet styles: dash, asterisk, numbered", () => {
    const input = "- dash\n* asterisk\n1. numbered\n2) also numbered";
    const result = parseMarkdownBullets(input);
    expect(result).toHaveLength(4);
    expect(result[0].content).toBe("dash");
    expect(result[1].content).toBe("asterisk");
    expect(result[2].content).toBe("numbered");
    expect(result[3].content).toBe("also numbered");
  });

  test("tabs converted to 4 spaces", () => {
    const input = "- parent\n\t- child";
    const result = parseMarkdownBullets(input);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].content).toBe("child");
  });

  test("empty lines are skipped", () => {
    const input = "- one\n\n- two\n\n- three";
    const result = parseMarkdownBullets(input);
    expect(result).toHaveLength(3);
  });

  test("blockquote stripping", () => {
    const result = parseMarkdownBullets("> quoted text");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("quoted text");
  });

  test("bullet marker (dot/circle)", () => {
    const result = parseMarkdownBullets("• bullet");
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("bullet");
  });

  test("empty input returns empty array", () => {
    expect(parseMarkdownBullets("")).toEqual([]);
    expect(parseMarkdownBullets("   \n   \n")).toEqual([]);
  });

  test("2-space indent unit detection", () => {
    const input = "- parent\n  - child\n    - grandchild";
    const result = parseMarkdownBullets(input);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0].children).toHaveLength(1);
  });

  test("multiple roots with children", () => {
    const input = "- root1\n    - child1\n- root2\n    - child2";
    const result = parseMarkdownBullets(input);
    expect(result).toHaveLength(2);
    expect(result[0].children[0].content).toBe("child1");
    expect(result[1].children[0].content).toBe("child2");
  });
});

// ─── groupByLevel ────────────────────────────────────────────────────

describe("groupByLevel", () => {
  test("flat list produces single level", () => {
    const roots = parseMarkdownBullets("- a\n- b\n- c");
    const levels = groupByLevel(roots);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toHaveLength(3);
    for (const node of levels[0]) {
      expect(node.parentLevelIndex).toBe(-1);
    }
  });

  test("2-level tree", () => {
    const roots = parseMarkdownBullets("- parent\n    - child1\n    - child2");
    const levels = groupByLevel(roots);
    expect(levels).toHaveLength(2);
    expect(levels[0]).toHaveLength(1);
    expect(levels[1]).toHaveLength(2);
    expect(levels[1][0].parentLevelIndex).toBe(0);
    expect(levels[1][1].parentLevelIndex).toBe(0);
  });

  test("3-level tree with correct parent indices", () => {
    const input = "- a\n    - b\n        - c\n    - d\n        - e";
    const roots = parseMarkdownBullets(input);
    const levels = groupByLevel(roots);
    expect(levels).toHaveLength(3);

    // Level 0: [a]
    expect(levels[0]).toHaveLength(1);

    // Level 1: [b, d] both children of a (index 0).
    expect(levels[1]).toHaveLength(2);
    expect(levels[1][0].content).toBe("b");
    expect(levels[1][0].parentLevelIndex).toBe(0);
    expect(levels[1][1].content).toBe("d");
    expect(levels[1][1].parentLevelIndex).toBe(0);

    // Level 2: [c, e] children of b (index 0) and d (index 1).
    expect(levels[2]).toHaveLength(2);
    expect(levels[2][0].content).toBe("c");
    expect(levels[2][0].parentLevelIndex).toBe(0);
    expect(levels[2][1].content).toBe("e");
    expect(levels[2][1].parentLevelIndex).toBe(1);
  });

  test("empty input returns single empty level", () => {
    // Level 0 is always emitted, even when there are no roots.
    const levels = groupByLevel([]);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toEqual([]);
  });
});

// ─── flattenTree ─────────────────────────────────────────────────────

describe("flattenTree", () => {
  test("round-trip preserves structure", () => {
    const input = "- a\n    - b\n        - c\n    - d";
    const roots = parseMarkdownBullets(input);
    const flat = flattenTree(roots);
    expect(flat).toHaveLength(4);

    // a is root (parentIndex -1).
    expect(flat[0]).toEqual({ content: "a", parentIndex: -1 });
    // b is child of a (index 0).
    expect(flat[1]).toEqual({ content: "b", parentIndex: 0 });
    // c is child of b (index 1).
    expect(flat[2]).toEqual({ content: "c", parentIndex: 1 });
    // d is child of a (index 0).
    expect(flat[3]).toEqual({ content: "d", parentIndex: 0 });
  });

  test("flat list all have parentIndex -1", () => {
    const roots = parseMarkdownBullets("- x\n- y\n- z");
    const flat = flattenTree(roots);
    expect(flat).toHaveLength(3);
    for (const node of flat) {
      expect(node.parentIndex).toBe(-1);
    }
  });

  test("empty input", () => {
    expect(flattenTree([])).toEqual([]);
  });
});
