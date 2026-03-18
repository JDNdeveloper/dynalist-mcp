/**
 * TOCTOU race detection tests. Verifies that concurrent edits occurring
 * between the version guard's pre-check and the planning read inside the
 * guarded function are reliably detected via sync_warning.
 *
 * Uses the onNextRead hook to inject concurrent edits at the precise
 * point where the TOCTOU window exists.
 */

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

// ═════════════════════════════════════════════════════════════════════
// TOCTOU race detection: move_items
// ═════════════════════════════════════════════════════════════════════
describe("move_items TOCTOU", () => {
  test("concurrent edit during planning read emits warning", async () => {
    const syncToken = makeSyncToken("doc1", ctx.server.documents.get("doc1")!.version);
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      moves: [{ item_id: "n1a", reference_item_id: "n2", position: "after" }],
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.item_ids).toEqual(["n1a"]);
  });

  test("no concurrent edit has no sync_warning", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      moves: [{ item_id: "n1a", reference_item_id: "n2", position: "after" }],
    });

    expect(result.sync_warning).toBeUndefined();
  });

  test("NodeNotFound inside guard returns proper error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      expected_sync_token: makeSyncToken("doc1", 1),
      moves: [{ item_id: "nonexistent", reference_item_id: "n2", position: "after" }],
    });

    expect(err.error).toBe("NodeNotFound");
  });

  test("cycle detection inside guard returns proper error", async () => {
    const err = await callToolError(ctx.mcpClient, "move_items", {
      file_id: "doc1",
      expected_sync_token: makeSyncToken("doc1", 1),
      moves: [{ item_id: "n1", reference_item_id: "n1a", position: "last_child" }],
    });

    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("descendants");
  });
});

// ═════════════════════════════════════════════════════════════════════
// TOCTOU race detection: delete_items
// ═════════════════════════════════════════════════════════════════════
describe("delete_items TOCTOU", () => {
  test("with children: concurrent edit during planning read emits warning", async () => {
    const syncToken = makeSyncToken("doc1", ctx.server.documents.get("doc1")!.version);
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      item_ids: ["n1"],
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.deleted_count).toBeGreaterThan(0);
  });

  test("promote children: concurrent edit during planning read emits warning", async () => {
    const syncToken = makeSyncToken("doc1", ctx.server.documents.get("doc1")!.version);
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      item_ids: ["n1"],
      children: "promote",
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.promoted_children).toBe(2);
  });

  test("no concurrent edit has no sync_warning", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      item_ids: ["n1a"],
    });

    expect(result.sync_warning).toBeUndefined();
  });

  test("cannot delete root inside guard returns proper error", async () => {
    const err = await callToolError(ctx.mcpClient, "delete_items", {
      file_id: "doc1",
      expected_sync_token: makeSyncToken("doc1", 1),
      item_ids: ["root"],
    });

    expect(err.error).toBe("InvalidInput");
    expect(err.message).toContain("root");
  });
});

// ═════════════════════════════════════════════════════════════════════
// TOCTOU race detection: insert_items
// ═════════════════════════════════════════════════════════════════════
describe("insert_items TOCTOU", () => {
  test("after sibling: concurrent edit during planning read emits warning", async () => {
    const syncToken = makeSyncToken("doc1", ctx.server.documents.get("doc1")!.version);
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      items: [{ content: "After n1" }],
      position: "after",
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.total_created).toBe(1);
  });

  test("last_child multiple items: concurrent edit during planning read emits warning", async () => {
    const syncToken = makeSyncToken("doc1", ctx.server.documents.get("doc1")!.version);
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "root",
      items: [{ content: "A" }, { content: "B" }, { content: "C" }],
      position: "last_child",
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.total_created).toBe(3);
  });

  test("root resolution: concurrent edit during planning read emits warning", async () => {
    const syncToken = makeSyncToken("doc1", ctx.server.documents.get("doc1")!.version);
    ctx.server.onNextRead((fileId) => {
      ctx.server.simulateConcurrentEdit(fileId);
    });

    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      items: [{ content: "Root child" }],
      position: "last_child",
    });

    expect(result.sync_warning).toBeDefined();
    expect(result.total_created).toBe(1);
  });

  test("no concurrent edit has no sync_warning", async () => {
    const syncToken = await getSyncToken(ctx.mcpClient, "doc1");
    const result = await callToolOk(ctx.mcpClient, "insert_items", {
      file_id: "doc1",
      expected_sync_token: syncToken,
      reference_item_id: "n1",
      items: [{ content: "New child" }],
      position: "last_child",
    });

    expect(result.sync_warning).toBeUndefined();
  });
});
