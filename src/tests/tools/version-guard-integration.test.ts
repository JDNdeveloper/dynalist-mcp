/**
 * Integration tests for version guard wiring. Verifies that every write
 * tool passes through the version guard correctly, and that post-write
 * concurrent modification detection works.
 */

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

// ═════════════════════════════════════════════════════════════════════
// edit_nodes version guard wiring
// ═════════════════════════════════════════════════════════════════════
describe("edit_nodes version guard", () => {
  test("stale expected_version aborts with VersionMismatch", async () => {
    const err = await callToolError(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated",
      expected_version: 999,
    });
    expect(err.error).toBe("VersionMismatch");

    // Verify the node was not modified.
    const doc = ctx.server.documents.get("doc1")!;
    const node = doc.nodes.find(n => n.id === "n1")!;
    expect(node.content).toBe("First item");
  });

  test("correct expected_version succeeds", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const version = doc.version;

    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated",
      expected_version: version,
    });
    expect(result.node_id).toBe("n1");
    expect(result.version_warning).toBeUndefined();
  });

  test("omitted expected_version succeeds without abort", async () => {
    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated",
    });
    expect(result.node_id).toBe("n1");
    expect(result.version_warning).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// insert_nodes version guard wiring
// ═════════════════════════════════════════════════════════════════════
describe("insert_nodes version guard", () => {
  test("stale expected_version aborts with VersionMismatch", async () => {
    const err = await callToolError(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{ content: "New child" }],
      expected_version: 999,
    });
    expect(err.error).toBe("VersionMismatch");

    // Verify no nodes were created.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find(n => n.id === "n1")!;
    expect(n1.children).toEqual(["n1a", "n1b"]);
  });

  test("correct expected_version succeeds", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const version = doc.version;

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{ content: "New child" }],
      expected_version: version,
    });
    expect(result.total_created).toBe(1);
    expect(result.version_warning).toBeUndefined();
  });

  test("omitted expected_version succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{ content: "New child" }],
    });
    expect(result.total_created).toBe(1);
    expect(result.version_warning).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// delete_node version guard wiring
// ═════════════════════════════════════════════════════════════════════
describe("delete_node version guard", () => {
  test("stale expected_version aborts with VersionMismatch", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1a",
      expected_version: 999,
    });
    expect(err.error).toBe("VersionMismatch");

    // Verify node was not deleted.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.some(n => n.id === "n1a")).toBe(true);
  });

  test("correct expected_version succeeds", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const version = doc.version;

    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1a",
      expected_version: version,
    });
    expect(result.deleted_count).toBe(1);
    expect(result.version_warning).toBeUndefined();
  });

  test("omitted expected_version succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1a",
    });
    expect(result.deleted_count).toBe(1);
    expect(result.version_warning).toBeUndefined();
  });

  test("stale expected_version aborts child promotion path", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
      include_children: false,
      expected_version: 999,
    });
    expect(err.error).toBe("VersionMismatch");

    // Verify node was not deleted.
    const doc = ctx.server.documents.get("doc1")!;
    expect(doc.nodes.some(n => n.id === "n1")).toBe(true);
  });

  test("correct expected_version succeeds for child promotion", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const version = doc.version;

    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
      include_children: false,
      expected_version: version,
    });
    expect(result.deleted_count).toBe(1);
    expect(result.promoted_children).toBe(2);
    expect(result.version_warning).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// move_node version guard wiring
// ═════════════════════════════════════════════════════════════════════
describe("move_node version guard", () => {
  test("stale expected_version aborts with VersionMismatch", async () => {
    const err = await callToolError(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1a",
      reference_node_id: "n2",
      position: "last_child",
      expected_version: 999,
    });
    expect(err.error).toBe("VersionMismatch");

    // Verify node was not moved.
    const doc = ctx.server.documents.get("doc1")!;
    const n1 = doc.nodes.find(n => n.id === "n1")!;
    expect(n1.children).toContain("n1a");
  });

  test("correct expected_version succeeds", async () => {
    const doc = ctx.server.documents.get("doc1")!;
    const version = doc.version;

    const result = await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1a",
      reference_node_id: "n2",
      position: "last_child",
      expected_version: version,
    });
    expect(result.node_id).toBe("n1a");
    expect(result.version_warning).toBeUndefined();
  });

  test("omitted expected_version succeeds", async () => {
    const result = await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1a",
      reference_node_id: "n2",
      position: "last_child",
    });
    expect(result.node_id).toBe("n1a");
    expect(result.version_warning).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// Post-write concurrent modification detection
// ═════════════════════════════════════════════════════════════════════
describe("post-write concurrent modification detection", () => {
  test("clean write has no version_warning", async () => {
    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated",
    });
    expect(result.version_warning).toBeUndefined();
  });

  test("concurrent edit during write produces version_warning", async () => {
    // Hook: simulate concurrent edit when editDocument is called.
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated",
    });

    expect(result.version_warning).toBeDefined();
    expect(result.version_warning).toContain("advanced by 2");
    expect(result.version_warning).toContain("expected 1");
  });

  test("concurrent edit during insert produces version_warning", async () => {
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      node_id: "n1",
      nodes: [{ content: "New" }],
    });

    expect(result.version_warning).toBeDefined();
    expect(result.version_warning).toContain("advanced by 2");
    expect(result.version_warning).toContain("expected 1");
  });

  test("concurrent edit during delete produces version_warning", async () => {
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1a",
    });

    expect(result.version_warning).toBeDefined();
    expect(result.version_warning).toContain("advanced by 2");
    expect(result.version_warning).toContain("expected 1");
  });

  test("concurrent edit during move produces version_warning", async () => {
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "move_node", {
      file_id: "doc1",
      node_id: "n1a",
      reference_node_id: "n2",
      position: "last_child",
    });

    expect(result.version_warning).toBeDefined();
    expect(result.version_warning).toContain("advanced by 2");
    expect(result.version_warning).toContain("expected 1");
  });

  test("concurrent edit during multi-batch delete_node with child promotion", async () => {
    // delete_node with include_children: false makes 2 editDocument calls.
    // Inject a concurrent edit on the first call. Total expected delta = 2
    // (move batch + delete batch), actual delta = 3 (2 + concurrent).
    ctx.server.onNextEdit((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "delete_node", {
      file_id: "doc1",
      node_id: "n1",
      include_children: false,
    });

    expect(result.version_warning).toBeDefined();
    expect(result.version_warning).toContain("advanced by 3");
    expect(result.version_warning).toContain("expected 2");
  });
});

// ═════════════════════════════════════════════════════════════════════
// read_document version field
// ═════════════════════════════════════════════════════════════════════
describe("read_document version", () => {
  test("includes version in response", async () => {
    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    expect(result.version).toBe(1);
  });

  test("version increments after edits", async () => {
    await callToolOk(ctx.mcpClient, "edit_nodes", {
      file_id: "doc1",
      node_id: "n1",
      content: "Updated",
    });

    const result = await callToolOk(ctx.mcpClient, "read_document", {
      file_id: "doc1",
    });
    // Version 1 + 1 edit = 2.
    expect(result.version).toBe(2);
  });
});
