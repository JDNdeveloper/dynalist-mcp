/**
 * TOCTOU race detection tests. Verifies that concurrent edits occurring
 * between the version guard's pre-check and the planning read inside the
 * guarded function are reliably detected via version_warning.
 *
 * Uses the onNextRead hook to inject concurrent edits at the precise
 * point where the TOCTOU window exists.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  callToolOk,
  callToolError,
  getVersion,
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
// TOCTOU race detection: move_nodes
// ═════════════════════════════════════════════════════════════════════
describe("move_nodes TOCTOU", () => {
  test("concurrent edit during planning read emits warning", async () => {
    const version = ctx.server.documents.get("doc1")!.version;
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      expected_version: version,
      moves: [{ node_id: "n1a", reference_node_id: "n2", position: "after" }],
    });

    expect(result.version_warning).toBeDefined();
    expect(result.node_ids).toEqual(["n1a"]);
  });

  test("no concurrent edit has no version_warning", async () => {
    const version = await getVersion(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      expected_version: version,
      moves: [{ node_id: "n1a", reference_node_id: "n2", position: "after" }],
    });

    expect(result.version_warning).toBeUndefined();
  });

  test("NodeNotFound inside guard returns proper error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      expected_version: 1,
      moves: [{ node_id: "nonexistent", reference_node_id: "n2", position: "after" }],
    });

    expect(err.error).toBe("NodeNotFound");
  });

  test("cycle detection inside guard returns proper error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_nodes", {
      file_id: "doc1",
      expected_version: 1,
      moves: [{ node_id: "n1", reference_node_id: "n1a", position: "last_child" }],
    });

    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("descendants");
  });
});

// ═════════════════════════════════════════════════════════════════════
// TOCTOU race detection: delete_nodes
// ═════════════════════════════════════════════════════════════════════
describe("delete_nodes TOCTOU", () => {
  test("with children: concurrent edit during planning read emits warning", async () => {
    const version = ctx.server.documents.get("doc1")!.version;
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      expected_version: version,
      node_ids: ["n1"],
    });

    expect(result.version_warning).toBeDefined();
    expect(result.deleted_count).toBeGreaterThan(0);
  });

  test("promote children: concurrent edit during planning read emits warning", async () => {
    const version = ctx.server.documents.get("doc1")!.version;
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      expected_version: version,
      node_ids: ["n1"],
      include_children: false,
    });

    expect(result.version_warning).toBeDefined();
    expect(result.promoted_children).toBe(2);
  });

  test("no concurrent edit has no version_warning", async () => {
    const version = await getVersion(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      expected_version: version,
      node_ids: ["n1a"],
    });

    expect(result.version_warning).toBeUndefined();
  });

  test("cannot delete root inside guard returns proper error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_nodes", {
      file_id: "doc1",
      expected_version: 1,
      node_ids: ["root"],
    });

    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("root");
  });
});

// ═════════════════════════════════════════════════════════════════════
// TOCTOU race detection: insert_nodes
// ═════════════════════════════════════════════════════════════════════
describe("insert_nodes TOCTOU", () => {
  test("after sibling: concurrent edit during planning read emits warning", async () => {
    const version = ctx.server.documents.get("doc1")!.version;
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      expected_version: version,
      reference_node_id: "n1",
      nodes: [{ content: "After n1" }],
      position: "after",
    });

    expect(result.version_warning).toBeDefined();
    expect(result.total_created).toBe(1);
  });

  test("as_last_child multiple items: concurrent edit during planning read emits warning", async () => {
    const version = ctx.server.documents.get("doc1")!.version;
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      expected_version: version,
      node_id: "root",
      nodes: [{ content: "A" }, { content: "B" }, { content: "C" }],
    });

    expect(result.version_warning).toBeDefined();
    expect(result.total_created).toBe(3);
  });

  test("root resolution: concurrent edit during planning read emits warning", async () => {
    const version = ctx.server.documents.get("doc1")!.version;
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      expected_version: version,
      nodes: [{ content: "Root child" }],
    });

    expect(result.version_warning).toBeDefined();
    expect(result.total_created).toBe(1);
  });

  test("no concurrent edit has no version_warning", async () => {
    const version = await getVersion(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_nodes", {
      file_id: "doc1",
      expected_version: version,
      node_id: "n1",
      nodes: [{ content: "New child" }],
    });

    expect(result.version_warning).toBeUndefined();
  });
});
