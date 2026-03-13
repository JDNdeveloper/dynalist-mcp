import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  standardSetup,
  type TestContext,
} from "./test-helpers";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(standardSetup);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ─── delete_nodes ─────────────────────────────────────────────────────

describe("delete_nodes", () => {
  // ─── Single-node subtree deletion ──────────────────────────────────

  test("deletes a leaf node", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1a"],
    });
    expect(result.file_id).toBe("doc1");
    expect(result.deleted_count).toBe(1);

    // Verify the node is gone.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
  });

  test("default behavior deletes entire subtree", async () => {
    // n1 has children n1a, n1b. Default (include_children: true) deletes all.
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1"],
    });
    expect(result.deleted_count).toBe(3); // n1, n1a, n1b

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeUndefined();
  });

  test("deleted_count includes all descendants in subtree deletion", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1"],
      include_children: true,
    });
    expect(result.deleted_count).toBe(3);
  });

  test("deeply nested subtree deletion removes all levels", async () => {
    ctx.server.addDocument("deep_doc", "Deep Document", "folder_a", [
      ctx.server.makeNode("root", "Deep Document", ["d1"]),
      ctx.server.makeNode("d1", "Level 1", ["d2"]),
      ctx.server.makeNode("d2", "Level 2", ["d3"]),
      ctx.server.makeNode("d3", "Level 3", ["d4"]),
      ctx.server.makeNode("d4", "Level 4", []),
    ]);

    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "deep_doc",
      node_ids: ["d1"],
    });
    expect(result.deleted_count).toBe(4);

    const doc = ctx.server.documents.get("deep_doc")!;
    expect(doc.nodes.find((n) => n.id === "d1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "d2")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "d3")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "d4")).toBeUndefined();

    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual([]);
  });

  test("deleting root's only child leaves root with empty children", async () => {
    // doc2 has root -> [m1]. Delete m1.
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc2",
      node_ids: ["m1"],
    });
    expect(result.deleted_count).toBe(1);

    const doc = ctx.server.documents.get("doc2")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual([]);
  });

  // ─── Bulk subtree deletion ─────────────────────────────────────────

  test("bulk: deletes multiple disjoint subtrees", async () => {
    // n1 has children [n1a, n1b], n2 has child [n2a]. Delete both subtrees.
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "n2"],
    });
    // n1 (3 nodes) + n2 (2 nodes) = 5.
    expect(result.deleted_count).toBe(5);

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n2")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n2a")).toBeUndefined();

    // n3 should survive.
    expect(doc.nodes.find((n) => n.id === "n3")).toBeDefined();
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["n3"]);
  });

  test("bulk: overlapping subtrees are deduplicated", async () => {
    // Delete n1 (subtree of 3) and n1a (descendant of n1). n1a is covered by n1.
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "n1a"],
    });
    // n1's subtree is 3 nodes. n1a is a subset, so total is still 3.
    expect(result.deleted_count).toBe(3);

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeUndefined();
  });

  test("bulk: overlapping subtrees with descendant listed first", async () => {
    // Order reversed: descendant before ancestor.
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1a", "n1"],
    });
    expect(result.deleted_count).toBe(3);
  });

  test("bulk: multi-level ancestor deduplication (grandparent dominates grandchild)", async () => {
    ctx.server.addDocument("dedup_deep", "Dedup Deep", "folder_a", [
      ctx.server.makeNode("root", "Dedup Deep", ["a"]),
      ctx.server.makeNode("a", "A", ["b"]),
      ctx.server.makeNode("b", "B", ["c"]),
      ctx.server.makeNode("c", "C", []),
    ]);

    // Delete "a" and "c". "c" is a grandchild of "a", so it should be
    // deduplicated. The ancestor walk must traverse multiple levels.
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "dedup_deep",
      node_ids: ["a", "c"],
    });
    expect(result.deleted_count).toBe(3); // a, b, c (c not double-counted)
  });

  test("bulk: deletes all children of same parent", async () => {
    // Delete n1, n2, n3 (all children of root).
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "n2", "n3"],
    });
    // n1 (3) + n2 (2) + n3 (1) = 6.
    expect(result.deleted_count).toBe(6);

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual([]);
  });

  test("bulk: deeply nested subtree alongside another node", async () => {
    ctx.server.addDocument("deep_bulk", "Deep Bulk", "folder_a", [
      ctx.server.makeNode("root", "Deep Bulk", ["a", "b"]),
      ctx.server.makeNode("a", "A", ["a1"]),
      ctx.server.makeNode("a1", "A1", ["a2"]),
      ctx.server.makeNode("a2", "A2", ["a3"]),
      ctx.server.makeNode("a3", "A3", []),
      ctx.server.makeNode("b", "B", []),
    ]);

    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "deep_bulk",
      node_ids: ["a", "b"],
    });
    // a (4 nodes) + b (1 node) = 5.
    expect(result.deleted_count).toBe(5);

    const doc = ctx.server.documents.get("deep_bulk")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual([]);
  });

  test("bulk: delete multiple leaf nodes", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1a", "n1b", "n2a"],
    });
    expect(result.deleted_count).toBe(3);

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n2a")).toBeUndefined();

    // Parents should still exist with empty children.
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children).toEqual([]);
    const n2 = doc.nodes.find((n) => n.id === "n2")!;
    expect(n2.children).toEqual([]);
  });

  test("bulk: promoted_children absent for subtree deletion", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "n2"],
    });
    expect(result.promoted_children).toBeUndefined();
  });

  // ─── State round-trip ──────────────────────────────────────────────

  test("state round-trip: bulk delete then read_document", async () => {
    await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "n3"],
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const tree = result.node as Record<string, unknown>;
    const children = tree.children as Record<string, unknown>[];

    // Only n2 and its subtree should remain.
    expect(children).toHaveLength(1);
    expect(children[0].node_id).toBe("n2");
  });

  // ─── Child promotion (single node only) ────────────────────────────

  test("include_children: false promotes children up to parent", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1"],
      include_children: false,
    });
    expect(result.deleted_count).toBe(1);

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeDefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeDefined();

    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toContain("n1a");
    expect(root.children).toContain("n1b");
  });

  test("promoted children appear at the deleted node's position in parent", async () => {
    // Root children are [n1, n2, n3]. Delete n1 which has children [n1a, n1b].
    await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1"],
      include_children: false,
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children![0]).toBe("n1a");
    expect(root.children![1]).toBe("n1b");
    expect(root.children).toContain("n2");
    expect(root.children).toContain("n3");
  });

  test("promoted children of 3+ preserve relative order", async () => {
    ctx.server.addDocument("promo_doc", "Promotion Order", "folder_a", [
      ctx.server.makeNode("root", "Promotion Order", ["before", "target", "after"]),
      ctx.server.makeNode("before", "Sibling Before", []),
      ctx.server.makeNode("target", "Target", ["a", "b", "c"]),
      ctx.server.makeNode("a", "Child A", []),
      ctx.server.makeNode("b", "Child B", []),
      ctx.server.makeNode("c", "Child C", []),
      ctx.server.makeNode("after", "Sibling After", []),
    ]);

    await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "promo_doc",
      node_ids: ["target"],
      include_children: false,
    });

    const doc = ctx.server.documents.get("promo_doc")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["before", "a", "b", "c", "after"]);
  });

  test("promoted children when target is first child", async () => {
    ctx.server.addDocument("promo_first", "Promotion First", "folder_a", [
      ctx.server.makeNode("root", "Promotion First", ["target", "sibling"]),
      ctx.server.makeNode("target", "Target", ["a", "b", "c"]),
      ctx.server.makeNode("a", "Child A", []),
      ctx.server.makeNode("b", "Child B", []),
      ctx.server.makeNode("c", "Child C", []),
      ctx.server.makeNode("sibling", "Sibling", []),
    ]);

    await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "promo_first",
      node_ids: ["target"],
      include_children: false,
    });

    const doc = ctx.server.documents.get("promo_first")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["a", "b", "c", "sibling"]);
  });

  test("promoted children when target is last child", async () => {
    ctx.server.addDocument("promo_last", "Promotion Last", "folder_a", [
      ctx.server.makeNode("root", "Promotion Last", ["sibling", "target"]),
      ctx.server.makeNode("sibling", "Sibling", []),
      ctx.server.makeNode("target", "Target", ["a", "b", "c"]),
      ctx.server.makeNode("a", "Child A", []),
      ctx.server.makeNode("b", "Child B", []),
      ctx.server.makeNode("c", "Child C", []),
    ]);

    await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "promo_last",
      node_ids: ["target"],
      include_children: false,
    });

    const doc = ctx.server.documents.get("promo_last")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["sibling", "a", "b", "c"]);
  });

  test("promoted children preserve their content", async () => {
    await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1"],
      include_children: false,
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n1a = doc.nodes.find((n) => n.id === "n1a")!;
    const n1b = doc.nodes.find((n) => n.id === "n1b")!;
    expect(n1a.content).toBe("Child A");
    expect(n1b.content).toBe("Child B");
    expect(n1b.note).toBe("A note on child B");
  });

  test("promoted_children count matches actual promoted count", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1"],
      include_children: false,
    });
    expect(result.promoted_children).toBe(2);
  });

  test("promoted_children is 0 for leaf with include_children: false", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1a"],
      include_children: false,
    });
    expect(result.deleted_count).toBe(1);
    expect(result.promoted_children).toBe(0);
  });

  test("promoted_children absent when include_children is true", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1"],
      include_children: true,
    });
    expect(result.promoted_children).toBeUndefined();
  });

  test("state round-trip: promote then read_document", async () => {
    await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1"],
      include_children: false,
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const tree = result.node as Record<string, unknown>;
    const children = tree.children as Record<string, unknown>[];

    // Root should have [n1a, n1b, n2, n3].
    expect(children).toHaveLength(4);
    expect(children[0].node_id).toBe("n1a");
    expect(children[1].node_id).toBe("n1b");
  });

  // ─── Validation and error cases ────────────────────────────────────

  test("cannot delete root node", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["root"],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("rejects deletion of root by actual root node ID (non-literal)", async () => {
    // The fast-path check catches the literal string "root". This test
    // exercises the findRootNodeId check inside the version guard by
    // using a document whose root node has a different ID.
    ctx.server.addDocument("custom_root_doc", "Custom Root", "folder_a", [
      ctx.server.makeNode("my_root", "Custom Root", ["cr1"]),
      ctx.server.makeNode("cr1", "Child", []),
    ]);

    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "custom_root_doc",
      node_ids: ["my_root"],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("root node mixed into bulk array fails entire batch", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "root"],
    });
    expect(err.error).toBe("InvalidInput");

    // Verify n1 was NOT deleted.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeDefined();
  });

  test("nonexistent file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "nonexistent",
      node_ids: ["n1"],
    });
    expect(err.error).toBe("NotFound");
  });

  test("nonexistent node_id returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["nonexistent"],
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent node_id with include_children returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["nonexistent"],
      include_children: true,
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent node_id mixed with valid ones fails entire batch", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "nonexistent"],
    });
    expect(err.error).toBe("NodeNotFound");

    // Verify n1 was NOT deleted (no partial application).
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeDefined();
  });

  test("empty node_ids array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: [],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("duplicate node_id in array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "n1"],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("include_children: false with multiple nodes returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1", "n2"],
      include_children: false,
    });
    expect(err.error).toBe("InvalidInput");

    // Verify no nodes or descendants were deleted.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeDefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeDefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeDefined();
    expect(doc.nodes.find((n) => n.id === "n2")).toBeDefined();
    expect(doc.nodes.find((n) => n.id === "n2a")).toBeDefined();
  });

  // ─── Response shape ────────────────────────────────────────────────

  test("response includes file_id and deleted_count", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n1a"],
    });
    expect(result.file_id).toBe("doc1");
    expect(typeof result.deleted_count).toBe("number");
  });

  test("response includes promoted_children when children were promoted", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      node_ids: ["n2"],
      include_children: false,
    });
    expect(result.file_id).toBe("doc1");
    expect(result.deleted_count).toBe(1);
    expect(result.promoted_children).toBe(1);
  });
});

// ─── move_nodes ──────────────────────────────────────────────────────

describe("move_nodes", () => {
  // ─── Single-move behavior (one-element array) ─────────────────────

  test("first_child: moves node as first child of reference", async () => {
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n2a", reference_node_id: "n1", position: "first_child" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![0]).toBe("n2a");
  });

  test("last_child: moves node as last child of reference", async () => {
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n2a", reference_node_id: "n1", position: "last_child" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![n1.children!.length - 1]).toBe("n2a");
  });

  test("after: moves node as sibling after reference", async () => {
    // Move n3 to be after n1 (under root).
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n3", reference_node_id: "n1", position: "after" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children!.indexOf("n1");
    expect(root.children![n1Index + 1]).toBe("n3");
  });

  test("before: moves node as sibling before reference", async () => {
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n3", reference_node_id: "n1", position: "before" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children!.indexOf("n1");
    expect(root.children![n1Index - 1]).toBe("n3");
  });

  // ─── State round-trip: move then read ─────────────────────────────

  test("state round-trip: move then verify via read_document", async () => {
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1a", reference_node_id: "n2", position: "last_child" }],
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const tree = result.node as Record<string, unknown>;
    const children = tree.children as Record<string, unknown>[];
    const n2 = children.find((c) => c.node_id === "n2")!;
    const n2Children = n2.children as Record<string, unknown>[];
    const movedNode = n2Children.find((c) => c.node_id === "n1a");
    expect(movedNode).toBeDefined();
    expect(movedNode!.content).toBe("Child A");
  });

  // ─── Position verification ────────────────────────────────────────

  test("first_child: moved node is at index 0 of reference's children", async () => {
    // n1 already has children [n1a, n1b]. Move n3 as first child of n1.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n3", reference_node_id: "n1", position: "first_child" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![0]).toBe("n3");
  });

  test("last_child: moved node is at last index of reference's children", async () => {
    // n1 already has children [n1a, n1b]. Move n3 as last child of n1.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n3", reference_node_id: "n1", position: "last_child" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![n1.children!.length - 1]).toBe("n3");
  });

  test("after: moved node is at index immediately after reference", async () => {
    // Root children are [n1, n2, n3]. Move n3 after n1.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n3", reference_node_id: "n1", position: "after" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Idx = root.children!.indexOf("n1");
    const n3Idx = root.children!.indexOf("n3");
    expect(n3Idx).toBe(n1Idx + 1);
  });

  test("before: moved node is at index immediately before reference", async () => {
    // Root children are [n1, n2, n3]. Move n3 before n2.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n3", reference_node_id: "n2", position: "before" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n2Idx = root.children!.indexOf("n2");
    const n3Idx = root.children!.indexOf("n3");
    expect(n3Idx).toBe(n2Idx - 1);
  });

  test("move with children: entire subtree moves together", async () => {
    // Move n1 (which has children n1a, n1b) as last child of n2.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n2", position: "last_child" }],
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;

    // n1 should still have its children.
    expect(n1.children).toContain("n1a");
    expect(n1.children).toContain("n1b");

    // n1 should now be a child of n2.
    const n2 = doc.nodes.find((n) => n.id === "n2")!;
    expect(n2.children).toContain("n1");

    // n1 should no longer be a child of root.
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).not.toContain("n1");
  });

  // ─── Circular move prevention ─────────────────────────────────────

  test("cannot move node to be child of its own grandchild", async () => {
    // n1 -> [n1a, n1b]. Moving n1 into n1a's subtree should fail.
    // First add a child to n1a so we can try to move n1 into it.
    ctx.server.documents.get("doc1")!.nodes.push(
      ctx.server.makeNode("n1a1", "Grandchild", []),
    );
    const n1a = ctx.server.documents.get("doc1")!.nodes.find((n) => n.id === "n1a")!;
    n1a.children!.push("n1a1");

    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n1a1", position: "first_child" }],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node to be child of its own direct child", async () => {
    // n1 -> [n1a, n1b]. Moving n1 into n1a should fail.
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n1a", position: "first_child" }],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node 'after' one of its own descendants", async () => {
    // n1 -> [n1a, n1b]. Moving n1 to after n1a would resolve n1a's parent
    // (which is n1 itself), creating a circular move.
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n1a", position: "after" }],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node 'before' one of its own descendants", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n1b", position: "before" }],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("self-reference with after position is rejected", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n1", position: "after" }],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("self-reference with before position is rejected", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n1", position: "before" }],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("self-reference with first_child position is rejected", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n1", position: "first_child" }],
    });
    expect(err.error).toBe("InvalidInput");
  });

  // ─── Sibling reordering ───────────────────────────────────────────

  test("reorder sibling: move node before its own sibling", async () => {
    // Root children are [n1, n2, n3]. Move n3 before n1.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n3", reference_node_id: "n1", position: "before" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;

    // n3 should now come before n1.
    const n3Idx = root.children!.indexOf("n3");
    const n1Idx = root.children!.indexOf("n1");
    expect(n3Idx).toBeLessThan(n1Idx);
  });

  test("move earlier sibling before later sibling: exact position", async () => {
    // Root children are [n1, n2, n3]. Move n1 before n3.
    // Expected result: [n2, n1, n3].
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n3", position: "before" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["n2", "n1", "n3"]);
  });

  test("reorder sibling: move node after its own sibling", async () => {
    // Root children are [n1, n2, n3]. Move n1 after n3.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "n3", position: "after" }],
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;

    // n1 should now come after n3.
    const n1Idx = root.children!.indexOf("n1");
    const n3Idx = root.children!.indexOf("n3");
    expect(n1Idx).toBeGreaterThan(n3Idx);
  });

  // ─── Response shape ───────────────────────────────────────────────

  test("response includes file_id, moved_count, and node_ids", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n3", reference_node_id: "n1", position: "first_child" }],
    });
    expect(result.file_id).toBe("doc1");
    expect(result.moved_count).toBe(1);
    expect(result.node_ids).toEqual(["n3"]);
  });

  test("response shape for multi-move", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n1a", reference_node_id: "n3", position: "last_child" },
        { node_id: "n1b", reference_node_id: "n3", position: "last_child" },
      ],
    });
    expect(result.file_id).toBe("doc1");
    expect(result.moved_count).toBe(2);
    expect(result.node_ids).toEqual(["n1a", "n1b"]);
  });

  // ─── Nonexistent node validation ──────────────────────────────────

  test("nonexistent node_id returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "nonexistent", reference_node_id: "n1", position: "after" }],
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent reference_node_id with first_child returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "nonexistent", position: "first_child" }],
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent reference_node_id with after returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [{ node_id: "n1", reference_node_id: "nonexistent", position: "after" }],
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "nonexistent",
      moves: [{ node_id: "n1", reference_node_id: "n2", position: "after" }],
    });
    expect(err.error).toBe("NotFound");
  });

  // ─── Empty moves array ────────────────────────────────────────────

  test("empty moves array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [],
    });
    expect(err.error).toBe("InvalidInput");
  });

  // ─── Bulk move behavior ───────────────────────────────────────────

  test("bulk: move two nodes to be children of a different parent", async () => {
    // Root children are [n1, n2, n3]. Move n1a and n1b as last_child of n3.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n1a", reference_node_id: "n3", position: "last_child" },
        { node_id: "n1b", reference_node_id: "n3", position: "last_child" },
      ],
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n3 = doc.nodes.find((n) => n.id === "n3")!;

    // Order must be preserved: n1a first (appended first), n1b second.
    expect(n3.children).toEqual(["n1a", "n1b"]);

    // n1 should have no children left.
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children).toEqual([]);
  });

  test("bulk: multiple last_child moves to same parent preserve input order", async () => {
    // Regression: the API resolves index -1 against a snapshot, so multiple
    // last_child moves to the same parent using -1 would reverse. The fix is
    // to resolve last_child to explicit indices.
    ctx.server.addDocument("lc_doc", "Last Child Order", "folder_a", [
      ctx.server.makeNode("root", "Last Child Order", ["target", "a", "b", "c"]),
      ctx.server.makeNode("target", "Target", []),
      ctx.server.makeNode("a", "A", []),
      ctx.server.makeNode("b", "B", []),
      ctx.server.makeNode("c", "C", []),
    ]);

    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "lc_doc",
      moves: [
        { node_id: "a", reference_node_id: "target", position: "last_child" },
        { node_id: "b", reference_node_id: "target", position: "last_child" },
        { node_id: "c", reference_node_id: "target", position: "last_child" },
      ],
    });

    const doc = ctx.server.documents.get("lc_doc")!;
    const target = doc.nodes.find((n) => n.id === "target")!;
    expect(target.children).toEqual(["a", "b", "c"]);
  });

  test("bulk: interdependent positions (move A after X, then move B after A)", async () => {
    // Root children are [n1, n2, n3].
    // Move n2 after n1, then move n3 after n2. Final order: [n1, n2, n3].
    // But first rearrange so we can see the interdependency.
    //
    // Setup: root -> [a, b, c, d]
    ctx.server.addDocument("dep_doc", "Dep Doc", "folder_a", [
      ctx.server.makeNode("root", "Dep Doc", ["a", "b", "c", "d"]),
      ctx.server.makeNode("a", "A", []),
      ctx.server.makeNode("b", "B", []),
      ctx.server.makeNode("c", "C", []),
      ctx.server.makeNode("d", "D", []),
    ]);

    // Move c after a, then move d after c. Result should be [a, c, d, b].
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "dep_doc",
      moves: [
        { node_id: "c", reference_node_id: "a", position: "after" },
        { node_id: "d", reference_node_id: "c", position: "after" },
      ],
    });

    const doc = ctx.server.documents.get("dep_doc")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["a", "c", "d", "b"]);
  });

  test("bulk: reverse a list of 3 siblings", async () => {
    // Root children are [n1, n2, n3]. Reverse to [n3, n2, n1].
    // Strategy: move n3 before n1, then move n2 after n3.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n3", reference_node_id: "n1", position: "before" },
        { node_id: "n2", reference_node_id: "n3", position: "after" },
      ],
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["n3", "n2", "n1"]);
  });

  test("bulk: cross-parent moves (from different parents to the same target)", async () => {
    // n1 -> [n1a, n1b], n2 -> [n2a]. Move n1a and n2a as children of n3.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n1a", reference_node_id: "n3", position: "last_child" },
        { node_id: "n2a", reference_node_id: "n3", position: "last_child" },
      ],
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n3 = doc.nodes.find((n) => n.id === "n3")!;
    expect(n3.children).toEqual(["n1a", "n2a"]);

    // Original parents should have lost their children.
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children).toEqual(["n1b"]);
    const n2 = doc.nodes.find((n) => n.id === "n2")!;
    expect(n2.children).toEqual([]);
  });

  test("bulk: move same node twice (processed sequentially)", async () => {
    // Move n3 to first_child of n1, then move it to last_child of n2.
    // The second move should win since moves are applied sequentially.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n3", reference_node_id: "n1", position: "first_child" },
        { node_id: "n3", reference_node_id: "n2", position: "last_child" },
      ],
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children).not.toContain("n3");
    const n2 = doc.nodes.find((n) => n.id === "n2")!;
    expect(n2.children).toContain("n3");
  });

  test("bulk: circular move created by earlier move in batch", async () => {
    // Move n1a under n2, then move n2 under n1a. The second move should
    // fail because n1a is now an ancestor of n2's subtree via the first move.
    //
    // NOTE: After the first move, n1a is a child of n2, so moving n2
    // into n1a would be circular.
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n1a", reference_node_id: "n2", position: "last_child" },
        { node_id: "n2", reference_node_id: "n1a", position: "first_child" },
      ],
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("bulk: moving to/from root level", async () => {
    // Move n1a (child of n1) to root level after n3, then move n3 under n1.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n1a", reference_node_id: "n3", position: "after" },
        { node_id: "n3", reference_node_id: "n1", position: "first_child" },
      ],
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toContain("n1a");
    expect(root.children).not.toContain("n3");

    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![0]).toBe("n3");
  });

  test("bulk: state round-trip for multi-move via read_document", async () => {
    // Move n1a and n1b as children of n3, then verify via read_document.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n1a", reference_node_id: "n3", position: "first_child" },
        { node_id: "n1b", reference_node_id: "n3", position: "last_child" },
      ],
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const tree = result.node as Record<string, unknown>;
    const children = tree.children as Record<string, unknown>[];
    const n3 = children.find((c) => c.node_id === "n3")!;
    const n3Children = n3.children as Record<string, unknown>[];
    expect(n3Children).toHaveLength(2);
    expect(n3Children[0].node_id).toBe("n1a");
    expect(n3Children[1].node_id).toBe("n1b");
  });

  test("bulk: reverse 4 siblings with sequential moves", async () => {
    // Setup: root -> [a, b, c, d].
    ctx.server.addDocument("rev_doc", "Reverse Doc", "folder_a", [
      ctx.server.makeNode("root", "Reverse Doc", ["a", "b", "c", "d"]),
      ctx.server.makeNode("a", "A", []),
      ctx.server.makeNode("b", "B", []),
      ctx.server.makeNode("c", "C", []),
      ctx.server.makeNode("d", "D", []),
    ]);

    // Reverse [a, b, c, d] to [d, c, b, a].
    // Move d before a, move c after d, move b after c.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "rev_doc",
      moves: [
        { node_id: "d", reference_node_id: "a", position: "before" },
        { node_id: "c", reference_node_id: "d", position: "after" },
        { node_id: "b", reference_node_id: "c", position: "after" },
      ],
    });

    const doc = ctx.server.documents.get("rev_doc")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["d", "c", "b", "a"]);
  });

  test("bulk: move nodes from nested positions to flat list", async () => {
    // n1 -> [n1a, n1b], n2 -> [n2a].
    // Flatten: move n1a, n1b, n2a all to root level after n3.
    await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      moves: [
        { node_id: "n1a", reference_node_id: "n3", position: "after" },
        { node_id: "n1b", reference_node_id: "n1a", position: "after" },
        { node_id: "n2a", reference_node_id: "n1b", position: "after" },
      ],
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["n1", "n2", "n3", "n1a", "n1b", "n2a"]);
  });
});
