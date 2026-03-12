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

// ─── delete_node ─────────────────────────────────────────────────────

describe("delete_node", () => {
  test("deletes a leaf node", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1a",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.deleted_count).toBe(1);

    // Verify the node is gone.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
  });

  test("default behavior promotes children up to parent", async () => {
    // n1 has children n1a, n1b. Default (include_children: false) promotes them.
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
    });
    expect(result.deleted_count).toBe(1);

    // n1 is gone but n1a, n1b still exist.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeDefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeDefined();

    // n1a and n1b should now be children of root.
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toContain("n1a");
    expect(root.children).toContain("n1b");
  });

  test("include_children: true deletes entire subtree", async () => {
    // n1 has children n1a, n1b.
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
      include_children: true,
    });
    expect(result.deleted_count).toBe(3); // n1, n1a, n1b

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeUndefined();
  });

  test("cannot delete root node", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "root",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("nonexistent file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_node", {
      file_id: "nonexistent",
      node_id: "n1",
    });
    expect(err.error).toBe("NotFound");
  });

  // ─── 14b: Child promotion details ──────────────────────────────────

  test("promoted children appear at the deleted node's position in parent", async () => {
    // Root children are [n1, n2, n3]. Delete n1 which has children [n1a, n1b].
    // After promotion, n1a and n1b should appear at n1's former position.
    await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;

    // n1a should be at index 0, n1b at index 1, then n2, n3.
    expect(root.children[0]).toBe("n1a");
    expect(root.children[1]).toBe("n1b");
    expect(root.children).toContain("n2");
    expect(root.children).toContain("n3");
  });

  test("promoted children preserve their content", async () => {
    await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
    });

    const doc = ctx.server.documents.get("doc1")!;
    const n1a = doc.nodes.find((n) => n.id === "n1a")!;
    const n1b = doc.nodes.find((n) => n.id === "n1b")!;
    expect(n1a.content).toBe("Child A");
    expect(n1b.content).toBe("Child B");
    expect(n1b.note).toBe("A note on child B");
  });

  test("promoted_children count matches actual promoted count", async () => {
    // n1 has 2 children (n1a, n1b).
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
    });
    expect(result.promoted_children).toBe(2);
  });

  // ─── 14c: Subtree deletion details ────────────────────────────────

  test("deleted_count includes all descendants in subtree deletion", async () => {
    // n1 has children n1a and n1b, so the subtree has 3 nodes total.
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
      include_children: true,
    });
    expect(result.deleted_count).toBe(3);
  });

  test("deeply nested subtree deletion removes all levels", async () => {
    // Build a document with 4+ levels of nesting for this test.
    ctx.server.addDocument("deep_doc", "Deep Document", "folder_a", [
      ctx.server.makeNode("root", "Deep Document", ["d1"]),
      ctx.server.makeNode("d1", "Level 1", ["d2"]),
      ctx.server.makeNode("d2", "Level 2", ["d3"]),
      ctx.server.makeNode("d3", "Level 3", ["d4"]),
      ctx.server.makeNode("d4", "Level 4", []),
    ]);

    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "deep_doc",
      node_id: "d1",
      include_children: true,
    });

    // All 4 nodes should be deleted (d1, d2, d3, d4).
    expect(result.deleted_count).toBe(4);

    const doc = ctx.server.documents.get("deep_doc")!;
    expect(doc.nodes.find((n) => n.id === "d1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "d2")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "d3")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "d4")).toBeUndefined();

    // Root should have no children left.
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual([]);
  });

  test("promoted_children field absent when include_children is true", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
      include_children: true,
    });
    expect(result.promoted_children).toBeUndefined();
  });

  // ─── 14d: Edge cases ──────────────────────────────────────────────

  test("deleting root's only child leaves root with empty children", async () => {
    // doc2 has root -> [m1]. Delete m1.
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc2",
      node_id: "m1",
    });
    expect(result.deleted_count).toBe(1);

    const doc = ctx.server.documents.get("doc2")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    expect(root.children).toEqual([]);
  });

  test("rejects deletion of root by actual root node ID", async () => {
    // The standard setup uses "root" as the root node ID for doc1.
    // This test confirms it is rejected even when matched by findRootNodeId.
    const err = await callToolError(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "root",
    });
    expect(err.error).toBe("InvalidInput");
  });

  // ─── 14e: Response shape ──────────────────────────────────────────

  test("response includes file_id and deleted_count", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1a",
    });
    expect(result.file_id).toBe("doc1");
    expect(typeof result.deleted_count).toBe("number");
  });

  test("response includes promoted_children when children were promoted", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n2",
    });
    // n2 has one child (n2a), so promoted_children should be 1.
    expect(result.file_id).toBe("doc1");
    expect(result.deleted_count).toBe(1);
    expect(result.promoted_children).toBe(1);
  });
});

// ─── move_node ───────────────────────────────────────────────────────

describe("move_node", () => {
  test("first_child: moves node as first child of reference", async () => {
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n2a",
      reference_node_id: "n1",
      position: "first_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children[0]).toBe("n2a");
  });

  test("last_child: moves node as last child of reference", async () => {
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n2a",
      reference_node_id: "n1",
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children[n1.children.length - 1]).toBe("n2a");
  });

  test("after: moves node as sibling after reference", async () => {
    // Move n3 to be after n1 (under root).
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n1",
      position: "after",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children.indexOf("n1");
    expect(root.children[n1Index + 1]).toBe("n3");
  });

  test("before: moves node as sibling before reference", async () => {
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n1",
      position: "before",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Index = root.children.indexOf("n1");
    expect(root.children[n1Index - 1]).toBe("n3");
  });

  test("returns file_id, node_id, url", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n2a",
      reference_node_id: "n1",
      position: "first_child",
    });
    expect(result.file_id).toBe("doc1");
    expect(result.node_id).toBe("n2a");
    expect(result.url).toContain("doc1");
    expect(result.url).toContain("n2a");
  });

  test("cannot move node relative to itself", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n1",
      position: "first_child",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node into its own descendant", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n1a",
      position: "first_child",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("nonexistent file returns error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "nonexistent",
      node_id: "n1",
      reference_node_id: "n2",
      position: "after",
    });
    expect(err.error).toBe("NotFound");
  });

  // ─── State round-trip: move then read ────────────────────────────

  test("state round-trip: move then verify via read_document", async () => {
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1a",
      reference_node_id: "n2",
      position: "last_child",
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

  // ─── 15b: Position verification ───────────────────────────────────

  test("first_child: moved node is at index 0 of reference's children", async () => {
    // n1 already has children [n1a, n1b]. Move n3 as first child of n1.
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n1",
      position: "first_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children[0]).toBe("n3");
  });

  test("last_child: moved node is at last index of reference's children", async () => {
    // n1 already has children [n1a, n1b]. Move n3 as last child of n1.
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n1",
      position: "last_child",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find((n) => n.id === "n1")!;
    expect(n1.children[n1.children.length - 1]).toBe("n3");
  });

  test("after: moved node is at index immediately after reference", async () => {
    // Root children are [n1, n2, n3]. Move n3 after n1.
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n1",
      position: "after",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n1Idx = root.children.indexOf("n1");
    const n3Idx = root.children.indexOf("n3");
    expect(n3Idx).toBe(n1Idx + 1);
  });

  test("before: moved node is at index immediately before reference", async () => {
    // Root children are [n1, n2, n3]. Move n3 before n2.
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n2",
      position: "before",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;
    const n2Idx = root.children.indexOf("n2");
    const n3Idx = root.children.indexOf("n3");
    expect(n3Idx).toBe(n2Idx - 1);
  });

  test("move with children: entire subtree moves together", async () => {
    // Move n1 (which has children n1a, n1b) as last child of n2.
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n2",
      position: "last_child",
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

  // ─── 15c: Circular move prevention ────────────────────────────────

  test("cannot move node to be child of its own grandchild", async () => {
    // n1 -> [n1a, n1b]. Moving n1 into n1a's subtree should fail.
    // First add a child to n1a so we can try to move n1 into it.
    ctx.server.documents.get("doc1")!.nodes.push(
      ctx.server.makeNode("n1a1", "Grandchild", []),
    );
    const n1a = ctx.server.documents.get("doc1")!.nodes.find((n) => n.id === "n1a")!;
    n1a.children.push("n1a1");

    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n1a1",
      position: "first_child",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node to be child of its own direct child", async () => {
    // n1 -> [n1a, n1b]. Moving n1 into n1a should fail.
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n1a",
      position: "first_child",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node 'after' one of its own descendants", async () => {
    // n1 -> [n1a, n1b]. Moving n1 to after n1a would resolve n1a's parent
    // (which is n1 itself), creating a circular move.
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n1a",
      position: "after",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("cannot move node 'before' one of its own descendants", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n1b",
      position: "before",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("self-reference with after position is rejected", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n1",
      position: "after",
    });
    expect(err.error).toBe("InvalidInput");
  });

  test("self-reference with before position is rejected", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n1",
      position: "before",
    });
    expect(err.error).toBe("InvalidInput");
  });

  // ─── 15d: Sibling reordering ──────────────────────────────────────

  test("reorder sibling: move node before its own sibling", async () => {
    // Root children are [n1, n2, n3]. Move n3 before n1.
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n1",
      position: "before",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;

    // n3 should now come before n1.
    const n3Idx = root.children.indexOf("n3");
    const n1Idx = root.children.indexOf("n1");
    expect(n3Idx).toBeLessThan(n1Idx);
  });

  test("reorder sibling: move node after its own sibling", async () => {
    // Root children are [n1, n2, n3]. Move n1 after n3.
    await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1",
      reference_node_id: "n3",
      position: "after",
    });
    const doc = ctx.server.documents.get("doc1")!;
    const root = doc.nodes.find((n) => n.id === "root")!;

    // n1 should now come after n3.
    const n1Idx = root.children.indexOf("n1");
    const n3Idx = root.children.indexOf("n3");
    expect(n1Idx).toBeGreaterThan(n3Idx);
  });

  // ─── 15e: Response shape ──────────────────────────────────────────

  test("response includes file_id, node_id, and url", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n3",
      reference_node_id: "n1",
      position: "first_child",
    });
    expect(typeof result.file_id).toBe("string");
    expect(typeof result.node_id).toBe("string");
    expect(typeof result.url).toBe("string");
    expect(result.file_id).toBe("doc1");
    expect(result.node_id).toBe("n3");
    expect(result.url).toContain("doc1");
    expect(result.url).toContain("n3");
  });
});
