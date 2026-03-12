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

  test("deletes a node and all descendants (recursive)", async () => {
    // n1 has children n1a, n1b.
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
    });
    expect(result.deleted_count).toBe(3); // n1, n1a, n1b

    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.find((n) => n.id === "n1")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1a")).toBeUndefined();
    expect(doc.nodes.find((n) => n.id === "n1b")).toBeUndefined();
  });

  test("promote_children moves children to parent then deletes node", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
      promote_children: true,
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
    // Move n2 to be after n1 (under root). n2 is already after n1 in the
    // initial setup, so let's move n3 to be after n1 instead.
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
});
