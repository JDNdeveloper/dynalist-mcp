import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  getSyncToken,
  standardSetup,
  type TestContext,
} from "./test-helpers";
import { makeSyncToken } from "../../sync-token";

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext(standardSetup);
});

afterEach(async () => {
  await ctx.cleanup();
});

// ─── delete_items ─────────────────────────────────────────────────────

describe("delete_items", () => {
  // ─── Single-node subtree deletion ──────────────────────────────────

  test("deletes a leaf node", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a"],
      expected_sync_token: syncToken,
    });
    expect(result.file_id).toBe("doc1");
    expect(result.deleted_count).toBe(1);
    expect(result.deleted_ids).toEqual(["n1a"]);

    // Verify the node is gone.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
  });

  test("default behavior deletes entire subtree", async () => {
    // n1 has children n1a, n1b. Default (children: "delete") deletes all.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      expected_sync_token: syncToken,
    });
    // n1, n1a, n1b.
    expect(result.deleted_count).toBe(3);
    expect(new Set(result.deleted_ids as string[])).toEqual(new Set(["n1", "n1a", "n1b"]));

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeUndefined();
  });

  test("deleted_count includes all descendants in subtree deletion", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      expected_sync_token: syncToken,
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

    const syncToken = await getSyncToken(ctx.mcpClient, "deep_doc");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "deep_doc",
      item_ids: ["d1"],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc2");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc2",
      item_ids: ["m1"],
      expected_sync_token: syncToken,
    });
    expect(result.deleted_count).toBe(1);

    const doc = ctx.server.documents.get("doc2")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual([]);
  });

  // ─── Bulk subtree deletion ─────────────────────────────────────────

  test("bulk: deletes multiple disjoint subtrees", async () => {
    // n1 has children [n1a, n1b], n2 has child [n2a]. Delete both subtrees.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "n2"],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "n1a"],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a", "n1"],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "dedup_deep");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "dedup_deep",
      item_ids: ["a", "c"],
      expected_sync_token: syncToken,
    });
    // a, b, c (c not double-counted).
    expect(result.deleted_count).toBe(3);
  });

  test("bulk: deletes all children of same parent", async () => {
    // Delete n1, n2, n3 (all children of root).
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "n2", "n3"],
      expected_sync_token: syncToken,
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

    const syncToken = await getSyncToken(ctx.mcpClient, "deep_bulk");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "deep_bulk",
      item_ids: ["a", "b"],
      expected_sync_token: syncToken,
    });
    // a (4 nodes) + b (1 node) = 5.
    expect(result.deleted_count).toBe(5);

    const doc = ctx.server.documents.get("deep_bulk")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual([]);
  });

  test("bulk: delete multiple leaf nodes", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a", "n1b", "n2a"],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "n2"],
      expected_sync_token: syncToken,
    });
    expect(result.promoted_children).toBeUndefined();
  });

  // ─── State round-trip ──────────────────────────────────────────────

  test("state round-trip: bulk delete then read_document", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "n3"],
      expected_sync_token: syncToken,
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const tree = result.item as Record<string, unknown>;
    const children = tree.children as Record<string, unknown>[];

    // Only n2 and its subtree should remain.
    expect(children).toHaveLength(1);
    expect(children[0].item_id).toBe("n2");
  });

  // ─── Child promotion (single node only) ────────────────────────────

  test("children: promote re-parents children up to parent", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "promote",
      expected_sync_token: syncToken,
    });
    expect(result.deleted_count).toBe(1);
    expect(result.deleted_ids).toEqual(["n1"]);

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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "promote",
      expected_sync_token: syncToken,
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

    const syncToken = await getSyncToken(ctx.mcpClient, "promo_doc");
    await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "promo_doc",
      item_ids: ["target"],
      children: "promote",
      expected_sync_token: syncToken,
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

    const syncToken = await getSyncToken(ctx.mcpClient, "promo_first");
    await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "promo_first",
      item_ids: ["target"],
      children: "promote",
      expected_sync_token: syncToken,
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

    const syncToken = await getSyncToken(ctx.mcpClient, "promo_last");
    await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "promo_last",
      item_ids: ["target"],
      children: "promote",
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("promo_last")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["sibling", "a", "b", "c"]);
  });

  test("promoted children preserve their content", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "promote",
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n1a = doc.nodes.find((n) => n.id === "n1a")!;
    const n1b = doc.nodes.find((n) => n.id === "n1b")!;
    expect(n1a.content).toBe("Child A");
    expect(n1b.content).toBe("Child B");
    expect(n1b.note).toBe("A note on child B");
  });

  test("promoted_children count matches actual promoted count", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "promote",
      expected_sync_token: syncToken,
    });
    expect(result.promoted_children).toBe(2);
  });

  test("promoted_children is 0 for leaf with children promote", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a"],
      children: "promote",
      expected_sync_token: syncToken,
    });
    expect(result.deleted_count).toBe(1);
    expect(result.promoted_children).toBe(0);
  });

  test("promoted_children absent when children is 'delete'", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "delete",
      expected_sync_token: syncToken,
    });
    expect(result.promoted_children).toBeUndefined();
  });

  test("state round-trip: promote then read_document", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1"],
      children: "promote",
      expected_sync_token: syncToken,
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const tree = result.item as Record<string, unknown>;
    const children = tree.children as Record<string, unknown>[];

    // Root should have [n1a, n1b, n2, n3].
    expect(children).toHaveLength(4);
    expect(children[0].item_id).toBe("n1a");
    expect(children[1].item_id).toBe("n1b");
  });

  // ─── Validation and error cases ────────────────────────────────────

  test("cannot delete root node", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["root"],
      expected_sync_token: "zzzzz",
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

    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "custom_root_doc",
      item_ids: ["my_root"],
      expected_sync_token: makeSyncToken("custom_root_doc", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("root node mixed into bulk array fails entire batch", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "root"],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("InvalidInput");

    // Verify n1 was NOT deleted.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeDefined();
  });

  test("nonexistent file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "nonexistent",
      item_ids: ["n1"],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("NotFound");
  });

  test("nonexistent item_id returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["nonexistent"],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent item_id with children: 'delete' returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["nonexistent"],
      children: "delete",
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent item_id mixed with valid ones fails entire batch", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "nonexistent"],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("NodeNotFound");

    // Verify n1 was NOT deleted (no partial application).
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeDefined();
  });

  test("empty item_ids array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: [],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("duplicate item_id in array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "n1"],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("children: promote with multiple nodes returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1", "n2"],
      children: "promote",
      expected_sync_token: "zzzzz",
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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n1a"],
      expected_sync_token: syncToken,
    });
    expect(result.file_id).toBe("doc1");
    expect(typeof result.deleted_count).toBe("number");
  });

  test("response includes promoted_children when children were promoted", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      item_ids: ["n2"],
      children: "promote",
      expected_sync_token: syncToken,
    });
    expect(result.file_id).toBe("doc1");
    expect(result.deleted_count).toBe(1);
    expect(result.promoted_children).toBe(1);
  });
});

// ─── move_items ──────────────────────────────────────────────────────

describe("move_items", () => {
  // ─── Single-move behavior (one-element array) ─────────────────────

  test("first_child: moves node as first child of reference", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n2a", reference_item_id: "n1", position: "first_child" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![0]).toBe("n2a");
  });

  test("last_child: moves node as last child of reference", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n2a", reference_item_id: "n1", position: "last_child" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![n1.children!.length - 1]).toBe("n2a");
  });

  test("after: moves node as sibling after reference", async () => {
    // Move n3 to be after n1 (under root).
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n3", reference_item_id: "n1", position: "after" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children!.indexOf("n1");
    expect(root.children![n1Index + 1]).toBe("n3");
  });

  test("before: moves node as sibling before reference", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n3", reference_item_id: "n1", position: "before" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children!.indexOf("n1");
    expect(root.children![n1Index - 1]).toBe("n3");
  });

  // ─── State round-trip: move then read ─────────────────────────────

  test("state round-trip: move then verify via read_document", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1a", reference_item_id: "n2", position: "last_child" }],
      expected_sync_token: syncToken,
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const tree = result.item as Record<string, unknown>;
    const children = tree.children as Record<string, unknown>[];
    const n2 = children.find((c) => c.item_id === "n2")!;
    const n2Children = n2.children as Record<string, unknown>[];
    const movedNode = n2Children.find((c) => c.item_id === "n1a");
    expect(movedNode).toBeDefined();
    expect(movedNode!.content).toBe("Child A");
  });

  // ─── Position verification ────────────────────────────────────────

  test("first_child: moved node is at index 0 of reference's children", async () => {
    // n1 already has children [n1a, n1b]. Move n3 as first child of n1.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n3", reference_item_id: "n1", position: "first_child" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![0]).toBe("n3");
  });

  test("last_child: moved node is at last index of reference's children", async () => {
    // n1 already has children [n1a, n1b]. Move n3 as last child of n1.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n3", reference_item_id: "n1", position: "last_child" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children![n1.children!.length - 1]).toBe("n3");
  });

  test("after: moved node is at index immediately after reference", async () => {
    // Root children are [n1, n2, n3]. Move n3 after n1.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n3", reference_item_id: "n1", position: "after" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Idx = root.children!.indexOf("n1");
    const n3Idx = root.children!.indexOf("n3");
    expect(n3Idx).toBe(n1Idx + 1);
  });

  test("before: moved node is at index immediately before reference", async () => {
    // Root children are [n1, n2, n3]. Move n3 before n2.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n3", reference_item_id: "n2", position: "before" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n2Idx = root.children!.indexOf("n2");
    const n3Idx = root.children!.indexOf("n3");
    expect(n3Idx).toBe(n2Idx - 1);
  });

  test("move with children: entire subtree moves together", async () => {
    // Move n1 (which has children n1a, n1b) as last child of n2.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n2", position: "last_child" }],
      expected_sync_token: syncToken,
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

    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n1a1", position: "first_child" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node to be child of its own direct child", async () => {
    // n1 -> [n1a, n1b]. Moving n1 into n1a should fail.
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n1a", position: "first_child" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node 'after' one of its own descendants", async () => {
    // n1 -> [n1a, n1b]. Moving n1 to after n1a would resolve n1a's parent
    // (which is n1 itself), creating a circular move.
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n1a", position: "after" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node 'before' one of its own descendants", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n1b", position: "before" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("self-reference with after position is rejected", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n1", position: "after" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("self-reference with before position is rejected", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n1", position: "before" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("self-reference with first_child position is rejected", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n1", position: "first_child" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move root node (literal 'root' ID)", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "root", reference_item_id: "n1", position: "after" }],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("root item");
  });

  test("cannot move root node by actual root node ID (non-literal)", async () => {
    // Exercises the findRootNodeId check inside the version guard.
    ctx.server.addDocument("custom_root_doc", "Custom Root", "folder_a", [
      ctx.server.makeNode("my_root", "Custom Root", ["cr1"]),
      ctx.server.makeNode("cr1", "Child", []),
    ]);

    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "custom_root_doc",
      moves: [{ item_id: "my_root", reference_item_id: "cr1", position: "after" }],
      expected_sync_token: makeSyncToken("custom_root_doc", 1),
    });
    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("root item");
  });

  test("root node mixed into bulk moves fails entire batch", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n1", reference_item_id: "n2", position: "after" },
        { item_id: "root", reference_item_id: "n1", position: "first_child" },
      ],
      expected_sync_token: syncToken,
    });
    expect(err.error).toBe("InvalidInput");

    // Verify n1 was NOT moved (entire batch rejected).
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children![0]).toBe("n1");
  });

  // ─── Sibling reordering ───────────────────────────────────────────

  test("reorder sibling: move node before its own sibling", async () => {
    // Root children are [n1, n2, n3]. Move n3 before n1.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n3", reference_item_id: "n1", position: "before" }],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n3", position: "before" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["n2", "n1", "n3"]);
  });

  test("reorder sibling: move node after its own sibling", async () => {
    // Root children are [n1, n2, n3]. Move n1 after n3.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "n3", position: "after" }],
      expected_sync_token: syncToken,
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;

    // n1 should now come after n3.
    const n1Idx = root.children!.indexOf("n1");
    const n3Idx = root.children!.indexOf("n3");
    expect(n1Idx).toBeGreaterThan(n3Idx);
  });

  // ─── Response shape ───────────────────────────────────────────────

  test("response includes file_id, moved_count, and item_ids", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n3", reference_item_id: "n1", position: "first_child" }],
      expected_sync_token: syncToken,
    });
    expect(result.file_id).toBe("doc1");
    expect(result.moved_count).toBe(1);
    expect(result.item_ids).toEqual(["n3"]);
  });

  test("response shape for multi-move", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n1a", reference_item_id: "n3", position: "last_child" },
        { item_id: "n1b", reference_item_id: "n3", position: "last_child" },
      ],
      expected_sync_token: syncToken,
    });
    expect(result.file_id).toBe("doc1");
    expect(result.moved_count).toBe(2);
    expect(result.item_ids).toEqual(["n1a", "n1b"]);
  });

  // ─── Nonexistent node validation ──────────────────────────────────

  test("nonexistent item_id returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "nonexistent", reference_item_id: "n1", position: "after" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent reference_item_id with first_child returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "nonexistent", position: "first_child" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent reference_item_id with after returns NodeNotFound", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [{ item_id: "n1", reference_item_id: "nonexistent", position: "after" }],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("NodeNotFound");
  });

  test("nonexistent file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "nonexistent",
      moves: [{ item_id: "n1", reference_item_id: "n2", position: "after" }],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("NotFound");
  });

  // ─── Empty moves array ────────────────────────────────────────────

  test("empty moves array returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [],
      expected_sync_token: "zzzzz",
    });
    expect(err.error).toBe("InvalidInput");
  });

  // ─── Bulk move behavior ───────────────────────────────────────────

  test("bulk: move two nodes to be children of a different parent", async () => {
    // Root children are [n1, n2, n3]. Move n1a and n1b as last_child of n3.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n1a", reference_item_id: "n3", position: "last_child" },
        { item_id: "n1b", reference_item_id: "n3", position: "last_child" },
      ],
      expected_sync_token: syncToken,
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

    const syncToken = await getSyncToken(ctx.mcpClient, "lc_doc");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "lc_doc",
      moves: [
        { item_id: "a", reference_item_id: "target", position: "last_child" },
        { item_id: "b", reference_item_id: "target", position: "last_child" },
        { item_id: "c", reference_item_id: "target", position: "last_child" },
      ],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "dep_doc");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "dep_doc",
      moves: [
        { item_id: "c", reference_item_id: "a", position: "after" },
        { item_id: "d", reference_item_id: "c", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("dep_doc")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["a", "c", "d", "b"]);
  });

  test("bulk: reverse a list of 3 siblings", async () => {
    // Root children are [n1, n2, n3]. Reverse to [n3, n2, n1].
    // Strategy: move n3 before n1, then move n2 after n3.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n3", reference_item_id: "n1", position: "before" },
        { item_id: "n2", reference_item_id: "n3", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["n3", "n2", "n1"]);
  });

  test("bulk: cross-parent moves (from different parents to the same target)", async () => {
    // n1 -> [n1a, n1b], n2 -> [n2a]. Move n1a and n2a as children of n3.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n1a", reference_item_id: "n3", position: "last_child" },
        { item_id: "n2a", reference_item_id: "n3", position: "last_child" },
      ],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n3", reference_item_id: "n1", position: "first_child" },
        { item_id: "n3", reference_item_id: "n2", position: "last_child" },
      ],
      expected_sync_token: syncToken,
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
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n1a", reference_item_id: "n2", position: "last_child" },
        { item_id: "n2", reference_item_id: "n1a", position: "first_child" },
      ],
      expected_sync_token: makeSyncToken("doc1", 1),
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("bulk: moving to/from root level", async () => {
    // Move n1a (child of n1) to root level after n3, then move n3 under n1.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n1a", reference_item_id: "n3", position: "after" },
        { item_id: "n3", reference_item_id: "n1", position: "first_child" },
      ],
      expected_sync_token: syncToken,
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
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n1a", reference_item_id: "n3", position: "first_child" },
        { item_id: "n1b", reference_item_id: "n3", position: "last_child" },
      ],
      expected_sync_token: syncToken,
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
      max_depth: 10,
    });
    const tree = result.item as Record<string, unknown>;
    const children = tree.children as Record<string, unknown>[];
    const n3 = children.find((c) => c.item_id === "n3")!;
    const n3Children = n3.children as Record<string, unknown>[];
    expect(n3Children).toHaveLength(2);
    expect(n3Children[0].item_id).toBe("n1a");
    expect(n3Children[1].item_id).toBe("n1b");
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
    const syncToken = await getSyncToken(ctx.mcpClient, "rev_doc");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "rev_doc",
      moves: [
        { item_id: "d", reference_item_id: "a", position: "before" },
        { item_id: "c", reference_item_id: "d", position: "after" },
        { item_id: "b", reference_item_id: "c", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("rev_doc")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["d", "c", "b", "a"]);
  });

  test("bulk: move nodes from nested positions to flat list", async () => {
    // n1 -> [n1a, n1b], n2 -> [n2a].
    // Flatten: move n1a, n1b, n2a all to root level after n3.
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      moves: [
        { item_id: "n1a", reference_item_id: "n3", position: "after" },
        { item_id: "n1b", reference_item_id: "n1a", position: "after" },
        { item_id: "n2a", reference_item_id: "n1b", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["n1", "n2", "n3", "n1a", "n1b", "n2a"]);
  });

  // ─── Batch index compensation (B1) ──────────────────────────────

  test("batch index: move node forward then move another within same parent", async () => {
    // Setup: parent -> [a, b, c, d, e].
    // Move c (index 2) to after d (lands at index 4 conceptually).
    // Then move b within the same parent to after e.
    // Expected final: [a, d, c, e, b].
    ctx.server.addDocument("idx_doc1", "Index Test 1", "folder_a", [
      ctx.server.makeNode("root", "Index Test 1", ["a", "b", "c", "d", "e"]),
      ctx.server.makeNode("a", "A", []),
      ctx.server.makeNode("b", "B", []),
      ctx.server.makeNode("c", "C", []),
      ctx.server.makeNode("d", "D", []),
      ctx.server.makeNode("e", "E", []),
    ]);

    const syncToken = await getSyncToken(ctx.mcpClient, "idx_doc1");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "idx_doc1",
      moves: [
        { item_id: "c", reference_item_id: "d", position: "after" },
        { item_id: "b", reference_item_id: "e", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("idx_doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["a", "d", "c", "e", "b"]);
  });

  test("batch index: three sequential moves targeting the same parent", async () => {
    // Setup: parent -> [a, b, c, d, e].
    // Move e before b, then move d before c, then move a after e.
    // Step 1: e before b -> [a, e, b, c, d].
    // Step 2: d before c -> [a, e, b, d, c].
    // Step 3: a after e -> [e, a, b, d, c].
    ctx.server.addDocument("idx_doc2", "Index Test 2", "folder_a", [
      ctx.server.makeNode("root", "Index Test 2", ["a", "b", "c", "d", "e"]),
      ctx.server.makeNode("a", "A", []),
      ctx.server.makeNode("b", "B", []),
      ctx.server.makeNode("c", "C", []),
      ctx.server.makeNode("d", "D", []),
      ctx.server.makeNode("e", "E", []),
    ]);

    const syncToken = await getSyncToken(ctx.mcpClient, "idx_doc2");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "idx_doc2",
      moves: [
        { item_id: "e", reference_item_id: "b", position: "before" },
        { item_id: "d", reference_item_id: "c", position: "before" },
        { item_id: "a", reference_item_id: "e", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("idx_doc2")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["e", "a", "b", "d", "c"]);
  });

  test("batch index: move node to later position then fill vacated slot", async () => {
    // Setup: parent -> [a, b, c, d].
    // Move a to after d (a goes to end), then move c to first_child of root
    // (c fills the front).
    // Step 1: a after d -> [b, c, d, a].
    // Step 2: c first_child -> [c, b, d, a].
    ctx.server.addDocument("idx_doc3", "Index Test 3", "folder_a", [
      ctx.server.makeNode("root", "Index Test 3", ["a", "b", "c", "d"]),
      ctx.server.makeNode("a", "A", []),
      ctx.server.makeNode("b", "B", []),
      ctx.server.makeNode("c", "C", []),
      ctx.server.makeNode("d", "D", []),
    ]);

    const syncToken = await getSyncToken(ctx.mcpClient, "idx_doc3");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "idx_doc3",
      moves: [
        { item_id: "a", reference_item_id: "d", position: "after" },
        { item_id: "c", reference_item_id: "root", position: "first_child" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("idx_doc3")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["c", "b", "d", "a"]);
  });

  test("batch index: cascading index shifts from multiple within-parent moves", async () => {
    // Setup: parent -> [a, b, c, d, e, f].
    // Move a after f, move b after f, move c after f.
    // Each move shifts the remaining nodes and the "after f" index changes.
    // Step 1: a after f -> [b, c, d, e, f, a].
    // Step 2: b after f -> [c, d, e, f, b, a].
    // Step 3: c after f -> [d, e, f, c, b, a].
    ctx.server.addDocument("idx_doc4", "Index Test 4", "folder_a", [
      ctx.server.makeNode("root", "Index Test 4", ["a", "b", "c", "d", "e", "f"]),
      ctx.server.makeNode("a", "A", []),
      ctx.server.makeNode("b", "B", []),
      ctx.server.makeNode("c", "C", []),
      ctx.server.makeNode("d", "D", []),
      ctx.server.makeNode("e", "E", []),
      ctx.server.makeNode("f", "F", []),
    ]);

    const syncToken = await getSyncToken(ctx.mcpClient, "idx_doc4");
    await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "idx_doc4",
      moves: [
        { item_id: "a", reference_item_id: "f", position: "after" },
        { item_id: "b", reference_item_id: "f", position: "after" },
        { item_id: "c", reference_item_id: "f", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = ctx.server.documents.get("idx_doc4")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual(["d", "e", "f", "c", "b", "a"]);
  });
});

// ─── move_items cross-parent sequential moves ─────────────────────────

describe("move_items cross-parent sequential moves", () => {
  let xpCtx: TestContext;

  beforeEach(async () => {
    xpCtx = await createTestContext((server) => {
      // Build a tree with multiple parents and children to test
      // cross-parent sequential moves.
      //
      // root -> [p1, p2, p3]
      // p1 -> [a, b]
      // p2 -> [c, d]
      // p3 -> [e]
      server.addDocument("xp_doc", "Cross Parent Doc", "root_folder", [
        server.makeNode("root", "Cross Parent Doc", ["p1", "p2", "p3"]),
        server.makeNode("p1", "Parent 1", ["a", "b"]),
        server.makeNode("a", "A", []),
        server.makeNode("b", "B", []),
        server.makeNode("p2", "Parent 2", ["c", "d"]),
        server.makeNode("c", "C", []),
        server.makeNode("d", "D", []),
        server.makeNode("p3", "Parent 3", ["e"]),
        server.makeNode("e", "E", []),
      ]);
    });
  });

  afterEach(async () => {
    await xpCtx.cleanup();
  });

  test("sequential moves between different parents", async () => {
    // Move 'a' from p1 to p2, then move 'e' from p3 to p1.
    // The second move must see that p1 lost 'a' from the first move.
    const syncToken = await getSyncToken(xpCtx.mcpClient, "xp_doc");
    await callToolOk(xpCtx.mcpClient, "move_items", {
      file_id: "xp_doc",
      moves: [
        { item_id: "a", reference_item_id: "p2", position: "first_child" },
        { item_id: "e", reference_item_id: "p1", position: "first_child" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = xpCtx.server.documents.get("xp_doc")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;
    const p2 = doc.nodes.find((n) => n.id === "p2")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;

    // p1 should have [e, b] (e at first, b remained).
    expect(p1.children).toEqual(["e", "b"]);
    // p2 should have [a, c, d] (a at first, c and d remained).
    expect(p2.children).toEqual(["a", "c", "d"]);
    // p3 should be empty.
    expect(p3.children).toEqual([]);
  });

  test("chain of cross-parent moves where each move changes the reference context", async () => {
    // Move 'c' from p2 as last_child of p1.
    // Move 'd' from p2 as last_child of p3.
    // Move 'a' from p1 after 'c' in p1.
    // After move 1: p1=[a,b,c], p2=[d], p3=[e].
    // After move 2: p1=[a,b,c], p2=[], p3=[e,d].
    // After move 3: p1=[b,c,a], p2=[], p3=[e,d].
    const syncToken = await getSyncToken(xpCtx.mcpClient, "xp_doc");
    await callToolOk(xpCtx.mcpClient, "move_items", {
      file_id: "xp_doc",
      moves: [
        { item_id: "c", reference_item_id: "p1", position: "last_child" },
        { item_id: "d", reference_item_id: "p3", position: "last_child" },
        { item_id: "a", reference_item_id: "c", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = xpCtx.server.documents.get("xp_doc")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;
    const p2 = doc.nodes.find((n) => n.id === "p2")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;

    expect(p1.children).toEqual(["b", "c", "a"]);
    expect(p2.children).toEqual([]);
    expect(p3.children).toEqual(["e", "d"]);
  });

  test("later move uses reference node that was relocated by earlier move", async () => {
    // Move 'a' as first_child of p3 (a goes from p1 to p3).
    // Move 'e' after 'a' (reference is 'a', which is now in p3).
    // The second move should place 'e' after 'a' within p3 (not the old parent).
    const syncToken = await getSyncToken(xpCtx.mcpClient, "xp_doc");
    await callToolOk(xpCtx.mcpClient, "move_items", {
      file_id: "xp_doc",
      moves: [
        { item_id: "a", reference_item_id: "p3", position: "first_child" },
        { item_id: "e", reference_item_id: "a", position: "after" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = xpCtx.server.documents.get("xp_doc")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;

    // p3 should have [a, e]: 'a' was moved to first_child of p3, then 'e' was
    // moved to after 'a' (which is now in p3). 'e' was originally already in p3.
    expect(p3.children).toEqual(["a", "e"]);
    // p1 should only have 'b' remaining.
    expect(p1.children).toEqual(["b"]);
  });

  test("move empties one parent then moves into the empty parent", async () => {
    // Move 'e' out of p3 to p1, then move 'b' into (now empty) p3.
    const syncToken = await getSyncToken(xpCtx.mcpClient, "xp_doc");
    await callToolOk(xpCtx.mcpClient, "move_items", {
      file_id: "xp_doc",
      moves: [
        { item_id: "e", reference_item_id: "p1", position: "last_child" },
        { item_id: "b", reference_item_id: "p3", position: "first_child" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = xpCtx.server.documents.get("xp_doc")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;

    // p1 lost 'b' (moved to p3), gained 'e'. So p1=[a, e].
    expect(p1.children).toEqual(["a", "e"]);
    // p3 lost 'e', gained 'b'. So p3=[b].
    expect(p3.children).toEqual(["b"]);
  });

  test("three-way swap across parents", async () => {
    // Swap nodes across three parents in sequence:
    // Move 'a' from p1 to first_child of p2.
    // Move 'c' from p2 to first_child of p3.
    // Move 'e' from p3 to first_child of p1.
    //
    // Starting: p1=[a,b], p2=[c,d], p3=[e].
    // After move 1: p1=[b], p2=[a,c,d], p3=[e].
    // After move 2: p1=[b], p2=[a,d], p3=[c,e].
    // After move 3: p1=[e,b], p2=[a,d], p3=[c].
    const syncToken = await getSyncToken(xpCtx.mcpClient, "xp_doc");
    await callToolOk(xpCtx.mcpClient, "move_items", {
      file_id: "xp_doc",
      moves: [
        { item_id: "a", reference_item_id: "p2", position: "first_child" },
        { item_id: "c", reference_item_id: "p3", position: "first_child" },
        { item_id: "e", reference_item_id: "p1", position: "first_child" },
      ],
      expected_sync_token: syncToken,
    });

    const doc = xpCtx.server.documents.get("xp_doc")!;
    const p1 = doc.nodes.find((n) => n.id === "p1")!;
    const p2 = doc.nodes.find((n) => n.id === "p2")!;
    const p3 = doc.nodes.find((n) => n.id === "p3")!;

    expect(p1.children).toEqual(["e", "b"]);
    expect(p2.children).toEqual(["a", "d"]);
    expect(p3.children).toEqual(["c"]);
  });
});
